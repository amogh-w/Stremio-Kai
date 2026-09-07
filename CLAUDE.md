# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Stremio Kai is a customized, portable Windows build of Stremio Community Edition (the WebView2 + MPV fork by
`Zaarrg/stremio-community-v5`). **This repo does not contain the Stremio or MPV binaries, the C++ shell, the
bundled `python.exe`, VapourSynth/SVP, or the Anime4K `shaders/` directory** — those ship only in the released
portable archive / installer. What is version-controlled here is the customization layer that gets dropped into
that build's `portable_config/`, plus the GitHub Pages site under `docs/`.

There is **no build system, package manager, test suite, or linter config**. Changes are validated by running an
actual Stremio Kai install with this `portable_config/` in place and watching the DevTools console (webmods) and
`portable_config/LOG.txt` / mpv console (Lua). Releases are produced out-of-band by the maintainer.

## Two runtimes, one bridge

Everything here runs in one of two environments:

1. **MPV Lua scripts** (`portable_config/scripts/`, `script-opts/`, `mpv.conf`, `input.conf`) — the player.
2. **Browser "webmods"** (`portable_config/webmods/`) — plain ES5/ES6 IIFE scripts injected into Stremio's web UI
   (React app with obfuscated hashed class names like `.section-container-twzKQ`). No bundler, no modules; scripts
   register themselves on `window.*` global namespaces and poll/`MutationObserver` for readiness.

The two sides talk through the C++ shell:

- **JS → MPV:** `window.chrome.webview.postMessage(...)` → C++ → mpv `script-message`. See
  `webmods/Metadata/Services/mpv-bridge.js` (sends `content-metadata`, track-selector config) consumed by
  `scripts/notify_skip/main.lua` and `scripts/smart-track-selector/main.lua` / `profile-manager.lua`.
- **MPV → network:** Lua has no CORS but also no HTTP client, so it shells out to the bundled `python.exe`
  (`command_native_async` + inline `urllib` snippets) — e.g. IntroDB fetches in `notify_skip/main.lua`.
- **JS ↔ JS:** modules coordinate via `window` namespaces, `CustomEvent`s (`metadata-modules-ready`,
  `kai-settings-changed`), and readiness flags (`window.MetadataModules.ready`).

## Settings model

All user configuration lives in the web UI, not config files. `webmods/Settings/mpv-settings.js` and
`Settings/api-keys.js` **inject custom controls into Stremio's own Settings page DOM** by matching section labels
("Player", "Audio", "Subtitles", "Advanced") and cloning Stremio's hashed CSS classes. This injection is inherently
fragile against upstream Stremio UI changes — expect to re-check selectors when rebasing on a new
community-v5 version.

- Values are stored in `localStorage` under `kai-*` keys (see `STORAGE_KEYS` in `mpv-settings.js`).
- On change, handlers call `sendConfigUpdate()` which dispatches `window` event `kai-settings-changed`;
  `mpv-bridge.js` and others listen and push the new state to the relevant Lua script.
- `.conf` files in `script-opts/` are fallback defaults only; the UI-driven `localStorage` state wins at runtime.

## MPV playback pipeline

`mpv.conf` holds only **static baseline** render settings plus thin base profiles (`[sdr]`, `[anime-sdr]`).
Everything content-dependent is applied dynamically at runtime by `scripts/profile-manager.lua`:

1. Base profile chosen (SDR vs anime-SDR).
2. HDR layer — tonemap-to-SDR *or* passthrough (mutually exclusive, driven by the `kai-hdr-*` settings).
3. Anime layer — Anime4K GLSL shader preset + video-filter chain (hqdn3d, SVP interpolation via
   `svp_*.vpy` / `svp_cleanup.lua`).
4. Dynamic OSD "now playing" message.

Anime detection is layered: JS side (`webmods/Metadata/Utils/anime-detection.js`) uses metadata-DB tiers and tells
Lua; `profile-manager.lua` additionally matches release-group names in the filename against a large curated list.
`input.conf` exposes the raw shader/filter presets on F-keys for manual override; `scripts/reactive_vf_bypass.lua`
keeps the VF chain from fighting user toggles. `scripts/thumbfast.lua` powers seekbar thumbnail previews.

## Notify Skip (`scripts/notify_skip/`)

Modular intro/outro skipper; `main.lua` is a pure orchestrator wiring 10 modules under `modules/`. Hybrid strategy:
embedded/named **chapters** provide skip targets with a confidence rating (HIGH pattern-matched → instant,
MEDIUM/LOW → needs confirmation), while audio-silence / black-frame **filters** detect boundaries when chapters are
absent or vague. IntroDB (`api.introdb.app`) is queried async (via `python.exe`) for crowd-sourced segment
timestamps, which take priority over local chapters and are injected as virtual chapters. Web overlay skip button
sends the `perform-skip` script-message back into Lua.

## Metadata system (`webmods/Metadata/`)

Loaded strictly in order by `bootstrapper.js` (`requiredModules` array) — add new modules to that list.
`config.js` lazy-loads Dexie; `main.js` splits a persistent `PersistentCore` (fetchers, rate limiter, ID
conversion, Dexie/IndexedDB storage) from a transient `TransientUI` (DOM title processing, hover popups) that is
destroyed/recreated on route changes. Fetchers: `tmdb-fetcher.js`, `mdblist-fetcher.js`, `metadata-fetcher.js`,
`title-search.js`; cross-source ID resolution in `Utils/id-lookup.js` / `id-conversion.js`. All external calls go
through `Services/rate-limiter.js`. Optional user TMDB / MDBList API keys come from `Services/api-keys.js`.
`window.metadataHelper` / `window.metadataStorage` are the public surface other webmods (Hero Banner, mpv-bridge)
depend on after the `metadata-modules-ready` event.

## Phone Remote (`remote/`, `scripts/remote-control/`, `webmods/Remote/`)

LAN remote control. A stdlib-only Python server (`portable_config/remote/server.py`, spawned +
supervised by `scripts/remote-control/main.lua` using the notify_skip subprocess pattern) is the hub:

- **phone ↔ server** over HTTP — `GET /` serves the single-file mobile app (`remote/webapp/index.html`,
  read from disk per request), `GET /events` streams merged state as SSE, `POST /cmd` takes commands,
  `GET /healthz` feeds the Settings URL readout. `GET /poll` is a long-poll fallback.
- **server ↔ mpv** over the `\\.\pipe\kai-mpv` named pipe (enabled by `input-ipc-server` in `mpv.conf`,
  via ctypes `CreateFileW` on Windows) — real playback state via `observe_property`, plus all transport
  commands (`MPV_COMMANDS` table in server.py). Default HTTP port is **5000**.
- **server ↔ webmod** — `webmods/Remote/remote-client.js` long-polls `GET /webmod/poll` for commands mpv
  IPC can't do (route nav, catalog/episode/stream scraping, synthetic events, stream launch) and POSTs
  `RouteDetector` state + scraped lists to `POST /webmod/state`. Actuation lives in `actuators.js`
  (adapted from `navigation.js`), scraping in `scrapers.js`, and **every hashed class name is isolated in
  `selectors.js`** — re-verify it on each community-v5 rebase.

Config: the "Phone Remote" section in `webmods/Settings/remote-settings.js` writes `kai-remote-*`
localStorage keys; `remote-client.js` pushes them to the Lua supervisor via a `script-message
remote-control-config` on `kai-settings-changed`. `script-opts/remote_control.conf` holds cold defaults
(incl. a `python_path=` override — the Lua resolves `python.exe` via `utils.getcwd()` + walk-up, which
fails when `portable_config` is a junction/symlink to a checkout). The C++ shell auto-loads
`webmods/Remote/` like other feature folders (confirmed working); if a future build stops, relocate
those files under `webmods/Utilities/`.

Command routing (the three paths a `POST /cmd` takes - mpv pipe vs. real
`SendInput` keystroke vs. webmod queue): `portable_config/remote/COMMANDS.md`.
Manual rollout/test checklist: `portable_config/remote/CHECKLIST.md`.

## Other webmod groups

- `webmods/UI/Hero Banner/` — namespaced (`window.HeroPlugin.*`) rotating hero banner; waits on both its own
  modules and `MetadataModules.ready`. Catalog sources incl. MDBList in `modules/catalog-service.js`.
- `webmods/UI/` — standalone features: `details-enhancer`, `hover-popup`, `seekbar-hover-time`,
  `player-clock-eta`, `update-notification`, `welcome-wizard` (first-run setup), `donation-manager`.
- `webmods/Theme/*.css` — per-page restyle (Main, Discover, Board, Library, Calendar, Episodes, Settings, Addons).
- `webmods/Settings/` — `oled-theme-toggle`, `auto-fullscreen`, `custom-shortcuts`, `enhanced-metadata`.
- `webmods/Utilities/navigation.js` — auto-hide sidebar/search.

## Conventions

- Every webmod is a self-invoking function with an idempotency guard (`if (window.Foo?.initialized) return;`).
- Prefer namespace registration + a bootstrapper polling loop over assuming load order.
- Each script carries a `@version` + `@changelog` header block — bump it when changing behavior.
- Lua modules use `require('modules/x')`; `main.lua` injects `package.path` from `debug.getinfo` at the top.
- `docs/` is a static site (plain HTML/CSS/JS, `changelog.js` renders `changelog.html`) served via GitHub Pages;
  unrelated to the app runtime.
