//! Permission decisions run in native code so WebView suspension cannot stall agents.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DELAY: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct Policy {
    deadline: u64,
    enabled_at: Option<Instant>,
}

impl Policy {
    pub fn set(&mut self, value: &Value) {
        let deadline = if value.as_str() == Some("until-disabled") {
            u64::MAX
        } else {
            value.as_u64().unwrap_or_default()
        };
        // Repeated synchronization must not postpone decisions already waiting.
        if self.deadline != deadline {
            self.deadline = deadline;
            self.enabled_at = Some(Instant::now());
        }
    }

    pub fn enabled(&self) -> bool {
        self.deadline
            > SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
    }
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub key: String,
    pub permission_id: String,
    pub option_id: String,
    pub reply: Value,
    received: Instant,
    scheduled: bool,
}

#[derive(Default)]
pub struct Queue {
    pending: HashMap<String, Decision>,
    // Suppress late UI responses after the native transport already answered.
    completed: HashSet<String>,
}

fn request_key(frame: &Value) -> Option<String> {
    if frame["type"] == "control_response" {
        return frame["response"]["request_id"]
            .as_str()
            .map(|id| format!("claude:{id}"));
    }
    if frame.get("method").is_none()
        && (frame.get("result").is_some() || frame.get("error").is_some())
    {
        return rpc_key(frame.get("id")?);
    }
    None
}

fn rpc_key(id: &Value) -> Option<String> {
    (id.is_string() || id.is_number()).then(|| format!("rpc:{id}"))
}

impl Queue {
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn observe(&mut self, line: &str) {
        // Avoid parsing large streamed content twice.
        if !line.contains("control_request")
            && !line.contains("request_permission")
            && !line.contains("requestApproval")
            && !line.contains("control_cancel_request")
            && !line.contains("$/cancelRequest")
        {
            return;
        }
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if frame["type"] == "control_cancel_request" {
            if let Some(id) = frame["request_id"].as_str() {
                self.pending.remove(&format!("claude:{id}"));
            }
        } else if frame["method"] == "$/cancelRequest" {
            if let Some(key) = rpc_key(&frame["params"]["id"]) {
                self.pending.remove(&key);
            }
        } else if let Some(decision) = parse_decision(&frame) {
            // Duplicate delivery must not reset the one-second delay.
            if !self.completed.contains(&decision.key) {
                self.pending.entry(decision.key.clone()).or_insert(decision);
            }
        }
    }

    /// Reserve before writing, so a concurrent manual/automatic response cannot win twice.
    pub fn outgoing(&mut self, line: &str) -> bool {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return true;
        };
        if let Some(key) = request_key(&frame) {
            if self.completed.contains(&key) {
                return false;
            }
            if self.pending.remove(&key).is_some() {
                self.completed.insert(key);
            }
        }
        // Interrupt/cancel invalidates requests that have not been sent yet.
        if frame["method"] == "turn/interrupt"
            || frame["method"] == "session/cancel"
            || frame["request"]["subtype"] == "interrupt"
        {
            self.pending.clear();
        }
        true
    }

    pub fn due(&mut self, policy: &Policy, now: Instant) -> Vec<Decision> {
        if !policy.enabled() {
            return Vec::new();
        }
        let ready = self
            .pending
            .values()
            .filter(|entry| {
                let start = policy
                    .enabled_at
                    .map_or(entry.received, |at| at.max(entry.received));
                !entry.scheduled && now.saturating_duration_since(start) >= DELAY
            })
            .map(|entry| entry.key.clone())
            .collect::<Vec<_>>();
        ready
            .into_iter()
            .filter_map(|key| {
                let entry = self.pending.get_mut(&key)?;
                entry.scheduled = true;
                Some(entry.clone())
            })
            .collect()
    }

    pub fn claim(&mut self, key: &str, policy: &Policy, now: Instant) -> bool {
        let Some(entry) = self.pending.get_mut(key) else {
            return false;
        };
        let start = policy
            .enabled_at
            .map_or(entry.received, |at| at.max(entry.received));
        if !policy.enabled() || now.saturating_duration_since(start) < DELAY {
            entry.scheduled = false;
            return false;
        }
        self.pending.remove(key);
        self.completed.insert(key.to_owned());
        true
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

fn parse_decision(frame: &Value) -> Option<Decision> {
    let (key, permission_id, option_id, reply) = if frame["type"] == "control_request" {
        let id = frame["request_id"].as_str()?;
        let request = &frame["request"];
        if request["subtype"] != "can_use_tool" {
            return None;
        }
        // Questions require an actual user answer, even with automatic permissions.
        if request["tool_name"]
            .as_str()
            .unwrap_or_default()
            .eq_ignore_ascii_case("AskUserQuestion")
            && request["input"]["questions"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        {
            return None;
        }
        let input = request["input"]
            .as_object()
            .map(|map| Value::Object(map.clone()))
            .unwrap_or(json!({}));
        (
            format!("claude:{id}"),
            format!("perm-{id}"),
            "allow".to_string(),
            json!({"type":"control_response","response":{"subtype":"success","request_id":id,
                "response":{"behavior":"allow","updatedInput":input}}}),
        )
    } else {
        let id = frame.get("id")?;
        let key = rpc_key(id)?;
        let method = frame["method"].as_str()?;
        let params = &frame["params"];
        let (option, result) = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                ("accept".to_string(), json!({"decision":"accept"}))
            }
            "item/permissions/requestApproval" => {
                let mut permissions = serde_json::Map::new();
                for field in ["network", "fileSystem"] {
                    if let Some(value) = params["permissions"]
                        .get(field)
                        .filter(|value| !value.is_null())
                    {
                        permissions.insert(field.into(), value.clone());
                    }
                }
                (
                    "accept".to_string(),
                    json!({"permissions":permissions,"scope":"turn"}),
                )
            }
            "session/request_permission" => {
                let options = params["options"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                let usable =
                    |option: &&Value| option["optionId"].as_str().is_some_and(|id| !id.is_empty());
                let option = options
                    .iter()
                    .filter(usable)
                    .find(|option| option["kind"] == "allow_once")
                    .or_else(|| {
                        options
                            .iter()
                            .filter(usable)
                            .find(|option| option["kind"] == "allow_always")
                    });
                let option_id = if let Some(option) = option {
                    option["optionId"].as_str()?.to_string()
                } else if options.is_empty() {
                    "allow".into()
                } else {
                    return None;
                };
                (
                    option_id.clone(),
                    json!({"outcome":{"outcome":"selected","optionId":option_id}}),
                )
            }
            _ => return None,
        };
        let text_id = id
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| id.to_string());
        (
            key,
            format!("perm-{text_id}"),
            option,
            json!({"jsonrpc":"2.0","id":id,"result":result}),
        )
    };
    Some(Decision {
        key,
        permission_id,
        option_id,
        reply,
        received: Instant::now(),
        scheduled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude(id: &str) -> String {
        json!({"type":"control_request","request_id":id,"request":{
            "subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo test"}}
        })
        .to_string()
    }

    fn enabled() -> Policy {
        let mut policy = Policy::default();
        policy.set(&json!("until-disabled"));
        policy
    }

    #[test]
    fn existing_and_future_sessions_share_policy_and_keep_all_pending_decisions() {
        let mut existing = Queue::default();
        existing.observe(&claude("old"));
        let policy = enabled();
        let mut future = Queue::default();
        for id in ["first", "second"] {
            future.observe(&claude(id));
        }
        let before = Instant::now();
        assert!(existing.due(&policy, before).is_empty());
        assert!(future.due(&policy, before).is_empty());
        let now = before + DELAY;
        assert_eq!(existing.due(&policy, now).len(), 1);
        let decisions = future.due(&policy, now);
        assert_eq!(decisions.len(), 2);
        for decision in decisions {
            assert_eq!(
                decision.reply["response"]["response"]["updatedInput"]["command"],
                "echo test"
            );
            assert!(future.claim(&decision.key, &policy, now));
            assert!(!future.outgoing(&decision.reply.to_string()));
        }
        assert!(future.due(&policy, now + DELAY).is_empty());
    }

    #[test]
    fn manual_response_cancel_and_stop_invalidate_work_already_collected_by_monitor() {
        for cancellation in ["manual", "cancel", "stop"] {
            let policy = enabled();
            let mut queue = Queue::default();
            queue.observe(&claude("one"));
            let now = Instant::now() + DELAY;
            let decision = queue.due(&policy, now).pop().unwrap();
            match cancellation {
                "manual" => assert!(queue.outgoing(
                    &json!({"type":"control_response","response":{
                    "request_id":"one","response":{"behavior":"deny"}}})
                    .to_string()
                )),
                "cancel" => {
                    queue.observe(r#"{"type":"control_cancel_request","request_id":"one"}"#)
                }
                _ => queue.clear(),
            }
            assert!(!queue.claim(&decision.key, &policy, now));
        }
    }

    #[test]
    fn disabling_expiry_and_reenabling_are_checked_at_dispatch_time() {
        let mut policy = enabled();
        let mut queue = Queue::default();
        queue.observe(&claude("one"));
        let now = Instant::now() + DELAY;
        let decision = queue.due(&policy, now).pop().unwrap();
        policy.set(&Value::Null);
        assert!(!queue.claim(&decision.key, &policy, now));
        policy.set(&json!(1)); // An expired wall-clock deadline, even without a UI timer.
        assert!(!queue.claim(&decision.key, &policy, now));
        policy.set(&json!("until-disabled"));
        assert!(!queue.claim(&decision.key, &policy, Instant::now()));
        assert!(queue.claim(&decision.key, &policy, Instant::now() + DELAY));
    }

    #[test]
    fn supports_codex_commands_files_and_permission_scopes() {
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
        ] {
            let request = json!({"id":42,"method":method,"params":{"permissions":{
                "network":{"enabled":true},"fileSystem":{"write":["/workspace"]},"unrelated":true}}});
            let decision = parse_decision(&request).unwrap();
            assert_eq!(decision.permission_id, "perm-42");
            assert_eq!(decision.reply["id"], 42);
            if method == "item/permissions/requestApproval" {
                assert_eq!(decision.reply["result"]["scope"], "turn");
                assert_eq!(
                    decision.reply["result"]["permissions"]["network"]["enabled"],
                    true
                );
                assert!(decision.reply["result"]["permissions"]
                    .get("unrelated")
                    .is_none());
            } else {
                assert_eq!(decision.reply["result"]["decision"], "accept");
            }
        }
    }

    #[test]
    fn acp_prefers_allow_once_and_handles_allow_always_and_default_options() {
        for (options, expected) in [
            (
                json!([{"kind":"reject_once","optionId":"deny"},{"kind":"allow_always","optionId":"always"},
                {"kind":"allow_once","optionId":"once"}]),
                "once",
            ),
            (
                json!([{"kind":"allow_always","optionId":"always"}]),
                "always",
            ),
            (json!([]), "allow"),
        ] {
            let decision = parse_decision(&json!({"id":"acp","method":"session/request_permission","params":{"options":options}})).unwrap();
            assert_eq!(
                decision.reply["result"]["outcome"],
                json!({"outcome":"selected","optionId":expected})
            );
        }
    }

    #[test]
    fn questions_reject_only_and_non_permission_requests_are_never_approved() {
        for request in [
            json!({"type":"control_request","request_id":"q","request":{"subtype":"can_use_tool",
                "tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?"}]}}}),
            json!({"id":1,"method":"session/request_input"}),
            json!({"id":2,"method":"item/tool/requestUserInput"}),
            json!({"id":3,"method":"session/request_permission","params":{"options":[{"kind":"reject_once","optionId":"no"}]}}),
            json!({"id":4,"method":"fs/write_text_file"}),
        ] {
            assert!(parse_decision(&request).is_none());
        }
    }

    #[test]
    fn a_blocked_writer_is_scheduled_once_and_new_prompts_do_not_erase_pending_tools() {
        let policy = enabled();
        let mut queue = Queue::default();
        queue.observe(&claude("one"));
        let now = Instant::now() + DELAY;
        let decision = queue.due(&policy, now).pop().unwrap();
        assert!(queue.due(&policy, now + DELAY).is_empty());
        assert!(queue.outgoing(r#"{"type":"user","message":{"content":"continue"}}"#));
        assert!(queue.claim(&decision.key, &policy, now));
    }

    #[test]
    fn duplicate_requests_do_not_restart_delay_and_rpc_cancellation_is_respected() {
        let policy = enabled();
        let mut queue = Queue::default();
        queue.observe(&claude("one"));
        let first = queue.pending["claude:one"].received;
        queue.observe(&claude("one"));
        assert_eq!(queue.pending["claude:one"].received, first);
        queue.observe(r#"{"id":7,"method":"item/commandExecution/requestApproval"}"#);
        queue.observe(r#"{"method":"$/cancelRequest","params":{"id":7}}"#);
        assert_eq!(queue.due(&policy, Instant::now() + DELAY).len(), 1);
    }
}
