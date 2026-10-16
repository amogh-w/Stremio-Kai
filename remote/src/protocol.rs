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
            Cmd::Video { ref id } if video_id_ok(id) => Some(self),
            Cmd::Play { idx, .. } if idx < 1000 => Some(self),
            Cmd::Open { ref target } if ref_ok(target) => Some(self),
            Cmd::Pause { .. } | Cmd::Mute { .. } | Cmd::Skip | Cmd::Next | Cmd::Ok | Cmd::Back | Cmd::Key { .. } => Some(self),
            _ => None,
        }
    }
}
