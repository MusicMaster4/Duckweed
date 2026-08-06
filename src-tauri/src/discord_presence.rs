use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

const APPLICATION_ID: &str = "1534568909473186025";
const LARGE_IMAGE: &str = "duckweed";
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Owns Duckweed's connection to the local Discord client.
///
/// Discord may be opened after Duckweed or restarted during a session, so a
/// small background worker periodically refreshes the activity and reconnects
/// whenever the IPC connection disappears.
pub struct DiscordPresence {
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl DiscordPresence {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("duckweed-discord-presence".into())
            .spawn(move || run(worker_stop))
            .ok();

        Self {
            stop,
            worker: Mutex::new(worker),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for DiscordPresence {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

fn run(stop: Arc<AtomicBool>) {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let mut client: Option<DiscordIpcClient> = None;

    while !stop.load(Ordering::Acquire) {
        if client.is_none() {
            let mut candidate = DiscordIpcClient::new(APPLICATION_ID);
            if candidate.connect().is_ok() {
                client = Some(candidate);
            }
        }

        if let Some(connected) = client.as_mut() {
            if connected.set_activity(activity(started_at)).is_err() {
                let _ = connected.close();
                client = None;
            }
        }

        wait_or_stop(&stop, RETRY_INTERVAL);
    }

    if let Some(mut connected) = client {
        let _ = connected.clear_activity();
        let _ = connected.close();
    }
}

fn activity(started_at: i64) -> activity::Activity<'static> {
    activity::Activity::new()
        .details("Terminal workspace")
        .state("Vibe coding")
        .timestamps(activity::Timestamps::new().start(started_at))
        .assets(
            activity::Assets::new()
                .large_image(LARGE_IMAGE)
                .large_text("Duckweed"),
        )
}

fn wait_or_stop(stop: &AtomicBool, duration: Duration) {
    let mut remaining = duration;
    while !stop.load(Ordering::Acquire) && !remaining.is_zero() {
        let sleep_for = remaining.min(STOP_POLL_INTERVAL);
        thread::sleep(sleep_for);
        remaining = remaining.saturating_sub(sleep_for);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_payload_contains_the_public_duckweed_identity() {
        let payload = serde_json::to_value(activity(123)).unwrap();
        assert_eq!(payload["details"], "Terminal workspace");
        assert_eq!(payload["state"], "Vibe coding");
        assert_eq!(payload["timestamps"]["start"], 123);
        assert_eq!(payload["assets"]["large_image"], LARGE_IMAGE);
        assert_eq!(payload["assets"]["large_text"], "Duckweed");
    }

    #[test]
    fn stopped_wait_returns_without_sleeping_for_the_retry_interval() {
        let stop = AtomicBool::new(true);
        let before = std::time::Instant::now();
        wait_or_stop(&stop, RETRY_INTERVAL);
        assert!(before.elapsed() < STOP_POLL_INTERVAL);
    }
}
