//! Artwork proxy: `GET /img?u=<url>&w=<px>`. Fetches from an allowlisted host, resizes, caches on disk.
//! The phone never talks to third-party image hosts and never downloads a 4K backdrop.
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use image::{imageops::FilterType, ImageFormat};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    net::IpAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const CACHE_CAP: u64 = 300 * 1024 * 1024;
const CACHE_TRIM_TO: u64 = 240 * 1024 * 1024;
// Well-known artwork hosts. On top of these, any host that appears in the poster/background/logo/thumbnail of data the
// PC itself is showing is learned at runtime (see `learn_from`). Extend by hand via `kai-remote-hosts.txt` (one per line).
const DEFAULT_HOSTS: [&str; 13] = [
    "images.metahub.space",
    "episodes.metahub.space",
    "live.metahub.space",
    "image.tmdb.org",
    "media.kitsu.app",
    "media.kitsu.io",
    "kitsu-production-media.s3.us-west-002.backblazeb2.com",
    "cdn.myanimelist.net",
    "s4.anilist.co",
    "artworks.thetvdb.com",
    "assets.fanart.tv",
    "m.media-amazon.com",
    "static.tvmaze.com",
];
const MAX_LEARNED: usize = 300;

#[derive(Deserialize)]
pub struct ImgQuery {
    u: String,
    w: Option<u32>,
}

pub struct Img {
    client: reqwest::Client,
    dir: PathBuf,
    hosts: Arc<Vec<String>>,
    learned: Arc<Mutex<HashSet<String>>>,
    writes: AtomicUsize,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default()
}

fn host_allowed(hosts: &[String], learned: &Mutex<HashSet<String>>, url: &reqwest::Url) -> bool {
    // `domain()` is None for an IP-address host, so URLs like http://192.168.1.1/ or http://[::1]/ are never fetched.
    matches!(url.scheme(), "http" | "https")
        && url.port().is_none()
        && url.domain().is_some_and(|d| hosts.iter().any(|a| a == d) || learned.lock().unwrap().contains(d))
}

/// False for loopback, private, link-local, CGNAT, multicast and other non-routable addresses.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(m));
            }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// DNS for the image client: only public addresses come back, on the first request and on every redirect hop.
struct PublicOnly;
impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<std::net::SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| is_public_ip(a.ip())).collect();
            if addrs.is_empty() {
                return Err("host does not resolve to a public address".into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
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
        let learned: Arc<Mutex<HashSet<String>>> = Arc::default();
        let (policy_hosts, policy_learned) = (hosts.clone(), learned.clone());
        // Redirects are re-checked against the allowlist, so an allowed host cannot bounce us elsewhere.
        let policy = reqwest::redirect::Policy::custom(move |a| {
            if a.previous().len() > 3 || !host_allowed(&policy_hosts, &policy_learned, a.url()) {
                a.stop()
            } else {
                a.follow()
            }
        });
        let client = reqwest::Client::builder()
            .redirect(policy)
            .dns_resolver(Arc::new(PublicOnly))
            .timeout(Duration::from_secs(15))
            .user_agent("KaiRemote/0.3")
            .build()
            .expect("http client");
        let dir = exe_dir().join("img-cache");
        let _ = std::fs::create_dir_all(&dir);
        Self { client, dir, hosts, learned, writes: AtomicUsize::new(0) }
    }

    /// Remembers the image hosts found in a message from the bridge (poster, background, logo, thumbnail fields).
    /// The data is what the PC itself is displaying, so those hosts are artwork hosts; only domains are kept, and
    /// anything that resolves to a non-public address is refused at fetch time by `PublicOnly`.
    pub fn learn_from(&self, v: &Value) {
        fn walk(v: &Value, out: &mut Vec<String>) {
            match v {
                Value::Object(m) => {
                    for (k, x) in m {
                        if matches!(k.as_str(), "poster" | "background" | "logo" | "thumbnail") {
                            if let Some(s) = x.as_str() {
                                out.push(s.to_string());
                            }
                        } else {
                            walk(x, out);
                        }
                    }
                }
                Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
                _ => {}
            }
        }
        let mut urls = Vec::new();
        walk(v, &mut urls);
        let mut set = self.learned.lock().unwrap();
        for u in urls {
            if let Ok(url) = reqwest::Url::parse(&u) {
                if matches!(url.scheme(), "http" | "https") && url.port().is_none() {
                    if let Some(d) = url.domain() {
                        if set.len() < MAX_LEARNED {
                            set.insert(d.to_string());
                        }
                    }
                }
            }
        }
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
        if !host_allowed(&self.hosts, &self.learned, &url) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ip(s: &str) -> bool {
        is_public_ip(s.parse().unwrap())
    }

    #[test]
    fn only_public_addresses_are_fetchable() {
        for a in ["8.8.8.8", "151.101.1.1", "2606:4700:4700::1111"] {
            assert!(ip(a), "{a} is public");
        }
        for a in ["127.0.0.1", "10.0.0.5", "192.168.178.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:192.168.1.1"] {
            assert!(!ip(a), "{a} must be refused");
        }
    }

    #[test]
    fn hosts_are_learned_from_artwork_fields_only() {
        let img = Img::new();
        img.learn_from(&json!({
            "k": "home",
            "home": { "rows": [{ "items": [{ "poster": "https://CDN.Example.org/p.jpg", "name": "https://not-art.example/x" }] }],
                      "hero": [{ "background": "https://bg.example.net/b.jpg", "logo": "http://insecure.example.com/l.png" }] }
        }));
        let set = img.learned.lock().unwrap();
        assert!(set.contains("cdn.example.org") && set.contains("bg.example.net") && set.contains("insecure.example.com"));
        assert!(!set.contains("not-art.example"), "only poster/background/logo/thumbnail count");
    }

    #[test]
    fn ip_literals_and_ports_are_never_allowed() {
        let img = Img::new();
        img.learn_from(&json!({ "poster": "http://127.0.0.1/a.jpg", "logo": "https://host.example:8443/l.png", "background": "http://[::1]/b.jpg" }));
        let (h, l) = (&img.hosts, &img.learned);
        for u in ["http://127.0.0.1/a.jpg", "http://[::1]/b.jpg", "https://host.example:8443/l.png", "ftp://images.metahub.space/x"] {
            assert!(!host_allowed(h, l, &reqwest::Url::parse(u).unwrap()), "{u} must be refused");
        }
        assert!(host_allowed(h, l, &reqwest::Url::parse("https://images.metahub.space/poster/small/tt1/img").unwrap()));
        assert!(host_allowed(h, l, &reqwest::Url::parse("https://kitsu-production-media.s3.us-west-002.backblazeb2.com/a.jpg").unwrap()));
    }
}
