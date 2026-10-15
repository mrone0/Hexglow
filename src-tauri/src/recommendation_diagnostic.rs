//! Strict, bounded telemetry for recommendation state transitions.
//! There is intentionally no field for errors, endpoints, names or context.
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_KEYS: usize = 256;
const MAX_PER_MINUTE: usize = 12;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const INVALID_ENTRY: &str = "Invalid recommendation diagnostic";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Stage {
    Waiting,
    Preparing,
    Analyzing,
    Blocked,
    Failed,
    Complete,
}

impl Stage {
    fn label(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Preparing => "preparing",
            Self::Analyzing => "analyzing",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
            Self::Complete => "complete",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    stage: Stage,
    code: String,
    match_id: Option<String>,
    band: Option<u8>,
    http_status: Option<u16>,
    automatic: bool,
}

impl Entry {
    fn parse(value: Value) -> Result<Self, String> {
        // Never expose the deserializer's error: it may quote untrusted input.
        let entry: Self = serde_json::from_value(value).map_err(|_| INVALID_ENTRY.to_string())?;
        if entry.code.is_empty()
            || entry.code.len() > 48
            || !entry
                .code
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || entry.match_id.as_ref().is_some_and(|id| {
                id.is_empty() || id.len() > 24 || !id.bytes().all(|byte| byte.is_ascii_digit())
            })
            || entry
                .band
                .is_some_and(|band| !matches!(band, 1 | 7 | 11 | 15))
            || entry
                .http_status
                .is_some_and(|status| !(100..=599).contains(&status))
        {
            return Err(INVALID_ENTRY.to_string());
        }
        Ok(entry)
    }

    fn key(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.match_id.as_deref().unwrap_or("none"),
            self.band
                .map_or_else(|| "none".into(), |band| band.to_string()),
            self.stage.label(),
            self.code
        )
    }

    fn message(&self) -> String {
        let mut message = format!(
            "stage={} code={} automatic={}",
            self.stage.label(),
            self.code,
            self.automatic
        );
        if let Some(id) = &self.match_id {
            message.push_str(&format!(" matchId={id}"));
        }
        if let Some(band) = self.band {
            message.push_str(&format!(" band={band}"));
        }
        if let Some(status) = self.http_status {
            message.push_str(&format!(" httpStatus={status}"));
        }
        message
    }
}

#[derive(Default)]
struct Limiter {
    keys: VecDeque<String>,
    emitted: VecDeque<Instant>,
}

impl Limiter {
    fn accept(&mut self, entry: &Entry, at: Instant) -> bool {
        let key = entry.key();
        if self.keys.contains(&key) {
            return false;
        }
        while self
            .emitted
            .front()
            .is_some_and(|first| at.saturating_duration_since(*first) >= RATE_WINDOW)
        {
            self.emitted.pop_front();
        }
        if self.emitted.len() >= MAX_PER_MINUTE {
            return false;
        }
        if self.keys.len() >= MAX_KEYS {
            self.keys.pop_front();
        }
        self.keys.push_back(key);
        self.emitted.push_back(at);
        true
    }
}

static LIMITER: OnceLock<Mutex<Limiter>> = OnceLock::new();

pub(super) fn prepare(value: Value) -> Result<Option<String>, String> {
    let entry = Entry::parse(value)?;
    let Ok(mut limiter) = LIMITER
        .get_or_init(|| Mutex::new(Limiter::default()))
        .lock()
    else {
        // Diagnostics must not interfere with recommendation execution.
        return Ok(None);
    };
    Ok(limiter
        .accept(&entry, Instant::now())
        .then(|| entry.message()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry() -> Value {
        json!({"stage":"waiting","code":"stable-candidates","automatic":true,
            "matchId":"500907715078","band":7})
    }

    #[test]
    fn formats_only_validated_whitelisted_fields() {
        let mut value = entry();
        value["httpStatus"] = json!(429);
        let parsed = Entry::parse(value).unwrap();
        assert_eq!(parsed.message(), "stage=waiting code=stable-candidates automatic=true matchId=500907715078 band=7 httpStatus=429");
        let minimal =
            Entry::parse(json!({"stage":"complete","code":"published","automatic":false})).unwrap();
        assert_eq!(
            minimal.message(),
            "stage=complete code=published automatic=false"
        );
        assert!(Entry::parse(json!({"stage":"failed","code":"timeout","automatic":true,"matchId":null,"band":null,"httpStatus":null})).is_ok());
    }

    #[test]
    fn rejects_extra_fields_without_echoing_their_contents() {
        for field in ["error", "endpoint", "apiKey", "player", "context"] {
            let mut value = entry();
            value[field] = json!("PRIVATE-CONTENT");
            assert_eq!(Entry::parse(value).err().unwrap(), INVALID_ENTRY);
        }
        assert_eq!(
            Entry::parse(json!("PRIVATE-CONTENT")).err().unwrap(),
            INVALID_ENTRY
        );
    }

    #[test]
    fn accepts_every_stage_and_numeric_boundary() {
        for stage in [
            "waiting",
            "preparing",
            "analyzing",
            "blocked",
            "failed",
            "complete",
        ] {
            for band in [1, 7, 11, 15] {
                for status in [100, 599] {
                    assert!(Entry::parse(json!({
                        "stage":stage,"code":"a".repeat(48),"automatic":true,
                        "matchId":"1".repeat(24),"band":band,"httpStatus":status
                    }))
                    .is_ok());
                }
            }
        }
    }

    #[test]
    fn rejects_invalid_fields_and_types() {
        for (field, invalid) in [
            ("stage", json!("unknown")),
            ("stage", json!("WAITING")),
            ("code", json!("")),
            ("code", json!("a".repeat(49))),
            ("code", json!("has space")),
            ("code", json!("line\nbreak")),
            ("code", json!("https://example.test")),
            ("code", json!("等待")),
            ("code", json!("UPPERCASE")),
            ("matchId", json!("")),
            ("matchId", json!("1".repeat(25))),
            ("matchId", json!("player-name")),
            ("matchId", json!(500907715078_u64)),
            ("band", json!(2)),
            ("band", json!("7")),
            ("band", json!(7.5)),
            ("httpStatus", json!(99)),
            ("httpStatus", json!(600)),
            ("httpStatus", json!(400.5)),
            ("automatic", json!("true")),
            ("automatic", Value::Null),
        ] {
            let mut value = entry();
            value[field] = invalid;
            assert_eq!(Entry::parse(value).err().unwrap(), INVALID_ENTRY, "{field}");
        }
        for required in ["stage", "code", "automatic"] {
            let mut value = entry();
            value.as_object_mut().unwrap().remove(required);
            assert!(Entry::parse(value).is_err());
        }
    }

    #[test]
    fn deduplicates_by_match_round_stage_and_code() {
        let mut limiter = Limiter::default();
        let at = Instant::now();
        assert!(limiter.accept(&Entry::parse(entry()).unwrap(), at));
        let mut same_key = entry();
        same_key["automatic"] = json!(false);
        same_key["httpStatus"] = json!(503);
        assert!(!limiter.accept(&Entry::parse(same_key).unwrap(), at + RATE_WINDOW));
        for (field, changed) in [
            ("matchId", json!("500907715079")),
            ("band", json!(11)),
            ("stage", json!("analyzing")),
            ("code", json!("provider-running")),
        ] {
            let mut value = entry();
            value[field] = changed;
            assert!(limiter.accept(&Entry::parse(value).unwrap(), at + RATE_WINDOW));
        }
    }

    #[test]
    fn bounds_log_rate_and_dedup_memory() {
        let mut limiter = Limiter::default();
        let at = Instant::now();
        for index in 0..MAX_PER_MINUTE + 1 {
            let mut value = entry();
            value["code"] = json!(format!("state-{index}"));
            assert_eq!(
                limiter.accept(&Entry::parse(value).unwrap(), at),
                index < MAX_PER_MINUTE
            );
        }
        assert_eq!(limiter.keys.len(), MAX_PER_MINUTE);
        assert_eq!(limiter.emitted.len(), MAX_PER_MINUTE);
        for index in 0..MAX_KEYS + 1 {
            let mut value = entry();
            value["code"] = json!(format!("next-{index}"));
            assert!(limiter.accept(
                &Entry::parse(value).unwrap(),
                at + RATE_WINDOW * (index as u32 + 1)
            ));
        }
        assert_eq!(limiter.keys.len(), MAX_KEYS);
        assert_eq!(limiter.emitted.len(), 1);
    }
}
