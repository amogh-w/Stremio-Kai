//! Typed phone -> PC commands. Anything that does not deserialize and validate is dropped,
//! so the phone can never pass raw mpv commands or arbitrary JS to the bridge.
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Cmd {
    Pause { v: bool },
    Seek { s: f64 },
    Volume { v: f64 },
    Mute { v: bool },
    Speed { v: f64 },
    Aid { id: String },
    Sid { id: String },
    Subdelay { s: f64 },
    Skip,
    Next,
    Ok,
    Back,
    Key { key: Key },
    Hash { h: String },
    /// Press one of Kai's mpv hotkeys (see `HOTKEYS`). The bridge sends it to mpv as a `keypress`.
    Hotkey { key: String },
    /// Pick an episode on the open detail page.
    Video { id: String },
    /// Play stream `idx` from detail revision `rev` (the bridge rejects a stale revision).
    Play { idx: u32, rev: u32 },
    /// `detail:<type>/<id>`, `resume:<id>` or `streams:<id>`; the bridge turns it into a route.
    Open {
        #[serde(rename = "ref")]
        target: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Key {
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Escape,
    Tab,
}

fn track_id_ok(id: &str) -> bool {
    id == "no" || (!id.is_empty() && id.len() <= 4 && id.bytes().all(|b| b.is_ascii_digit()))
}

fn hash_ok(h: &str) -> bool {
    h.starts_with("#/") && h.len() <= 400 && h.bytes().all(|b| b.is_ascii_alphanumeric() || b"#/?=&:%._-~".contains(&b))
}

fn ref_ok(r: &str) -> bool {
    let known = ["detail:", "resume:", "streams:"].iter().any(|p| r.starts_with(p));
    known && r.len() <= 120 && r.bytes().all(|b| b.is_ascii_alphanumeric() || b":/._%-".contains(&b))
}

/// Every key bound in portable_config/input.conf. The phone can press these and nothing else.
const HOTKEYS: [&str; 36] = [
    "q", "t", "T", "u", "`",
    "F1", "F2", "F3", "Shift+F1", "Ctrl+F1", "Shift+F2", "Ctrl+F2", "Shift+F3", "Ctrl+F3", "F4", "Ctrl+F4",
    "Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4",
    "F6", "Ctrl+F6", "F7", "Ctrl+F7", "F8", "Ctrl+F8",
    "F9", "Shift+F9", "Ctrl+F9", "F10", "Shift+F10", "Ctrl+F10", "F11", "Ctrl+F11", "F12", "Ctrl+F12",
];

fn video_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b":._%-".contains(&b))
}

impl Cmd {
    /// Returns a sanitized command, or None when the values are out of range.
    pub fn validate(self) -> Option<Cmd> {
        match self {
            Cmd::Seek { s } if s.is_finite() && (0.0..=86_400.0).contains(&s) => Some(self),
            Cmd::Volume { v } if v.is_finite() => Some(Cmd::Volume { v: v.clamp(0.0, 100.0) }),
            Cmd::Speed { v } if v.is_finite() => Some(Cmd::Speed { v: v.clamp(0.25, 4.0) }),
            Cmd::Subdelay { s } if s.is_finite() && s.abs() <= 60.0 => Some(self),
            Cmd::Aid { ref id } | Cmd::Sid { ref id } if track_id_ok(id) => Some(self),
            Cmd::Hash { ref h } if hash_ok(h) => Some(self),
            Cmd::Hotkey { ref key } if HOTKEYS.contains(&key.as_str()) => Some(self),
            Cmd::Video { ref id } if video_id_ok(id) => Some(self),
            Cmd::Play { idx, .. } if idx < 1000 => Some(self),
            Cmd::Open { ref target } if ref_ok(target) => Some(self),
            Cmd::Pause { .. } | Cmd::Mute { .. } | Cmd::Skip | Cmd::Next | Cmd::Ok | Cmd::Back | Cmd::Key { .. } => Some(self),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(json: &str) -> bool {
        serde_json::from_str::<Cmd>(json).ok().and_then(Cmd::validate).is_some()
    }

    #[test]
    fn hotkeys_are_whitelisted() {
        for key in ["F1", "Shift+F1", "Ctrl+F12", "Ctrl+4", "t", "T", "u", "`", "q"] {
            assert!(ok(&format!(r#"{{"cmd":"hotkey","key":"{key}"}}"#)), "{key} should be allowed");
        }
        // Keys that are not in input.conf, or that try to smuggle in another mpv command.
        for key in ["F5", "Ctrl+F5", "Alt+F1", "x", "ctrl+f1", "F1; quit", "quit", "", "Ctrl+5"] {
            assert!(!ok(&format!(r#"{{"cmd":"hotkey","key":"{key}"}}"#)), "{key:?} should be rejected");
        }
    }
}
