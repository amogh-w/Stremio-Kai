//! Shared state and the two websocket loops (bridge <-> daemon <-> phones).
use crate::protocol::Cmd;
use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::broadcast;

#[derive(Default)]
struct Snapshot {
    props: Map<String, Value>,
    now: Value,
    route: String,
    home: Value,
    detail: Value,
    rev: u64,
}

pub struct App {
    pub token: String,
    snap: Mutex<Snapshot>,
    pub img: crate::img::Img,
    bridges: AtomicUsize,
    to_phones: broadcast::Sender<String>,
    to_bridge: broadcast::Sender<String>,
}

impl App {
    pub fn new(token: String) -> Self {
        Self {
            token,
            snap: Mutex::default(),
            img: crate::img::Img::new(),
            bridges: AtomicUsize::new(0),
            to_phones: broadcast::channel(256).0,
            to_bridge: broadcast::channel(64).0,
        }
    }

    fn bridge_up(&self) -> bool {
        self.bridges.load(Ordering::SeqCst) > 0
    }

    fn snapshot_msg(&self) -> String {
        let s = self.snap.lock().unwrap();
        json!({ "k": "snapshot", "bridge": self.bridge_up(), "props": s.props, "now": s.now, "route": s.route, "home": s.home, "detail": s.detail, "rev": s.rev }).to_string()
    }

    fn announce_bridge(&self) {
        let _ = self.to_phones.send(json!({ "k": "bridge", "up": self.bridge_up() }).to_string());
    }
}

pub async fn bridge(app: Arc<App>, mut ws: WebSocket) {
    app.bridges.fetch_add(1, Ordering::SeqCst);
    app.announce_bridge();
    println!("[bridge] connected");
    let mut rx = app.to_bridge.subscribe();
    loop {
        tokio::select! {
            msg = ws.recv() => match msg {
                Some(Ok(Message::Text(t))) => ingest(&app, t.as_str()),
                Some(Ok(_)) => {}
                _ => break,
            },
            out = rx.recv() => match out {
                Ok(m) => { if ws.send(Message::Text(m.into())).await.is_err() { break; } }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            },
        }
    }
    if app.bridges.fetch_sub(1, Ordering::SeqCst) == 1 {
        let mut s = app.snap.lock().unwrap();
        s.props.clear();
        s.now = Value::Null;
        s.home = Value::Null;
        s.detail = Value::Null;
        s.route.clear();
    }
    app.announce_bridge();
    println!("[bridge] disconnected");
}

/// Update the cached snapshot from a bridge message and fan it out to the phones unchanged.
fn ingest(app: &App, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    // The stream link for "Copy stream link": goes to the PC clipboard, never to phones, never stored.
    if v.get("k").and_then(Value::as_str) == Some("clip") {
        let link = v.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        let tx = app.to_phones.clone();
        std::thread::spawn(move || {
            let ok = crate::clip::set_clipboard(&link);
            let msg = if ok { "Stream link copied on the PC" } else { "Could not copy the link on the PC" };
            let _ = tx.send(json!({ "k": "result", "action": "copy", "ok": ok, "msg": msg }).to_string());
        });
        return;
    }
    // Image hosts the PC is showing become fetchable through /img (public addresses only, see img.rs).
    if matches!(v.get("k").and_then(Value::as_str), Some("home" | "detail" | "now")) {
        app.img.learn_from(&v);
    }
    {
        let mut s = app.snap.lock().unwrap();
        match v.get("k").and_then(Value::as_str) {
            Some("prop") => {
                if let Some(name) = v.get("name").and_then(Value::as_str) {
                    s.props.insert(name.to_string(), v.get("data").cloned().unwrap_or(Value::Null));
                }
            }
            Some("now") => s.now = v.get("now").cloned().unwrap_or(Value::Null),
            Some("detail") => {
                s.detail = v.get("detail").cloned().unwrap_or(Value::Null);
                s.rev = v.get("rev").and_then(Value::as_u64).unwrap_or(0);
            }
            Some("home") => s.home = v.get("home").cloned().unwrap_or(Value::Null),
            Some("route") => s.route = v.get("hash").and_then(Value::as_str).unwrap_or("").to_string(),
            Some("blocked") | Some("result") | Some("url") => {} // forwarded as is, nothing cached ("url" is filtered per phone)
            _ => return,
        }
    }
    let _ = app.to_phones.send(text.to_string());
}

/// A stream-link answer goes only to the phone that asked for it (matched by request id), once.
fn take_if_mine(msg: &str, pending: &mut HashSet<String>) -> bool {
    serde_json::from_str::<Value>(msg)
        .ok()
        .and_then(|v| v.get("rid").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|rid| pending.remove(&rid))
}

pub async fn phone(app: Arc<App>, mut ws: WebSocket) {
    let mut pending: HashSet<String> = HashSet::new();
    if ws.send(Message::Text(app.snapshot_msg().into())).await.is_err() {
        return;
    }
    let mut rx = app.to_phones.subscribe();
    loop {
        tokio::select! {
            msg = ws.recv() => match msg {
                Some(Ok(Message::Text(t))) => {
                    if let Some(cmd) = serde_json::from_str::<Cmd>(t.as_str()).ok().and_then(Cmd::validate) {
                        if let Cmd::More { action, rid: Some(rid) } = &cmd {
                            if action == "url" {
                                if pending.len() >= 8 { pending.clear(); }
                                pending.insert(rid.clone());
                            }
                        }
                        let _ = app.to_bridge.send(serde_json::to_string(&cmd).unwrap());
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            },
            out = rx.recv() => match out {
                Ok(m) => {
                    if m.contains("\"k\":\"url\"") && !take_if_mine(&m, &mut pending) { continue; }
                    if ws.send(Message::Text(m.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if ws.send(Message::Text(app.snapshot_msg().into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_answers_reach_only_the_phone_that_asked() {
        let mut mine: HashSet<String> = ["abcdef0123456789".to_string()].into();
        let mut other: HashSet<String> = ["ffffffff00000000".to_string()].into();
        let msg = r#"{"k":"url","rid":"abcdef0123456789","text":"https://x.invalid/s"}"#;
        assert!(!take_if_mine(msg, &mut other), "another phone must not get the link");
        assert!(take_if_mine(msg, &mut mine), "the asking phone gets it");
        assert!(!take_if_mine(msg, &mut mine), "and only once");
        assert!(!take_if_mine(r#"{"k":"url","text":"no rid"}"#, &mut mine), "an answer without an id goes nowhere");
    }
}
