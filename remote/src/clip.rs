//! Puts text on the PC clipboard. The stream link goes bridge -> daemon over loopback only and is never
//! sent to a phone, and it is never logged.

/// Accepts only http(s) and magnet links of sane length; returns whether the clipboard was set.
pub fn set_clipboard(text: &str) -> bool {
    let t = text.trim();
    let ok_scheme = t.starts_with("http://") || t.starts_with("https://") || t.starts_with("magnet:");
    if t.is_empty() || t.len() > 8192 || !ok_scheme {
        return false;
    }
    #[cfg(windows)]
    {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        // clip.exe ships with Windows and reads the clipboard text from stdin. Links are plain ASCII.
        let Ok(mut child) = Command::new("clip").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(t.as_bytes()).is_err() {
                return false;
            }
        }
        child.wait().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::set_clipboard;

    #[test]
    fn rejects_unsafe_input_without_touching_the_clipboard() {
        assert!(!set_clipboard(""));
        assert!(!set_clipboard("   "));
        assert!(!set_clipboard("calc.exe"));
        assert!(!set_clipboard("file:///C:/Windows/System32"));
        assert!(!set_clipboard(&format!("https://x/{}", "a".repeat(9000))));
    }
}
