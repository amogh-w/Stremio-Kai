//! Pairing token + request guard. The phone gets an HttpOnly cookie after opening `/?t=<token>` once.
use crate::relay::App;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{net::SocketAddr, sync::Arc};

const COOKIE: &str = "kai_remote";
const BRIDGE_ORIGINS: [&str; 3] = [
    "https://stremio.zarg.me",
    "https://zaarrg.github.io",
    "https://web.stremio.com",
];

fn token_path() -> std::path::PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
    dir.join("kai-remote.token")
}

pub fn load_or_create_token() -> String {
    let path = token_path();
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return t;
        }
    }
    let bytes: [u8; 16] = rand::random();
    let t: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let _ = std::fs::write(&path, &t);
    t
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub async fn guard(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    // The bridge lives inside the Stremio page: loopback peer and a known web UI origin only,
    // so a random website open in a PC browser cannot drive the app through this socket.
    if req.uri().path() == "/bridge" {
        let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
        if peer.ip().is_loopback() && BRIDGE_ORIGINS.contains(&origin) {
            return next.run(req).await;
        }
        return StatusCode::FORBIDDEN.into_response();
    }

    let has_cookie = req
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == COOKIE && ct_eq(v, &app.token));
    if has_cookie {
        return next.run(req).await;
    }

    let query_ok = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("t=")))
        .is_some_and(|t| ct_eq(t, &app.token));
    if query_ok {
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, req.uri().path())
            .header(header::SET_COOKIE, format!("{COOKIE}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000", app.token))
            .body(axum::body::Body::empty())
            .unwrap();
    }
    (StatusCode::UNAUTHORIZED, "Not paired. Scan the QR code shown in the Kai Remote console.").into_response()
}
