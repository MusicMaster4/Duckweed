//! What a token costs, per model.
//!
//! Every agent reports tokens; almost none report money. The rates here turn
//! one into the other. They are published list prices, not an invoice: a
//! subscription plan, a free tier, or a provider discount all make the real
//! number lower. The UI says so, and every rate can be overridden from the
//! settings tab (see [`load_overrides`]).
//!
//! Rates are US dollars per million tokens.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Keep per-request billing conditions separate when aggregating tokens.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Context {
    pub long: bool,
    /// 0 = standard, 1 = Fast, 2 = Flex/Batch.
    pub tier: u8,
}

impl Context {
    pub fn for_request(model: &str, tier: &str, tokens: &crate::usage::Tokens) -> Self {
        let model = normalize(model);
        let long_capable = model.starts_with("gpt-6-astra")
            || model.starts_with("gpt-5.6-")
            || model == "gpt-5.5"
            || model == "gpt-5.5-pro"
            || model == "gpt-5.4"
            || model == "gpt-5.4-pro";
        Self {
            long: long_capable && tokens.input + tokens.cache_read + tokens.cache_write > 272_000,
            tier: match tier {
                "priority" | "fast" => 1,
                "flex" | "batch" => 2,
                _ => 0,
            },
        }
    }

    pub fn cost(self, model: &str, mut rates: Rates, tokens: &crate::usage::Tokens) -> f64 {
        if self.long {
            rates.input *= 2.0;
            rates.cache_read *= 2.0;
            rates.cache_write *= 2.0;
            rates.output *= 1.5;
        }
        let multiplier = match self.tier {
            1 if normalize(model) == "gpt-5.5" => 2.5,
            1 => 2.0,
            2 => 0.5,
            _ => 1.0,
        };
        rates.cost(tokens) * multiplier
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    /// Reading a cached prefix — typically a tenth of the input rate.
    pub cache_read: f64,
    /// Writing one — typically 1.25x input for a five-minute TTL.
    pub cache_write: f64,
}

impl Rates {
    /// The common shape: cache reads at 0.1x input, writes at 1.25x.
    pub fn new(input: f64, output: f64) -> Self {
        Self {
            input,
            output,
            cache_read: input * 0.1,
            cache_write: input * 1.25,
        }
    }

    pub fn cost(&self, t: &crate::usage::Tokens) -> f64 {
        let m = 1_000_000.0;
        (t.input as f64 * self.input
            + (t.output + t.reasoning) as f64 * self.output
            + t.cache_read as f64 * self.cache_read
            + t.cache_write as f64 * self.cache_write)
            / m
    }
}

/// A model-name fragment with its input and output rate.
///
/// Matching is longest-fragment-wins, so `claude-opus-4-1` beats a bare
/// `claude-opus` and specific entries can sit next to family fallbacks in any
/// order.
type Entry = (&'static str, f64, f64);

const fn e(fragment: &'static str, input: f64, output: f64) -> Entry {
    (fragment, input, output)
}

/// Published list prices. Ordered for readability only — lookup sorts by
/// fragment length, not position.
static TABLE: &[Entry] = &[
    // ---- Anthropic ----
    e("claude-fable-5", 10.0, 50.0),
    e("claude-mythos", 10.0, 50.0),
    e("claude-opus-5", 5.0, 25.0),
    e("claude-opus-4-8", 5.0, 25.0),
    e("claude-opus-4-7", 5.0, 25.0),
    e("claude-opus-4-6", 5.0, 25.0),
    e("claude-opus-4-5", 5.0, 25.0),
    e("claude-opus-4-1", 15.0, 75.0),
    e("claude-opus-4", 15.0, 75.0),
    e("claude-3-opus", 15.0, 75.0),
    e("claude-opus", 5.0, 25.0),
    e("claude-sonnet-5", 3.0, 15.0),
    e("claude-sonnet", 3.0, 15.0),
    e("claude-3-7-sonnet", 3.0, 15.0),
    e("claude-3-5-sonnet", 3.0, 15.0),
    e("claude-haiku-4-5", 1.0, 5.0),
    e("claude-3-5-haiku", 0.8, 4.0),
    e("claude-3-haiku", 0.25, 1.25),
    e("claude-haiku", 1.0, 5.0),
    // ---- OpenAI / Codex ----
    // https://developers.openai.com/api/docs/pricing (2026-09-07).
    e("gpt-6-astra", 10.0, 50.0),
    e("gpt-5.6-sol", 4.0, 20.0),
    e("gpt-5.6-terra", 2.0, 12.0),
    e("gpt-5.6-luna", 0.2, 1.2),
    e("gpt-5.5-pro", 30.0, 180.0),
    e("gpt-5.5", 5.0, 30.0),
    e("gpt-5.4-pro", 30.0, 180.0),
    e("gpt-5.4-mini", 0.75, 4.5),
    e("gpt-5.4-nano", 0.2, 1.25),
    e("gpt-5.4", 2.5, 15.0),
    e("gpt-5.3-codex", 1.75, 14.0),
    e("gpt-5.2-pro", 21.0, 168.0),
    e("gpt-5.2", 1.75, 14.0),
    e("gpt-5.1", 1.25, 10.0),
    e("gpt-5-codex", 1.25, 10.0),
    e("gpt-5-mini", 0.25, 2.0),
    e("gpt-5-nano", 0.05, 0.4),
    e("gpt-5", 1.25, 10.0),
    e("gpt-4.1-mini", 0.4, 1.6),
    e("gpt-4.1", 2.0, 8.0),
    e("gpt-4o-mini", 0.15, 0.6),
    e("gpt-4o", 2.5, 10.0),
    e("o4-mini", 1.1, 4.4),
    e("o3-mini", 1.1, 4.4),
    e("o3", 2.0, 8.0),
    e("codex-mini", 1.5, 6.0),
    // ---- Google ----
    e("gemini-3.1-pro", 2.0, 12.0),
    e("gemini-3-pro", 2.0, 12.0),
    e("gemini-3-flash", 0.5, 3.0),
    e("gemini-3", 2.0, 12.0),
    e("gemini-2.5-pro", 1.25, 10.0),
    e("gemini-2.5-flash-lite", 0.1, 0.4),
    e("gemini-2.5-flash", 0.3, 2.5),
    e("gemini-2.0-flash", 0.1, 0.4),
    e("gemini-exp", 1.25, 10.0),
    e("gemini", 1.25, 10.0),
    // ---- xAI ----
    e("grok-code-fast", 0.2, 1.5),
    e("grok-4-fast", 0.2, 0.5),
    e("grok-4.5", 3.0, 15.0),
    e("grok-4", 3.0, 15.0),
    e("grok-3-mini", 0.3, 0.5),
    e("grok-3", 3.0, 15.0),
    e("grok", 3.0, 15.0),
    // ---- Open-weight / others ----
    e("kimi-k2", 0.6, 2.5),
    e("kimi", 0.6, 2.5),
    e("deepseek-reasoner", 0.55, 2.19),
    e("deepseek", 0.28, 0.42),
    e("qwen3-coder", 0.3, 1.2),
    e("qwen", 0.3, 1.2),
    e("glm-4", 0.6, 2.2),
    e("minimax", 0.3, 1.2),
    e("llama", 0.2, 0.6),
    e("mistral", 0.3, 0.9),
];

/// Strip the provider prefixes agents put in front of a model id
/// (`openrouter/anthropic/claude-opus-5`, `google/gemini-3-pro`) and
/// lowercase what is left.
pub fn normalize(model: &str) -> String {
    let lower = model.trim().to_ascii_lowercase();
    // Keep only the last path segment; providers stack up to two prefixes.
    let tail = lower.rsplit('/').next().unwrap_or(&lower);
    tail.to_string()
}

/// User-supplied rates, keyed by the same normalized model id.
pub type Overrides = HashMap<String, Rates>;

pub fn load_overrides(path: &Path) -> Overrides {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_overrides(path: &Path, overrides: &Overrides) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_string_pretty(overrides).map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| error.to_string())
}

/// Rates for `model`, and whether they came from the table at all.
///
/// An unknown model costs nothing rather than guessing — a wrong number
/// silently inflates the total, while a zero shows up in the UI as
/// "unpriced" and asks the user for a rate.
pub fn lookup(model: &str, overrides: &Overrides) -> (Rates, bool) {
    let key = normalize(model);
    if let Some(rates) = overrides.get(&key) {
        return (*rates, true);
    }
    let best = TABLE
        .iter()
        .filter(|(fragment, _, _)| {
            key.match_indices(fragment).any(|(start, _)| {
                // Do not price a new numbered family using an older prefix.
                key.as_bytes()
                    .get(start + fragment.len())
                    .map_or(true, |next| *next != b'.' && !next.is_ascii_digit())
            })
        })
        .max_by_key(|(fragment, _, _)| fragment.len());
    match best {
        Some(&(fragment, input, output)) => {
            let mut rates = Rates::new(input, output);
            rates.cache_read = match fragment {
                "gpt-4.1" | "gpt-4.1-mini" | "o3" | "o4-mini" => input * 0.25,
                "gpt-4o" | "gpt-4o-mini" | "o3-mini" => input * 0.5,
                "gpt-5.5-pro" | "gpt-5.4-pro" | "gpt-5.2-pro" => 0.0,
                _ => rates.cache_read,
            };
            (rates, true)
        }
        None => (Rates::new(0.0, 0.0), false),
    }
}

/// Every model the built-in table knows, for the settings tab's rate editor.
pub fn known_models() -> Vec<String> {
    TABLE
        .iter()
        .map(|(fragment, _, _)| (*fragment).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_codex_models_and_request_conditions() {
        let none = Overrides::new();
        for (model, input, output) in [
            ("gpt-6-astra", 10.0, 50.0),
            ("gpt-5.6-sol", 4.0, 20.0),
            ("gpt-5.6-terra", 2.0, 12.0),
            ("gpt-5.6-luna", 0.2, 1.2),
            ("gpt-5.5", 5.0, 30.0),
            ("gpt-5.3-codex", 1.75, 14.0),
        ] {
            let (rates, known) = lookup(model, &none);
            assert!(known);
            assert_eq!((rates.input, rates.output), (input, output));
        }
        assert!(!lookup("gpt-5.7", &none).1);
        assert!(!lookup("gpt-5.6", &none).1);
        let tokens = crate::usage::Tokens {
            input: 100_000,
            cache_read: 180_000,
            cache_write: 20_000,
            output: 8_000,
            reasoning: 2_000,
        };
        let (rates, _) = lookup("gpt-6-astra", &none);
        let context = Context::for_request("gpt-6-astra", "fast", &tokens);
        assert!(context.long);
        // Long input/cache rates plus long output rate, then Fast's 2x.
        assert!((context.cost("gpt-6-astra", rates, &tokens) - 7.22).abs() < 1e-9);
        let boundary = crate::usage::Tokens {
            input: 272_000,
            ..Default::default()
        };
        assert!(!Context::for_request("gpt-6-astra", "", &boundary).long);
    }

    #[test]
    fn strips_provider_prefixes() {
        assert_eq!(
            normalize("openrouter/google/gemini-3-flash"),
            "gemini-3-flash"
        );
        assert_eq!(normalize("  Claude-Opus-5 "), "claude-opus-5");
    }

    #[test]
    fn longest_fragment_wins_over_family_fallback() {
        let none = Overrides::new();
        // `claude-opus` would also match; the dated entry must win.
        let (rates, known) = lookup("claude-opus-4-1", &none);
        assert!(known);
        assert_eq!(rates.input, 15.0);

        let (rates, _) = lookup("claude-opus-5", &none);
        assert_eq!(rates.input, 5.0);
    }

    #[test]
    fn unknown_model_is_flagged_and_free() {
        let (rates, known) = lookup("some-local-llm-v3", &Overrides::new());
        assert!(!known);
        assert_eq!(rates.input, 0.0);
        assert_eq!(rates.output, 0.0);
    }

    #[test]
    fn overrides_beat_the_table() {
        let mut overrides = Overrides::new();
        overrides.insert("claude-opus-5".into(), Rates::new(1.0, 2.0));
        let (rates, known) = lookup("claude-opus-5", &overrides);
        assert!(known);
        assert_eq!(rates.input, 1.0);
    }

    #[test]
    fn cost_counts_reasoning_at_the_output_rate() {
        let rates = Rates::new(10.0, 50.0);
        let tokens = crate::usage::Tokens {
            input: 1_000_000,
            output: 500_000,
            reasoning: 500_000,
            cache_read: 1_000_000,
            cache_write: 1_000_000,
        };
        // 10 + 50 (1M output-rate tokens) + 1 (read) + 12.5 (write)
        assert!((rates.cost(&tokens) - 73.5).abs() < 1e-9);
    }
}
