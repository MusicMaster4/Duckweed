//! Completion cues, played by the Duckweed process itself.
//!
//! The WebView can play them too, and used to. On Windows that stream belongs
//! to `msedgewebview2.exe`, the runtime process every WebView2 app shares, so
//! Windows lists the cue in the volume mixer as "Microsoft Edge WebView2" with
//! Edge's icon. Opening the output device from this process instead puts the
//! audio session on `duckweed.exe`, which the mixer labels with the app's own
//! name and icon.

use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::cpal::DeviceId;
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

/// The open output device and the track feeding it.
struct Output {
    /// Which device this was opened on, so a later default-device change can be
    /// noticed: an open stream keeps playing to the device it was built for
    /// even after Windows moves the system default elsewhere.
    device: Option<DeviceId>,
    player: Player,
    /// Dropping this closes the device and silences the player, so it is held
    /// for as long as the app might play another cue. Declared last so the
    /// player stops before the device it feeds goes away.
    _sink: MixerDeviceSink,
}

/// Handle to the audio thread. Cheap to clone; the thread starts on first use.
#[derive(Default, Clone)]
pub struct SoundPlayer(Arc<Mutex<Option<Sender<Request>>>>);

impl SoundPlayer {
    /// Play one randomly chosen completion cue.
    ///
    /// Resolves once the cue has started, not once it has finished. The call
    /// blocks for as long as opening the output device takes, so it belongs on
    /// a blocking task rather than the IPC thread.
    pub fn play(&self) -> Result<(), String> {
        let (reply, started) = mpsc::sync_channel(1);
        self.send(Request {
            cue: CUES[next_cue_index()],
            reply,
        })?;
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
    if output.as_ref().is_some_and(|open| open.device != device) {
        // The user switched output devices; reopen so the cue follows them.
        *output = None;
    }
    if output.is_none() {
        let mut sink = DeviceSinkBuilder::open_default_sink()
            .map_err(|error| format!("could not open an audio output: {error}"))?;
        // Closing the device on the way out is the intended behaviour here, so
        // rodio's warning about it would only be noise on stderr.
        sink.log_on_drop(false);
        let player = Player::connect_new(sink.mixer());
        *output = Some(Output {
            device,
            player,
            _sink: sink,
        });
    }
    let open = output
        .as_mut()
        .ok_or("the audio output disappeared while opening it")?;

    let source = Decoder::new(Cursor::new(cue))
        .map_err(|error| format!("could not decode a cue: {error}"))?;
    if !open.player.empty() {
        // Two completions at once restart the cue instead of queueing a copy
        // behind the one already sounding.
        open.player.clear();
    }
    open.player.append(source);
    open.player.play();
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

    /// Hand check on a machine with speakers, since CI runners have none:
    /// `cargo test -- --ignored plays_a_cue_on_the_default_device`.
    /// While it sleeps, the volume mixer lists the test binary, proof that the
    /// session belongs to this process rather than to the WebView runtime.
    #[test]
    #[ignore = "opens the default output device and makes noise"]
    fn plays_a_cue_on_the_default_device() {
        let player = SoundPlayer::default();
        player.play().expect("the cue starts");
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
