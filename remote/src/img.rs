//! Artwork proxy: `GET /img?u=<url>&w=<px>`. Fetches from an allowlisted host, resizes, caches on disk.
//! The phone never talks to third-party image hosts and never downloads a 4K backdrop.
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use image::{imageops::FilterType, ImageFormat};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const CACHE_CAP: u64 = 300 * 1024 * 1024;
const CACHE_TRIM_TO: u64 = 240 * 1024 * 1024;
// Hosts the stock catalogs and Kai's metadata use. Extend via `kai-remote-hosts.txt` (one host per line).
const DEFAULT_HOSTS: [&str; 5] = [
    "images.metahub.space",
    "episodes.metahub.space",
    "image.tmdb.org",
    "live.metahub.space",
    "media.kitsu.app",
];

#[derive(Deserialize)]
pub struct ImgQuery {
    u: String,
    w: Option<u32>,
}

pub struct Img {
    client: reqwest::Client,
    dir: PathBuf,
    hosts: Arc<Vec<String>>,
    writes: AtomicUsize,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default()
}

fn host_allowed(hosts: &[String], url: &reqwest::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.port().is_none()
        && url.host_str().is_some_and(|h| hosts.iter().any(|a| a == h))
}

fn ext_for(ct: &str) -> &'static str {
    match ct {
        "image/png" => "png",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        _ => "jpg",
    }
}

fn ct_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

impl Img {
    pub fn new() -> Self {
        let mut hosts: Vec<String> = DEFAULT_HOSTS.iter().map(|s| s.to_string()).collect();
        if let Ok(extra) = std::fs::read_to_string(exe_dir().join("kai-remote-hosts.txt")) {
            hosts.extend(extra.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty() && !l.starts_with('#')));
        }
        let hosts = Arc::new(hosts);
        let policy_hosts = hosts.clone();
        // Redirects are re-checked against the allowlist, so an allowed host cannot bounce us elsewhere.
        let policy = reqwest::redirect::Policy::custom(move |a| {
            if a.previous().len() > 3 || !host_allowed(&policy_hosts, a.url()) {
                a.stop()
            } else {
                a.follow()
            }
        });
        let client = reqwest::Client::builder()
            .redirect(policy)
            .timeout(Duration::from_secs(15))
            .user_agent("KaiRemote/0.3")
            .build()
            .expect("http client");
        let dir = exe_dir().join("img-cache");
        let _ = std::fs::create_dir_all(&dir);
        Self { client, dir, hosts, writes: AtomicUsize::new(0) }
    }

    pub async fn serve(&self, q: ImgQuery) -> Response {
        match self.fetch(&q.u, q.w.unwrap_or(400).clamp(64, 1600)).await {
            Ok((bytes, ct)) => (
                [
                    (header::CONTENT_TYPE, ct),
                    (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                ],
                bytes,
            )
                .into_response(),
            Err(code) => code.into_response(),
        }
    }

    async fn fetch(&self, raw: &str, w: u32) -> Result<(Vec<u8>, &'static str), StatusCode> {
        let url = reqwest::Url::parse(raw).map_err(|_| StatusCode::BAD_REQUEST)?;
        if !host_allowed(&self.hosts, &url) {
            return Err(StatusCode::FORBIDDEN);
        }
        let key: String = Sha256::digest(format!("{url}|{w}")).iter().map(|b| format!("{b:02x}")).collect();
        for ext in ["jpg", "png", "svg", "webp"] {
            let p = self.dir.join(format!("{key}.{ext}"));
            if let Ok(bytes) = tokio::fs::read(&p).await {
                return Ok((bytes, ct_for(ext)));
            }
        }

        let mut resp = self.client.get(url).send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if !resp.status().is_success() {
            return Err(StatusCode::NOT_FOUND);
        }
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or("").trim().to_lowercase())
            .unwrap_or_default();
        if !ct.starts_with("image/") {
            return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| StatusCode::BAD_GATEWAY)? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_BYTES {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
        }

        let (out, out_ct) = if ct == "image/svg+xml" {
            (body, "svg")
        } else {
            let original_ext = ext_for(&ct);
            tokio::task::spawn_blocking(move || resize(body, w, original_ext)).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        };
        let _ = tokio::fs::write(self.dir.join(format!("{key}.{out_ct}")), &out).await;
        if self.writes.fetch_add(1, Ordering::Relaxed) % 40 == 39 {
            let dir = self.dir.clone();
            tokio::task::spawn_blocking(move || trim(&dir));
        }
        Ok((out, ct_for(out_ct)))
    }
}

/// Returns the (possibly downscaled) bytes and their extension. Undecodable formats pass through unchanged.
fn resize(body: Vec<u8>, w: u32, original_ext: &'static str) -> (Vec<u8>, &'static str) {
    let Ok(img) = image::load_from_memory(&body) else { return (body, original_ext) };
    let img = if img.width() > w { img.resize(w, u32::MAX, FilterType::Lanczos3) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    if img.color().has_alpha() {
        if img.write_to(&mut out, ImageFormat::Png).is_ok() {
            return (out.into_inner(), "png");
        }
    } else if img.to_rgb8().write_to(&mut out, ImageFormat::Jpeg).is_ok() {
        return (out.into_inner(), "jpg");
    }
    (body, original_ext)
}

/// Drop the oldest cache files once the folder exceeds the cap.
fn trim(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok().map(|m| (e.path(), m.len(), m.modified().ok())))
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= CACHE_CAP {
        return;
    }
    files.sort_by_key(|f| f.2);
    for (p, len, _) in files {
        if total <= CACHE_TRIM_TO {
            break;
        }
        if std::fs::remove_file(p).is_ok() {
            total -= len;
        }
    }
}
