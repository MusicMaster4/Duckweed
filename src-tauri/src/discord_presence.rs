use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

use crate::agent_proc::AgentProcManager;

const APPLICATION_ID: &str = "1534568909473186025";
const LARGE_IMAGE: &str = "duckweed";
const DOWNLOAD_URL: &str = "https://github.com/MusicMaster4/Duckweed/releases/latest";
const UPDATE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(15);
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
    pub fn start(agents: AgentProcManager) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("duckweed-discord-presence".into())
            .spawn(move || run(worker_stop, agents))
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

fn run(stop: Arc<AtomicBool>, agents: AgentProcManager) {
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
            if connected
                .set_activity(activity(started_at, agents.open_count()))
                .is_err()
            {
                let _ = connected.close();
                client = None;
            }
        }

        let wait_duration = if client.is_some() {
            UPDATE_INTERVAL
        } else {
            RECONNECT_INTERVAL
        };
        wait_or_stop(&stop, wait_duration);
    }

    if let Some(mut connected) = client {
        let _ = connected.clear_activity();
        let _ = connected.close();
    }
}

fn activity(started_at: i64, open_agents: usize) -> activity::Activity<'static> {
    activity::Activity::new()
        .details("Terminal workspace")
        .state(agent_count_label(open_agents))
        .timestamps(activity::Timestamps::new().start(started_at))
        .assets(
            activity::Assets::new()
                .large_image(LARGE_IMAGE)
                .large_text("Duckweed"),
        )
        .buttons(vec![activity::Button::new(
            "Download Duckweed",
            DOWNLOAD_URL,
        )])
}

fn agent_count_label(count: usize) -> String {
    match count {
        1 => "1 agent open".into(),
        count => format!("{count} agents open"),
    }
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
        let payload = serde_json::to_value(activity(123, 2)).unwrap();
        assert_eq!(payload["details"], "Terminal workspace");
        assert_eq!(payload["state"], "2 agents open");
        assert_eq!(payload["timestamps"]["start"], 123);
        assert_eq!(payload["assets"]["large_image"], LARGE_IMAGE);
        assert_eq!(payload["assets"]["large_text"], "Duckweed");
        assert_eq!(payload["buttons"][0]["label"], "Download Duckweed");
        assert_eq!(payload["buttons"][0]["url"], DOWNLOAD_URL);
    }

    #[test]
    fn agent_count_is_grammatically_correct() {
        assert_eq!(agent_count_label(0), "0 agents open");
        assert_eq!(agent_count_label(1), "1 agent open");
        assert_eq!(agent_count_label(7), "7 agents open");
    }

    #[test]
    fn presence_updates_every_five_minutes() {
        assert_eq!(UPDATE_INTERVAL, Duration::from_secs(300));
    }

    #[test]
    fn stopped_wait_returns_without_sleeping_for_the_update_interval() {
        let stop = AtomicBool::new(true);
        let before = std::time::Instant::now();
        wait_or_stop(&stop, UPDATE_INTERVAL);
        assert!(before.elapsed() < STOP_POLL_INTERVAL);
    }
}
