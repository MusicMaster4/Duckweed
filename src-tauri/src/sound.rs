//! Completion cues, played by the Duckweed process itself.
//!
//! The WebView can play them too, and used to. On Windows that stream belongs
//! to `msedgewebview2.exe`, the runtime process every WebView2 app shares, so
//! Windows lists the cue in the volume mixer as "Microsoft Edge WebView2" with
//! Edge's icon. Opening the output device from this process instead puts the
//! audio session on `duckweed.exe`, which the mixer labels with the app's own
//! name and icon.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::cpal::{DeviceId, StreamError};
use rodio::mixer::Mixer;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};

/// The cues live in the binary. The copies Vite emits into `dist/` stay there
/// for the WebView fallback, which only runs when this player cannot open a
/// device, or when the frontend runs in a plain browser during development.
const CUES: [&[u8]; 6] = [
    include_bytes!("../../assets/completion_sound_A.ogg"),
    include_bytes!("../../assets/completion_sound_C.ogg"),
    include_bytes!("../../assets/completion_sound_C2.ogg"),
    include_bytes!("../../assets/completion_sound_D.ogg"),
    include_bytes!("../../assets/completion_sound_E.ogg"),
    include_bytes!("../../assets/completion_sound_G.ogg"),
];

/// How long a caller waits on the audio thread. Opening a cold output device is
/// the slow part; starting a cue on an open one takes microseconds.
const START_TIMEOUT: Duration = Duration::from_secs(5);

struct Request {
    cue: &'static [u8],
    reply: SyncSender<Result<(), String>>,
}

/// A device can stop delivering samples without changing its ID, especially
/// after sleep or a driver restart. CPAL reports that on its own callback thread.
#[derive(Default)]
struct OutputState {
    device: Option<DeviceId>,
    failed: Arc<AtomicBool>,
}

impl OutputState {
    fn reusable_for(&self, device: &Option<DeviceId>) -> bool {
        self.device == *device && !self.failed.load(Ordering::Acquire)
    }

    fn error_callback(&self) -> impl FnMut(StreamError) + Send + Clone + 'static {
        let failed = Arc::clone(&self.failed);
        move |error| {
            // An underrun is a transient glitch, not a stopped stream.
            if !matches!(error, StreamError::BufferUnderrun) {
                failed.store(true, Ordering::Release);
            }
            eprintln!("duckweed: audio output failed: {error}");
        }
    }
}

/// The open output device and the track feeding it.
struct Output {
    state: OutputState,
    player: Option<Player>,
    /// Keep the session open between cues so the mixer continues to list
    /// Duckweed. Declared last so the player stops before its device closes.
    sink: MixerDeviceSink,
}

/// Handle to the audio thread. Cheap to clone; the thread starts on first use.
#[derive(Default, Clone)]
pub struct SoundPlayer(Arc<Mutex<Option<Sender<Request>>>>);

impl SoundPlayer {
    /// Play the selected completion cue, or choose one when no index is given.
    ///
    /// Resolves once the cue has started, not once it has finished. The call
    /// blocks for as long as opening the output device takes, so it belongs on
    /// a blocking task rather than the IPC thread.
    pub fn play(&self, cue_index: Option<usize>) -> Result<(), String> {
        let cue_index = cue_index.unwrap_or_else(next_cue_index);
        let cue = CUES
            .get(cue_index)
            .copied()
            .ok_or_else(|| "unknown completion cue".to_string())?;
        let (reply, started) = mpsc::sync_channel(1);
        self.send(Request { cue, reply })?;
        started
            .recv_timeout(START_TIMEOUT)
            .unwrap_or_else(|_| Err("the audio thread did not answer".into()))
    }

    /// Hand `request` to the audio thread, starting it on first use.
    fn send(&self, request: Request) -> Result<(), String> {
        let mut worker = self.0.lock().map_err(|error| error.to_string())?;
        let mut request = request;
        // Two attempts: the first can land on a thread that has already exited.
        for _ in 0..2 {
            let sender = worker.get_or_insert_with(start_worker);
            match sender.send(request) {
                Ok(()) => return Ok(()),
                Err(mpsc::SendError(returned)) => {
                    *worker = None;
                    request = returned;
                }
            }
        }
        Err("the audio thread could not be started".into())
    }
}

fn start_worker() -> Sender<Request> {
    let (sender, requests) = mpsc::channel();
    // A thread of its own: an open device handle is not `Send`, so it has to
    // stay on the thread that created it.
    let spawned = std::thread::Builder::new()
        .name("duckweed-audio".into())
        .spawn(move || run_worker(requests));
    if let Err(error) = spawned {
        // The receiver went with the closure, so the next send reports this.
        eprintln!("duckweed: could not start the audio thread: {error}");
    }
    sender
}

fn run_worker(requests: Receiver<Request>) {
    // The device stays open between cues on purpose. The audio session, and so
    // the Duckweed entry in the volume mixer, exists exactly as long as the
    // device is open. It opens on the first cue, never before.
    let mut output: Option<Output> = None;
    while let Ok(request) = requests.recv() {
        let _ = request.reply.send(start(&mut output, request.cue));
    }
}

fn start(output: &mut Option<Output>, cue: &'static [u8]) -> Result<(), String> {
    let device = default_device_id();
    if output
        .as_ref()
        .is_some_and(|open| !open.state.reusable_for(&device))
    {
        // Reopen after a default-device change OR an asynchronous stream error.
        // Keeping a dead stream would accept cues without ever making a sound.
        *output = None;
    }
    if output.is_none() {
        let device = rodio::cpal::default_host()
            .default_output_device()
            .ok_or("no default audio output device")?;
        let state = OutputState {
            device: device.id().ok(),
            ..OutputState::default()
        };
        let mut sink = DeviceSinkBuilder::from_device(device)
            .map_err(|error| format!("could not configure an audio output: {error}"))?
            .with_error_callback(state.error_callback())
            .open_sink_or_fallback()
            .map_err(|error| format!("could not open an audio output: {error}"))?;
        sink.log_on_drop(false);
        *output = Some(Output {
            state,
            player: None,
            sink,
        });
    }
    let open = output
        .as_mut()
        .ok_or("the audio output disappeared while opening it")?;
    replace_cue(&mut open.player, open.sink.mixer(), cue)?;
    if open.state.failed.load(Ordering::Acquire) {
        // Catch errors delivered while opening/starting, so this completion
        // can use the WebView fallback instead of being reported as audible.
        *output = None;
        return Err("the audio output failed while starting a cue".into());
    }
    Ok(())
}

fn replace_cue(
    player: &mut Option<Player>,
    mixer: &Mixer,
    cue: &'static [u8],
) -> Result<(), String> {
    let source = Decoder::new(Cursor::new(cue))
        .map_err(|error| format!("could not decode a cue: {error}"))?;
    // Player::clear() waits for the device to drain its queue. If the stream
    // dies during that wait, the audio worker never answers another request.
    // Dropping the old player stops it without waiting for a device callback.
    *player = None;
    let next = Player::connect_new(mixer);
    next.append(source);
    next.play();
    *player = Some(next);
    Ok(())
}

fn default_device_id() -> Option<DeviceId> {
    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|device| device.id().ok())
}

/// Index of the next cue.
///
/// The pick only has to feel unpredictable, which a xorshift seeded from the
/// clock covers without pulling in a random-number crate.
fn next_cue_index() -> usize {
    static STATE: AtomicU64 = AtomicU64::new(0);

    let mut state = STATE.load(Ordering::Relaxed);
    if state == 0 {
        state = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos() as u64)
            .unwrap_or_default()
            // A xorshift seeded with zero only ever returns zero.
            | 1;
    }
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    STATE.store(state, Ordering::Relaxed);
    (state % CUES.len() as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_cue_gets_picked() {
        let mut seen = [false; CUES.len()];
        for _ in 0..1_000 {
            seen[next_cue_index()] = true;
        }
        assert!(seen.iter().all(|picked| *picked));
    }

    #[test]
    fn consecutive_picks_differ() {
        let picks: Vec<usize> = (0..20).map(|_| next_cue_index()).collect();
        assert!(picks.windows(2).any(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn stream_errors_invalidate_output_even_when_the_device_id_is_unchanged() {
        for error in [
            StreamError::DeviceNotAvailable,
            StreamError::StreamInvalidated,
        ] {
            let device = Some(DeviceId(
                rodio::cpal::default_host().id(),
                "speakers".into(),
            ));
            let state = OutputState {
                device: device.clone(),
                ..OutputState::default()
            };
            let mut on_error = state.error_callback();
            assert!(state.reusable_for(&device));
            on_error(error);
            assert!(!state.reusable_for(&device));
        }
    }

    #[test]
    fn changing_the_default_device_invalidates_a_healthy_output() {
        let device = Some(DeviceId(
            rodio::cpal::default_host().id(),
            "speakers".into(),
        ));
        let other = Some(DeviceId(
            rodio::cpal::default_host().id(),
            "headphones".into(),
        ));
        let state = OutputState {
            device: device.clone(),
            ..OutputState::default()
        };
        assert!(state.reusable_for(&device));
        assert!(!state.reusable_for(&other));
        assert!(!state.reusable_for(&None));
    }

    #[test]
    fn an_underrun_does_not_discard_a_working_stream() {
        let state = OutputState::default();
        state.error_callback()(StreamError::BufferUnderrun);
        assert!(state.reusable_for(&None));
    }

    #[test]
    fn a_late_error_from_the_old_stream_does_not_invalidate_its_replacement() {
        let old = OutputState::default();
        let mut on_error = old.error_callback();
        let replacement = OutputState::default();
        on_error(StreamError::DeviceNotAvailable);
        assert!(!old.reusable_for(&None));
        assert!(replacement.reusable_for(&None));
    }

    #[test]
    fn replacing_a_cue_does_not_wait_for_a_stalled_device() {
        let (finished, completion) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            // No device callback consumes this mixer. The old clear() path
            // blocked forever here when a second completion interrupted a cue.
            let (mixer, mut samples) = rodio::mixer::mixer(
                rodio::ChannelCount::new(2).unwrap(),
                rodio::SampleRate::new(48_000).unwrap(),
            );
            let mut player = None;
            replace_cue(&mut player, &mixer, CUES[0]).unwrap();
            replace_cue(&mut player, &mixer, CUES[1]).unwrap();
            assert_eq!(player.as_ref().unwrap().len(), 1);
            assert!(samples.by_ref().take(48_000).any(|sample| sample != 0.0));
            finished.send(()).unwrap();
        });
        completion
            .recv_timeout(Duration::from_secs(1))
            .expect("replacing a cue must not wait for audio samples to drain");
        worker.join().unwrap();
    }

    /// Hand check on a machine with speakers, since CI runners have none:
    /// `cargo test -- --ignored plays_a_cue_on_the_default_device`.
    /// While it sleeps, the volume mixer lists the test binary, proof that the
    /// session belongs to this process rather than to the WebView runtime.
    #[test]
    #[ignore = "opens the default output device and makes noise"]
    fn plays_a_cue_on_the_default_device() {
        let player = SoundPlayer::default();
        player.play(None).expect("the cue starts");
        std::thread::sleep(Duration::from_secs(3));
    }

    #[test]
    #[ignore = "opens and reopens the default output device and makes noise"]
    fn reopens_the_default_device_after_a_stream_error() {
        let mut output = None;
        start(&mut output, CUES[0]).expect("the first cue starts");
        std::thread::sleep(Duration::from_millis(100));
        let device = output.as_ref().unwrap().state.device.clone();
        output.as_ref().unwrap().state.error_callback()(StreamError::StreamInvalidated);
        start(&mut output, CUES[1]).expect("the next cue reopens the device");
        assert!(output.as_ref().unwrap().state.reusable_for(&device));
        std::thread::sleep(Duration::from_secs(3));
    }

    /// A cue the decoder rejects would leave completions silent, and the
    /// failure would only show up on a machine with a working sound card.
    #[test]
    fn every_cue_decodes_to_audio() {
        for cue in CUES {
            let mut samples = Decoder::new(Cursor::new(cue)).expect("cue decodes");
            assert!(samples.next().is_some(), "cue decoded to no samples");
        }
    }
}
