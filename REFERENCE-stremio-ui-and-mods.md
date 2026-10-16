# Stremio Kai v4.8.0 - Reverse Engineering Reference

Purpose: a self-contained reference for building a companion remote (Rust daemon + phone UI + a bridge webmod) for Stremio Kai. Everything here was derived by reading the files in this bundle: `stremio.exe` strings, `server.js`, `portable_config/` (mpv config, Lua scripts, webmods). Nothing was executed.

## 0. Confidence legend

- **[CONFIRMED]** read directly in a file or in strings extracted from a binary.
- **[INFERRED]** reasoned from confirmed facts, not observed at runtime.
- **[SOURCE]** verified against public source code or the live web bundle (see section 13 for the exact URLs). Treat as authoritative unless the shipped exe differs; the bundled exe is version 5.0.21.
- **[UNKNOWN]** needs a runtime test (see section 12).

The Stremio web UI itself is NOT in this bundle. The shell loads it from `https://stremio.zarg.me/` first (see 1). Its DOM, routes and class names below were first reconstructed from what the mods select, then cross-checked against the live CSS bundle (section 4.2). Treat the DOM map as "what Kai depends on", not as a full site map.

Sections 2A, 13, 14 and 15 were added after reading the shell's C++ source, the stremio-web source and the live web bundles; where they disagree with earlier text, they win. Section 15 covers artwork, banners and content data (posters, backgrounds, logos, hero list, the app's core state). The corrected statements are marked "(corrected)".

---

## 1. Architecture

```
stremio.exe  v5.0.21 (native WebView2 shell, community build by Zaarrg)   [CONFIRMED strings]
              source: github.com/Zaarrg/stremio-community-v5 (older name stremio-desktop-v5)   [SOURCE]
 |- Edge WebView2 runtime (bundled, portable_config/EdgeWebView, Edge 131)
 |    '- loads https://stremio.zarg.me/  (first reachable of 3 URLs, or --webui-url=...)  [SOURCE]
 |         = Zaarrg's patched build of stremio-web (build id 6f6b0558dbb0...), not web.stremio.com
 |         + window.qt shim (QWebChannel emulation)
 |         + webmods injected from portable_config/webmods
 |- libmpv-2.dll  (player; created in-process by the shell, not a child process)
 |- stremio-runtime.exe server.js   (child process, Node 18.12.1, Stremio streaming server)
 |- Discord RPC over \\?\pipe\discord-ipc-0 (settings: DiscordRPC=1)
 '- stremio-settings.ini  (window state + a few flags)
```

Other facts:

- Single-instance mutex: `SingleInstanceMtx_StremioWebShell`; falls back to multi-instance if mutex creation fails.
- Handles `stremio://` and `magnet:` URLs and file drops (`FileDropped`, `SubtitleDropped`, `OpenTorrent`).
- Command-line flags seen in strings: `--streaming-server-disabled`, `--webui-url=`, `--autoupdater-endpoint=`.
- (corrected) The shell checks the web UI endpoints in this order and uses the first reachable one [SOURCE `globals.cpp`]: `https://stremio.zarg.me/`, `https://zaarrg.github.io/stremio-web-shell-fixes/`, `https://web.stremio.com/`. The first two serve the identical Zaarrg build; `web.stremio.com` is the official site, which is a different, newer web build (section 13.3). If nothing responds it retries with growing delays (5 s up, x1.25, cap 60 s, 10 attempts) and then shows "Web page could not be loaded" and exits.
- User agent is `StremioShell/<APP_VERSION>`, DevTools are disabled in release builds, browser accelerator keys are off, zoom is off unless `AllowZoom=1`.
- The shell can add Edge browser extensions from `portable_config/extensions` (index fetched from the Zaarrg GitHub repo, `extensions/extensions.json`).
- The updater is `updater.bat`, which runs `updater.ps1` (not present in this bundle).

---

## 2. Shell <-> web transport (the single most important interface)

### 2.1 The Qt shim [CONFIRMED]

The shell injects this into the top frame at document creation (condensed from the string in `stremio.exe`):

```js
if (window.self === window.top && !window.qt) {
  window.qt = {
    webChannelTransport: {
      send: window.chrome.webview.postMessage,      // reference captured here
      onmessage: (ev) => { /* overwritten by the web app's QWebChannel */ }
    }
  };
  window.chrome.webview.addEventListener('message', (ev) => {
    window.qt.webChannelTransport.onmessage(ev);
  });
  window.onload = () => { try { initShellComm(); } catch (e) { /* posts app-error */ } };
}
```

So the stock Stremio web app believes it runs inside the Qt shell and talks QWebChannel. Messages use the QWebChannel wire format, with `object:"transport"`.

### 2.2 Page -> native envelope [CONFIRMED]

```json
{ "type": 6, "object": "transport", "method": "handleInboundJSON", "id": 999,
  "args": [ "<event-name>", [ <params...> ] ] }
```

`type: 6` is QWebChannel `InvokeMethod`. Sent with `window.chrome.webview.postMessage(JSON.stringify(msg))`. Kai's own mods send exactly this (`mpv-bridge.js:58`, `navigation.js:962`).

(corrected) The complete page -> native event list is in section 2A.3; it was read from the shell source (`HandleEvent` in `src/ui/mainwindow.cpp`), so the earlier "UNKNOWN" is resolved. The shell parses `args[1]` as either an array (each element becomes one string argument; non-strings are `dump()`ed JSON text) or a single string/value (one argument). Both `ipc.send('mpv-observe-prop', 'time-pos')` and `ipc.send('mpv-command', ['stop'])` are valid.

### 2.3 Native -> page [SOURCE]

(corrected) Native -> page messages are built by `SendToJS(name, data)` and posted with `PostWebMessageAsString`, so `ev.data` in a `chrome.webview` `message` listener is a JSON **string** that you must `JSON.parse`:

```json
{ "type": 1, "object": "transport", "id": 17, "args": [ "mpv-prop-change", { "type": "mpv-prop-change", "id": 0, "name": "time-pos", "data": 123.456 } ] }
```

Names, payloads and the handshake are in 2A.

### 2.4 libmpv setup done by the shell [CONFIRMED strings]

Options set at `mpv_create`: `config-dir` (portable_config), `load-scripts`, `config` (so `mpv.conf`, `input.conf` and Lua scripts are loaded), `terminal`, `msg-level all=v`, `vo=gpu-next`, `demuxer-lavf-probesize` (524288), `demuxer-lavf-analyzeduration`, `demuxer-max-bytes`, `demuxer-max-packets`, `cache-pause`, `cache-secs`, `vd-lavc-threads`, `ad-lavc-threads`, `audio-fallback-to-null`, `audio-client-name`. On `EVENT_SHUTDOWN` the shell terminates. libmpv imports used: `mpv_create`, `mpv_initialize`, `mpv_set_option(_string)`, `mpv_command(_string)`, `mpv_set_property_string`, `mpv_observe_property`, `mpv_wait_event`, `mpv_set_wakeup_callback`, `mpv_terminate_destroy`.

Implication: because `config` is on, an `input-ipc-server=` line in `mpv.conf` is a candidate for a second control channel. [UNKNOWN] whether libmpv honours it (the IPC server is part of mpv's player core, so likely yes).

### 2.5 Important consequences

1. **Patching `chrome.webview.postMessage` does not intercept UI traffic**, because the shim saved a reference to the original function in `qt.webChannelTransport.send` [SOURCE]. And the zarg page calls `a.send(JSON.stringify(e))` on that object for every message [SOURCE, bundle module 43415]. To observe UI -> native messages, replace `window.qt.webChannelTransport.send`. Because mods now run at document creation (section 3), you can do this before the page grabs the transport.
2. To observe native -> UI messages, add your own `chrome.webview.addEventListener('message', fn)` and `JSON.parse(ev.data)`. The page does the same through `qt.webChannelTransport.onmessage`, which the shim forwards to; do not overwrite `onmessage` (the page assigns it during the handshake).
3. To *send* commands as if from the UI, call `chrome.webview.postMessage(JSON.stringify({type:6, object:"transport", method:"handleInboundJSON", args:[...]}))` directly. Kai already does this. The `method` field is mandatory: the shell ignores type-6 messages without it ("Unknown Inbound event").
4. In this shell the video is rendered by mpv, not an HTML `<video>`. Mods that look for `<video>` fall back to reading seek-bar labels (see section 5.2). A remote should take time/duration/pause from `mpv-prop-change`, not from the DOM.
5. **Do not overwrite `window.onload`.** The shim sets it to call `initShellComm()`, which is what tells the page that the shell exists. Use `addEventListener('load', ...)` in mods.
6. The shim script runs again on `ContentLoading`, `DOMContentLoaded` and `NavigationCompleted`; it is guarded by `!window.qt`, so it is a no-op after the first run per document.

---

## 2A. Verified protocol (shell source + web bundle) [SOURCE]

### 2A.1 Handshake (zarg web build, bundle module 43415)

1. Shell injects the `window.qt` shim at document creation; on `window.onload` the shim calls `initShellComm()`, which the page defined to emit `availabilityChanged`.
2. Page sends `{"type":3,"id":0}` (INIT).
3. Shell answers (id 0), built in `HandleInboundJSON`:
   ```json
   { "id": 0, "data": { "transport": {
       "properties": [ 1, [0,"shellVersion",0,"5.0.21"], [0,"BrowserExtensions",0,{"<folder>":"<edge-extension-id>"}] ],
       "signals":    [ [0,"handleInboundJSONSignal"] ],
       "methods":    [ ["onEvent","handleInboundJSON"] ] } } }
   ```
   The page reads `properties.slice(1)` into a map (`e[1]` name, `e[3]` value), so `shellVersion` and `BrowserExtensions` are the only props.
4. Page sends one `{"type":7,"object":"transport","signal":<index>}` per signal (connect), then calls `send("app-ready", {})`.
5. `app-ready` makes the shell set `g_isAppReady`, hide the splash, and flush queued messages (for example a launch `stremio://` URL).
6. From then on: page -> native is `{type:6, object:"transport", method:"handleInboundJSON", id:n, args:[eventName, params]}`; native -> page is `{type:1, object:"transport", id:n, args:[eventName, data]}`.

A remote bridge normally does not need to repeat the handshake. It only needs to send type-6 messages after `app-ready` and parse type-1 messages.

### 2A.2 Native -> page events (what the shell emits)

| Event (`args[0]`) | `args[1]` payload | Source |
|---|---|---|
| `mpv-prop-change` | `{type, id: 0, name, data, error?}`. `data` is JSON-typed (number, bool, string, array, object) because every property is observed as `MPV_FORMAT_NODE`; null when unavailable | `player.cpp` |
| `mpv-event-ended` | `{type, reason: "quit"\|"error", error?: "Capitalized mpv error"}`. EOF is reported as `"quit"`. Other end reasons (stop, redirect) send nothing | `player.cpp` |
| `mpv-event-video-ready` | `{loadId, ready}` in newer shells (web code handles it; not in 5.0.21) | web `ShellVideo.js` |
| `MpvCommandBlocked` / `MpvSetPropBlocked` | `{command, full}` / `{prop, value}` in shells with the allowlist (see 2A.5) | `mainwindow.cpp` |
| `OpenTorrent` | `{magnet}` or `{data:[bytes]}` | `WM_COPYDATA` |
| `OpenFile` | `{path}` | file launch/drop |
| `FileDropped`, `SubtitleDropped` | `{path}` | drag and drop |
| `ReplaceLocation` | `{path: "stremio://detail/..."}` | protocol launch |
| `AddonInstall` | `{path: "stremio://..."}` | protocol launch |
| `ServerStarted` | handled by the zarg page (shell source did not show where it is emitted) | page |
| `showPictureInPicture`, `hidePictureInPicture`, `requestUpdate`, `shellVersion` | handled by the page's second (native `chrome.webview`) transport variant | bundle module 51052 |
| `win-visibility-changed`, `win-state-changed`, `media-key` | emitted by newer shells; handled by the official web build, not the zarg build | web `useShell.ts`, `Player.js` |

### 2A.3 Page -> native events (what the shell accepts)

| Event | Params | Effect |
|---|---|---|
| `mpv-command` | array of strings, first is the mpv command | runs `mpv_command` on a detached thread. For `loadfile`, the shell first re-applies `vo` (from ini `[MPV] VideoOutput`) and `volume` (last known) |
| `mpv-set-prop` | `[name, value]`; `"true"` -> `"yes"`, `"false"` -> `"no"` | `mpv_set_property_string` |
| `mpv-observe-prop` | `["name"]` or `"name"` | `mpv_observe_property(userdata 0, MPV_FORMAT_NODE)`; changes arrive as `mpv-prop-change` |
| `app-ready` | none | see handshake |
| `seek-hover` | `[seconds, x, y]` | forwards to thumbfast as `script-message-to thumbfast thumb <s> <x> <y - ThumbFastHeight>`; ignored if `ThumbFastHeight=0` |
| `seek-leave` | none | `script-message-to thumbfast clear`, then ignores hovers briefly |
| `start-drag` | none | window drag (title-bar substitute) |
| `refresh` | `["all"]` or `["no"]` | `all` also clears disk cache, service workers, IndexedDB, then reloads |
| `app-error` | `["shellComm"]` | starts the retry-refresh loop |
| `open-external` | `[url]` | `ShellExecute` |
| `navigate` | `["home"]` or `[url]` | `home` navigates to the chosen web UI URL |
| `activity` | Discord rich-presence array (see 2A.6) | updates Discord |
| `update-requested` | none | runs the downloaded installer and exits |

Anything else is logged as `Unknown event=<name>` and ignored.

### 2A.4 What the web app (ShellVideo) does with mpv [SOURCE: stremio-video `ShellVideo.js`]

**Properties observed at player start** (all via `mpv-observe-prop`): `path`, `time-pos`, `volume`, `pause`, `seeking`, `eof-reached`, `duration`, `metadata`, `video-params`, `track-list`, `paused-for-cache`, `cache-buffering-state`, `demuxer-cache-time`, `aid`, `vid`, `sid`, `sub-scale`, `sub-pos`, `sub-delay`, `speed`, `mpv-version`, `ffmpeg-version`. So a remote bridge that listens to `mpv-prop-change` gets all of these for free once playback starts; it must not wait for its own `mpv-observe-prop` unless it needs extras (for example `chapter-list`, `media-title`, `percent-pos`, `mute`, `playlist`, `core-idle`).

**Value conversions the web app applies** (replicate them in the remote):

| mpv prop | UI value |
|---|---|
| `time-pos` (s, float) | `time` = round(s * 1000) ms; UI updates once per second |
| `duration` (s) | `duration` ms, but `null` (treated as live) if under 30 s or if the reported value keeps changing |
| `pause` | `paused` |
| `volume` (0-100) | `volume` |
| `mute` | `muted` |
| `speed` | `playbackSpeed` |
| `aid` / `sid` / `vid` | string `EMBEDDED_<id>`; `null` when `no` |
| `sub-scale` | `subtitlesSize` = round(v / 0.0066) |
| `sub-pos` | `subtitlesOffset` = 100 - v |
| `sub-delay` (s) | `subtitlesDelay` = round(v * 1000) ms |
| `demuxer-cache-time` | `buffered` = floor(v * 1000) ms |
| `paused-for-cache` / `seeking` | `buffering` |
| `track-list` | split into `audioTracks` and `subtitlesTracks`; id `EMBEDDED_<id>`, `lang` (or `Track N`), `label` (title or lang), `mode` `showing` when it equals current aid/sid, `ass` true for ass/ssa codecs |
| `video-params` | `hdrInfo` when `gamma` is `pq` or `hlg` (`primaries`, `max-cll`, `max-luma`) |

**Commands the web app sends** (use the same ones; they are on the allowlist of newer shells):

| Action | Message |
|---|---|
| Load a stream | `mpv-set-prop ["sub-ass-override","strip"]` (or `"no"`), `["hwdec","auto"\|"d3d11va"\|"no"]`, `["vo","gpu-next"\|"gpu"]`, `["osc","no"]`, `["input-default-bindings","no"]`, `["input-vo-keyboard","yes"]`; then `mpv-command ["loadfile", url]` or `["loadfile", url, "replace", "-1", "start=+<sec>"]` (mpv 0.39 and newer), then `["sid","no"]`, `["pause",false]`, `["speed",s]`, `["mute","no"]` |
| Stop / unload | `mpv-command ["stop"]`, plus reset of `keepaspect`, `panscan`, `sub-ass-force-margins` |
| Pause / resume | `mpv-set-prop ["pause", true\|false]` |
| Seek | `mpv-set-prop ["time-pos", seconds]` (absolute, seconds) |
| Speed | `mpv-set-prop ["speed", n]` |
| Volume | `mpv-set-prop ["mute","no"]` then `["volume", 0-100]` |
| Mute | `mpv-set-prop ["mute","yes"\|"no"]` |
| Audio track | `mpv-set-prop ["aid", "<id without EMBEDDED_>"]` |
| Subtitle track | `mpv-set-prop ["sid", "<id>"]`, or `"no"` to turn off |
| Subtitle style | `sub-scale` (size * 0.0066), `sub-pos` (100 - offset), `sub-delay` (s), `sub-color` / `sub-back-color` / `sub-border-color` as `#AARRGGBB` (the web app converts from `#RRGGBBAA`) |
| Aspect | `cover`: `keepaspect true`, `panscan 1.0`, `sub-ass-force-margins true`; `fill`: `keepaspect false`, `panscan 0`; default: `keepaspect true`, `panscan 0` |
| Add external subtitle | `mpv-command ["sub-add", path, "select", title, "Other Tracks"]` |

**Important:** the web UI keeps its own state model on top of these. If the remote changes mpv directly (for example `set pause`), the UI picks it up through `mpv-prop-change`, so it stays consistent. But actions that involve app logic (next episode, picking a stream, "play from library") must go through the web UI (clicks or hash navigation), not mpv.

### 2A.5 Command allowlist in newer shells (compatibility trap)

The shipped exe is **5.0.21 and has no allowlist** (the strings `MpvCommandBlocked`, `MpvCommandAllowlist` are absent), so everything above works here. Shells after 5.0.21 (current source) apply a default-deny filter in `HandleEvent`:

- `mpv-command` allowed: `loadfile, sub-add, keypress, stop, script-message-to, cycle`
- `mpv-set-prop` allowed: `pause, time-pos, speed, mute, volume, aid, sid, no-sub-ass, vo, osc, input-default-bindings, input-vo-keyboard, sub-scale, sub-pos, sub-delay, sub-color, sub-back-color, sub-border-color, hwdec, hwdec-codecs, subs-with-matching-audio, subs-match-os-language, subs-fallback, subs-fallback-forced`
- Extra entries can be added in `portable_config/stremio-settings.ini`, section `[Security]`, keys `MpvCommandAllowlist` and `MpvSetPropAllowlist` (comma separated, lower-cased; defaults are always merged in and rewritten into the ini).
- Blocked calls are logged to the crash log and answered with `MpvCommandBlocked` / `MpvSetPropBlocked`.

Consequences for this project:
1. Kai 4.8.0 itself sends plain `script-message` (`notify-skip-config`, `track-selector-config`), which is **not** on the default list. It works today only because the bundled exe predates the filter. If you ever update the exe, add `script-message` to `MpvCommandAllowlist`, or those two mods stop configuring mpv.
2. Design the remote to use only allowlisted calls where possible (`time-pos` for seeking, `cycle`, `keypress`, `script-message-to`), and document the extra ini entries it needs (`seek`, `set`, `quit`, `script-message`, `show-text`, `add`, and extra props such as `chapter` or `audio-delay`).
3. Always handle the `Mpv*Blocked` replies so the phone can show "not permitted".

### 2A.6 `activity` event (now-playing data source)

The web app sends Discord presence data as `activity` args; the shell maps them positionally (`discord.cpp`). Observed indexes: `[0]` embed type (`movie`/`series`/menu type), `[1]` content type, `[2]` title, `[3]` season (series), `[4]` episode, `[5]` episode title, `[6]` thumbnail, `[7]` large image URL, `[8]` elapsed seconds, `[9]` duration seconds, `[10]` `"yes"` when paused, `[11]` and `[12]` button URLs. A bridge that wraps `qt.webChannelTransport.send` can read these to learn the title, episode, poster and progress without scraping the DOM. [Index list is from reading `SetDiscordPresenceFromArgs`; confirm against a live capture.]

### 2A.7 Launching content from outside the page (phone -> PC)

The shell is single-instance. A second launch passes its argument to the first instance with `WM_COPYDATA` and exits. The first instance maps it as follows, and then fires the matching event into the page:

| Argument | Event sent to the page |
|---|---|
| existing `*.torrent` file | `OpenTorrent {data:[bytes]}` |
| other existing file | `OpenFile {path}` |
| `stremio://detail/...` | `ReplaceLocation {path}` (page navigates) |
| other `stremio://...` | `AddonInstall {path}` |
| `magnet:...` | `OpenTorrent {magnet}` |

Page-side handling in the zarg bundle [SOURCE, function `O` next to the transport]:
- `ReplaceLocation` -> `window.location.assign(decodeURIComponent(path.replace("stremio://","#/")))`. So `stremio://detail/movie/tt0133093/tt0133093` becomes the route `#/detail/movie/tt0133093/tt0133093` (the streams page). Any `stremio://<route>` that begins with `detail` behaves as a route jump.
- `AddonInstall` -> `location.assign("#/addons?addon_url=" + encoded url)`.
- `OpenTorrent` -> dispatches `StreamingServer / CreateTorrent` to the core with the magnet or the bytes.
- `SubtitleDropped` shows a toast; `requestUpdate` opens the update dialog; show/hidePictureInPicture toggle `#pip-overlay`.

So the daemon can open any title with `stremio.exe "stremio://detail/<type>/<id>[/<videoId>]"` or a magnet link without touching the DOM. Messages that arrive before `app-ready` are queued and flushed after it. From inside the page (the bridge webmod) it is simply `location.hash = "#/detail/..."`.

---

## 3. Webmods loader [SOURCE `webview.cpp` SetupWebMods, `helpers.cpp` MakeInjectJsScript]

(corrected) Mods are not injected after the page loads. They are registered with WebView2 `AddScriptToExecuteOnDocumentCreated`, so they run at the start of **every new top-level document**, before any page script, and after the Qt shim (which is registered first).

- Folder: `<exe dir>/portable_config/webmods/`, scanned **recursively** at startup (`recursive_directory_iterator`). Log line `[WEBMODS] Folder not found:` if missing. Files added later need an app restart; edits to existing files need a restart too (contents are read once and embedded as base64).
- `.css` and `.js` only; `.map`, `.bak`, `.tmp` skipped.
- **Order:** CSS files and JS files are each sorted by relative path, case-insensitive (`_wcsicmp`). With the current tree that means: `Metadata/bootstrapper.js`, `Metadata/config.js`, `Metadata/Fetchers/...`, `Metadata/main.js`, `Metadata/Services/...`, `Metadata/Utils/...`, then `Settings/...`, `Theme/...`, `UI/...`, `Utilities/navigation.js`. That is why `bootstrapper.js` polls for `window.MetadataModules` (it runs before the modules it needs). A bridge file named `Remote/kai-remote.js` would run after `Metadata/` and before `Settings/`; name it `Utilities/...` or `zz-remote/...` to run last, or `00-remote/...` to run first.
- JS wrapper: `(function(){ if(window.top!==window) return; function run(){ try{ (0,eval)(atob(...) decoded as UTF-8) }catch(e){ console.error(...); setTimeout(run,25) } } run(); })()`. Global-scope indirect eval, top frame only, and **a throwing mod is re-run every 25 ms forever**, so a mod must never throw on a transient condition (use try/catch and retry timers instead, or it spams and re-executes side effects).
- CSS wrapper: adds `<style id="webmods-css-<path>">` to the document root; retries every 50 ms.
- Because it runs at document creation on **every** top-level navigation, mods also run on non-Stremio pages the user navigates to (the shell shows a "Back to Stremio" button there, `INJECTED_BUTTON_SCRIPT`). A bridge should check `location.origin` against the known web UI origins before opening sockets.
- At document creation `document.body` does not exist; Kai mods guard with `document.readyState === "loading"` and `DOMContentLoaded`.
- Log lines: `[WEBMODS] CSS: <file>` and `[WEBMODS] JS: <file>`.
- Every Kai mod starts with an idempotency guard (`if (window.X?.initialized) return;`) because the same document can be evaluated more than once.

---

## 4. Stremio web UI map

### 4.1 Routing (hash router) [CONFIRMED from `route-detector.js`, `navigation.js`]

| Route (hash) | View | Notes |
|---|---|---|
| `#/` or empty | Board (home) | rows of `.board-row-CoJrZ`; Continue Watching row has `.continue-watching-row-ZiNSa` |
| `#/discover...` | Discover | flat grid `.meta-items-container-n8vNz` |
| `#/library...` | Library | flat grid `.meta-items-container-IKrND` |
| `#/calendar` | Calendar | |
| `#/addons` | Add-ons | |
| `#/settings` | Settings | sections injected into by several mods |
| `#/detail/<movie\|series>/<id>[/<episodeId>]` | Detail / streams | `STREAMS` regex: `^#/detail/(movie|series)/([^/]+)/([^/?]+)`; `DETAIL` regex: `^#/detail/(movie|series)/([^/?]+)`; query param `?season=` |
| `#/player/...` | Player | IDs are URL-encoded; see below |

The six pages Kai cycles with the gamepad bumpers, in order: `#/`, `#/discover`, `#/library`, `#/calendar`, `#/addons`, `#/settings`.

Player URL shape: `#/player/<encoded stream>/<encoded addon url>/.../<type>/<id>/<videoId>`. Examples from the regexes: `/series/mal%3A11061/tt2098220%3A1%3A2`, `/movie/tt1234567/`. Extraction rules used by Kai:

- IMDb id: `/(tt\d+)(?::\d+:\d+)?(?:\/|$)` on the decoded hash.
- Type: `/(movie|series)/`.
- Season and episode: `/(tt\d+)(?::|\/)(\d+)(?::|\/)(\d+)(?:\/|$)`.
- Anime ids: `mal:(\d+)`, `anilist:(\d+)`, `kitsu:(\d+)`.
- Non-IMDb id prefixes handled by `parseId`: `tmdb:`, `tvdb:`, `mal:`, `kitsu:`, `anilist:`, `anidb:`.

`window.RouteDetector.getRouteState()` returns `{view:"PLAYER"|"STREAMS"|"DETAIL"|"UNKNOWN", type, id, source, season, episode, episodeId, animeIds}` and is cached per hash. A bridge mod should reuse it rather than re-parse.

### 4.2 CSS class names are build-hashed (verified against the live bundles)

Measured by extracting every hashed class Kai's JS and CSS use (269 candidates, 216 of which share a class stem with a live build) and checking them against the downloaded `main.css` of each site:

| Web UI | Build | Exact hash matches (of 216) | Verdict |
|---|---|---|---|
| `https://stremio.zarg.me/` (and the GitHub Pages mirror) | `6f6b0558dbb064bca18a8dcc22cb1f3f4c455b22` | **208** | Kai targets this build. Only `input-field` and `status-valid` differ, and those are Kai's own classes |
| `https://web.stremio.com/` | `ca3cb08e51cae3ccf7531eabcd3ad2ee6e90a9d9` | 175 | Settings-page hashes are stale (`settings-container-b0DCu`, `section-container-twzKQ`, `label-FFamJ`, `option-container-EGlcv`, `sections-container-EUKAe` and others), so the settings injections would fail there |

Practical rule: a remote that depends on the settings DOM must either pin to the zarg build or select by stem (`[class*="settings-container-"]`). Stems matched in both builds for almost everything, only the 5-character suffix changes.

Class names look like `board-row-CoJrZ`: a stable stem plus a 5-character hash. The hash changes when the web app is rebuilt, which web.stremio.com does. Kai hard-codes the hashes (fragile). Safer for a remote: select by stem, e.g. `[class*="board-row-"]`. `player-clock-eta.js` already mixes both: `[class*='player-container']` first, then `.player-container-wIELK`.

Also note the same stem sometimes carries different hashes on different pages (for example `button-container-zVLH6` vs `button-container-xT9_L`, `meta-items-container-n8vNz` on Discover vs `-IKrND` on Library, `back-button-container-lDB1N` vs `-cJ4bk`). Selector lists with several hashes are normal.

### 4.3 Global shell and navigation

| Element | Class (hash as of this build) | Notes |
|---|---|---|
| App root | `.application-S5_Fh`, `.router-_65XU` | |
| Left nav bar | `.vertical-nav-bar-container-UPAkA`, items `a.nav-tab-button-tW6qT`, `.nav-tab-button-container-dYhs0` | selected tab has class `selected` |
| Top nav bar | `.horizontal-nav-bar-container-Y_zvK`, buttons in `.buttons-container-Oc5z1`, each `.button-container-zVLH6` (also `-xT9_L`) | also present inside the player as `.nav-bar-layer-r9HT5` |
| Logo | `.logo-container-jteMT`, image `.logo-oPx1q` | Kai: click -> `#/` |
| Search toggle | `.submit-button-container-MImNa`, `.search-button-RzywM` | |
| Search input | `.search-input-IQ0ZW input`, `.search-bar-container-asfq1 input` | the `<input>` is mounted only after the toggle is clicked; wait about one frame |
| Dropdown / menu / dialog | `.dropdown-container-T9bZ2`, `.menu-container-B6cqK`, `.dialog-container-S5c_E`, `.modal-backdrop` | Escape closes them natively |
| Toasts | `.toast-item-container-nG0uk` | |
| Avatar / logout | `.avatar-container-f6ino`, `.logout-button-container-prHdW` | |

### 4.4 Board (home), Discover, Library

| Element | Class |
|---|---|
| Board content | `.board-content-nPWv1` (inside `.board-content-container-ToQTz`) |
| Row | `.board-row-CoJrZ` (header `.header-container-tR3Ev`) |
| Item card | `.meta-item-container-Tj0Ib` (focusable via tabindex) |
| "See all" tile | `.see-all-container-MoOtW` |
| Poster | `.poster-container-qkw48`, `.poster-image-NiV7O`, layer `.poster-image-layer-KimPZ` |
| Continue-watching play overlay | `.play-icon-layer-vpQIo` (click it to resume the last stream); dismiss: `.dismiss-icon-layer-BWztF` |
| Library title bar and filters | `.title-bar-container-1Ba0x`, `.selectable-inputs-container-hR3or`, chips `.chip-L3r9A`, watched mark `.watched-icon-layer-bi3DO` |
| Discover | `.discover-container-L6OGL`, `.catalog-container-VNK_T`, grid `.meta-items-container-n8vNz` |
| Calendar | `.calendar-cH2jw`, `.cell-l3eWl`, `.item-PwXPg` / `.item-qsUNQ` |
| Add-ons | `.addons-container-ogGYu`, `.addon-container-lC5KN`, `.addon-details-modal-container-aBFaQ` |

Cards are focusable `div`s: React ignores programmatic Enter on them. See 6.3 for the click recipe.

### 4.5 Detail page

| Element | Class |
|---|---|
| Action buttons row | `.action-buttons-container-XbKVa`, button `.action-button-XIZa3` |
| Seasons bar | `.seasons-bar-Ma8vp` (also `.seasons-bar-container-nOZjG`, prev/next `.prev-season-button-bs1GQ` / `.next-season-button-RrYAq`) |
| Episode list | `.videos-list-nE0LJ` (container `.videos-container-msX8s`), item `.video-container-ezBpK`, watched flag `.watched-container-gvzs3`, thumbnail `.thumbnail-container-Zm8Cl` |
| Streams list | `.streams-list-Y1lCM` (container `.streams-list-container-xYMJo`), item `.stream-container-JPdah` |
| Back button | `.back-button-container-lDB1N` |
| Meta | `.meta-info-container-ub8AH`, `.description-container-yi8iU`, `.release-info-label-LPJMB`, `.runtime-label-TzAGI`, title logo `.logo-X3hTV` (its `title` attribute holds the title) |
| Links | `.meta-links-Xiao3`, `.imdb-button-container-gGjxp` |
| Side drawer (episode/stream sidebar) | `.side-drawer-r9EuA` |

Kai's "smart landing" focuses the first unwatched episode (episode row lacking `.watched-container-gvzs3`), else the first stream.

### 4.6 Settings page

Structure: `.settings-container-b0DCu` > `.side-menu-container-NG17D` (buttons `.side-menu-button-vbkJ1`, for example "Player Shortcuts") and `.settings-content-lLXmk` > `.sections-container-EUKAe` > `.section-container-twzKQ` > `.section-category-container-EOuS0` (label `.label-FFamJ`, text such as "Advanced"; titles `.section-title-Nt71Z`). Rows: `.option-container-EGlcv`, name `.option-name-container-exGMI`, input `.option-input-container-NPgpT`. Toggle: `.toggle-container-lZfHP` + `.toggle-toOWM`, checked state is a `checked` class. Multiselect: `.multiselect-container-w0c9l`.

Kai injects rows by finding a `.label-FFamJ` whose text equals "Advanced" or "UI Language", then inserting a cloned option row after it. The settings DOM renders lazily, so the mods use a debounced `MutationObserver` for up to 10 s.

Stremio's own persisted user settings live in `localStorage["localProfile"]` (JSON). Fields Kai reads: `defaultSubtitleLanguages[]`, `defaultAudioLanguages[]`, `subtitlePriorityKeywords[]`, `rememberTrackSelection`, `subtitleSelectionMode`.

---

## 5. The player (`#/player/...`)

### 5.1 DOM

| Element | Class / selector |
|---|---|
| Player root | `.player-container-wIELK` (use `[class*='player-container']`) |
| Top nav inside player | `.nav-bar-layer-r9HT5` / `.horizontal-nav-bar-container-Y_zvK` (the clock mod puts its element before `.buttons-container-Oc5z1`) |
| Control bar | `.control-bar-container-xsWA7` |
| Control bar buttons | `.control-bar-buttons-container-SWhkU .button-container-zVLH6` (focus with Arrow Left/Right) |
| Seek bar | `.seek-bar-I7WeY` (also `.seek-bar-container-JGGTa`), slider `.slider-hBDOf`, time labels `.label-QFbsS` |
| Popup menus (subtitles, audio, speed) | `.menu-layer-HZFG9`; options `.button-container-zVLH6`, `.language-option-O1Yr9`, `.variant-option-t7_LA`, `.option-COcvW`, `.option-GcPlB` |
| Next episode | `div[title="Next Video"]` |
| Side panel / drawer | `.side-drawer-r9EuA`, `.player-panel-lBK74` |

### 5.2 Time and duration

Seek-bar labels: `.seek-bar-I7WeY .label-QFbsS`; first = current time, second = duration, or remaining time when the text starts with `-`. Formats `H:MM:SS` or `MM:SS`. Kai parses with `/(\d{1,2}):(\d{2}):(\d{2})/` then `/(\d{1,2}):(\d{2})/`. [Better source for a remote: `mpv-prop-change` for `time-pos`, `duration`, `pause`, `volume`.]

### 5.3 Keyboard shortcuts

**Stock shortcut table of the zarg build** [SOURCE: the JSON embedded in `main.js`, settings "Shortcuts"]. The player route listens through Mousetrap-style combos, so use the key/keyCode recipe in section 6:

| Group | Name | Combos |
|---|---|---|
| general | navigateTabs | 1, 2, 3, 4, 5, 6 |
| general | navigateSearch | 0 |
| general | fullscreen | F |
| general | exit | Escape |
| general | shortcuts | Ctrl+/ |
| player | playPause | Space |
| player | seekForward / seekBackward | ArrowRight, Shift+ArrowRight / ArrowLeft, Shift+ArrowLeft (long and short step are user settings) |
| player | volumeUp / volumeDown | ArrowUp / ArrowDown |
| player | subtitlesSize | - and = |
| player | subtitlesDelay | G and H |
| player | subtitlesMenu | S |
| player | audioMenu | A |
| player | infoMenu | I |

Corrections to the Kai-supplied table below: the stock build has no M, R, Z, X or V shortcut in this table (Kai's "Kai Shortcuts" page lists them; treat them as Kai's claims until tested, and note Kai's Z/X delay vs. stock G/H). Newer web builds also have `mute` and playback-speed-hold-on-Space behaviour (Space held = temporary speed boost, a tap = play/pause), which is why Kai dispatches `MediaPlayPause` instead of Space.

Kai-supplied table (from `custom-shortcuts.js`, which replaces the stock "Player Shortcuts" text on the settings page):

From Kai's own "Kai Shortcuts" table (`custom-shortcuts.js`), which replaces the stock "Player Shortcuts" text on the settings page. The stock ones are listed there too:

| Key | Action | Layer |
|---|---|---|
| Space / MediaPlayPause | play/pause | Stremio web player |
| Arrow keys | seek / volume (when no menu is open and focus is not in the control bar) | Stremio web player |
| M | mute | Stremio web player |
| R | playback speed menu | Stremio web player |
| S | subtitle track menu | Stremio web player |
| A | audio track menu | Stremio web player |
| I | episode list | Stremio web player |
| Z / X | subtitle delay | Stremio web player |
| V | show/hide subtitles | Stremio web player |
| F | fullscreen [INFERRED, Kai text mentions "F key works" for search] | |
| Q | quit app | mpv `input.conf` |
| T / Shift+T | stats overlay / page 2 | mpv (stats script) |
| U | cycle panscan 0, 0.5, 1.0 | mpv |
| ` (backtick) | cycle audio preset (script-message `cycle-audio-preset`) | profile-manager.lua |
| Tab | skip intro/outro (mpv binding `perform_skip`) in player, layer switch elsewhere | notify_skip + navigation.js |
| Caps Lock | toggle metadata hover popup | hover-popup.js |
| F1-F4, Shift/Ctrl+F1-F3, Ctrl+1-4 | Anime4K presets and thin-line toggles | mpv `input.conf` |
| F6 / Ctrl+F6 | deband / deband shader | mpv |
| F7 / Ctrl+F7 | deinterlace / bwdif | mpv |
| F8 / Ctrl+F8 | `cycle-visual-profile` / ICC auto toggle | profile-manager.lua / mpv |
| F9 / Shift+F9 / Ctrl+F9 | hqdn3d denoise filter levels | mpv |
| F10 / Shift+F10 / Ctrl+F10 | denoise shaders | mpv |
| F11 / Ctrl+F11 | adaptive-sharpen / sharpen-denoise | mpv |
| F12 / Ctrl+F12 | SVP frame interpolation / bwdif + SVP | mpv |

Escape in Kai: if an overlay is open (`.dropdown-container-T9bZ2, .menu-container-B6cqK, .dialog-container-S5c_E, .modal-backdrop`), the key is left to Stremio; otherwise it is swallowed (stopImmediatePropagation) and, when not on a grid page, goes to `#/`.

### 5.4 Gamepad map (Kai, standard layout) [CONFIRMED `navigation.js`]

D-pad / left stick -> Arrow keys; A (0) -> click focused element, or MediaPlayPause in the player; B (1) -> `history.back()`; X (2) -> Tab; Y (3) -> `#/`; L1/R1 (4/5) -> previous/next of the six main pages; Start (9) -> click `div[title="Next Video"]`; L3 (10) -> `s` (subtitles menu, player only); R3 (11) -> `a` (audio menu, player only). Cooldown 140 ms (axis 180 ms).

---

## 6. How to drive the UI programmatically (recipes that work with this React app)

These are the techniques Kai itself needed; reuse them.

1. **Clicks on non-button elements** (cards, stream rows, controls): React ignores `.click()` alone and ignores Enter on non-form elements. Dispatch `mousedown`, `mouseup`, then call `.click()`, all with `bubbles:true, cancelable:true`.
2. **Keyboard**: Stremio uses Mousetrap, which reads `keyCode`/`which`. Dispatch `new KeyboardEvent("keydown", {key, code, keyCode, which, bubbles:true, cancelable:true, composed:true})` on `document`. Do not omit `keyCode`.
3. **Play/pause in the player**: dispatch `key:"MediaPlayPause", code:"MediaPlayPause", keyCode:179`. Do NOT also send Space (double toggle). Forcing `<video>.play()` desyncs React state.
4. **Search**: click `.submit-button-container-MImNa`; wait about 50 ms; focus `.search-input-IQ0ZW input`; set `.value`; dispatch `new Event("input", {bubbles:true})`.
5. **Close a dropdown/menu**: `document.body.click()`.
6. **Navigate**: assign `location.hash = "#/..."`. `history.back()` for back (Kai remaps the detail-page back button to go to `#/` when the history chain is episode -> episode).
7. **Resume a Continue Watching item**: click its `.play-icon-layer-vpQIo` (mousedown, mouseup, click).
8. **Focus**: elements are focusable divs (`tabindex`). Use `.focus()` before synthetic clicks so focus-dependent styling matches.
9. **Window focus**: Kai tracks `window.isAppFocused` (focus/blur) and ignores keyboard and gamepad input when unfocused. A remote command should not depend on that guard. When Kai starts it also clicks the nav bar once to take WebView focus.

---

## 7. mpv layer

### 7.1 `mpv.conf` highlights [CONFIRMED]

`log-file=LOG.txt`, OSD font Nata Sans 40, cache 900 s, `demuxer-max-bytes` 1 GiB, `demuxer-max-back-bytes` 512 MiB, `stream-buffer-size` 128 MiB, reconnect options for network streams, `vo=gpu-next`, `profile=high-quality`, `gpu-api=auto`, deband/dither/scaler defaults. Profiles `[sdr]` and `[anime-sdr]` hold static scaler settings only. Shaders, filter chains, HDR handling and audio presets are applied dynamically by `profile-manager.lua`. No `input-ipc-server` is set.

### 7.2 Lua scripts and the messages they accept [CONFIRMED]

Script-message names are global; some are addressed with `script-message-to <script-name>`. Script names are the folder or file basename with `-` converted to `_` by mpv (`notify_skip`, `profile_manager`, `smart_track_selector`).

| Target script | Message | Payload | Sent by |
|---|---|---|---|
| `profile_manager` | `anime-metadata` | JSON: `is_anime, detection_reason, language, imdb_id, content_type, hdr_passthrough, shader_preset, svp_enabled, svp_global, color_profile, icc_profile, target_peak, osd_profile_messages, vulkan_mode, ultrawide_zoom, audio_preset` | `mpv-bridge.js` on player route |
| `profile_manager` | `cycle-visual-profile` | none | key F8 |
| `profile_manager` | `cycle-audio-preset` | none | key backtick |
| `notify_skip` | `content-metadata` | JSON: `content_type, imdb_id, season, episode` | `mpv-bridge.js` |
| (global) | `notify-skip-config` | JSON: `auto_skip, show_notification` | `mpv-bridge.js` |
| `notify_skip` | `perform-skip` | none | Tab key, skip-button click (`navigation.js`) |
| `smart_track_selector` | `track-selector-config` (global message) | JSON: `sub_preferred_langs, audio_preferred_langs, sub_priority_keywords, sub_reject_langs, audio_reject_langs, audio_reject_keywords, sub_reject_keywords, match_audio_to_video, use_forced_for_native, title_id, remember_track_selection, subtitle_selection_mode, language_alias_groups, _diagnostics` | `mpv-bridge.js` |
| `smart_track_selector` | `track-selector-language` | JSON: `title_id, status, original_language_raw, original_language_primary, original_language_expanded` | `mpv-bridge.js` |
| `smart_track_selector` | `track-selector-diagnostic` | JSON log record | `mpv-bridge.js` |
| `reactive_vf_bypass` | `bypass-ignore-seek` | none | internal |
| `thumbfast` | `thumb`, `clear` | shell calls these for seek-bar thumbnails (`seek-hover requires at least 3 arguments` in the binary; `ThumbFastHeight=160` in the ini) | shell |

Send format from a webmod:

```js
chrome.webview.postMessage(JSON.stringify({
  type: 6, object: "transport", method: "handleInboundJSON",
  args: ["mpv-command", ["script-message-to", "notify_skip", "perform-skip"]]
}));
```

### 7.3 Properties and events the scripts observe (useful state sources)

`time-pos`, `chapter`, `osd-dimensions`, `pause`, `vf`, `video-params`, `video-out-params`, `sid`, `aid`, `track-list`, `current-tracks/video`, `duration`, `path`, `vid`, `edition`, `vf-metadata/blackdetect`, `af-metadata/silencedetect`; events `start-file`, `file-loaded`, `end-file`, `seek`, `shutdown`. The shell itself observes at least `pause` and `volume` and forwards them as `mpv-prop-change`.

### 7.4 Notable behaviours

- Intro/outro skipping (`notify_skip`): chapter detection, black-frame (`blackdetect`) and silence (`silencedetect`) filters, a skip toast drawn as an mpv ASS overlay. Because the overlay lives in mpv, clicks never reach Lua; `navigation.js` mirrors the toast's geometry (base 1080 px height; margin 80, button 200x60, extra offset 80, all scaled by `innerHeight/1080`; right-aligned above the control bar) and sends `perform-skip`.
- `profile-manager.lua` v7.3: base profile `sdr` or `anime-sdr`, then HDR layer, then anime layers (Anime4K shaders, hqdn3d + SVP or legacy BWDIF + SVP for interlaced at most 576p), then OSD message. Anime detection: DB flag from `mpv-bridge.js` plus release-group lists (Tier 1 anime-only groups).
- Audio presets: `Reference` (default), `Night Mode`, `Voice Clarity` (no dynamic range compression since v7.3).
- Smart track selector (about 2000 lines): applies language and keyword preferences, original-language matching, forced subs, per-title remembered choices stored in `scripts/smart-track-selector/track_preferences.json`.
- SVP: `svp_anime.vpy`, `svp_cinema.vpy`, options in `script-opts/svp.conf`, cleanup on unload by `svp_cleanup.lua`; `reactive_vf_bypass.lua` bypasses the filter on pause/seek.

---

## 8. Kai webmods catalog

All under `portable_config/webmods/`. "G:" = globals created, "S:" = storage keys, "E:" = events.

### 8.1 Utilities and shared

- `Utilities/navigation.js` - `G: KaiNavigation`. Keyboard grid/layer navigation, Escape policy, search type-ahead, gamepad polling, skip-button click forwarding. Details in sections 5 and 6.
- `Metadata/Utils/route-detector.js` - `G: RouteDetector`. See 4.1.
- `Metadata/Utils/anime-detection.js` - `G: AnimeDetection` (tiers T1-T3).
- Other `Metadata/Utils/*`: `id-conversion.js`, `id-lookup.js`, `title-utils.js`, `ratings-utils.js` (about 53 KB, ratings from IMDb, TMDB, RT, Metacritic, Letterboxd, MAL and so on), `fetch-utils.js`, `preferences.js`.

### 8.2 Metadata system (`Metadata/`)

Namespace `window.MetadataModules.<module>` filled by each file; `bootstrapper.js` waits for: config, rateLimiter, ratingsUtils, metadataFetcher, idConversion, titleSearch, idLookup, metadataStorage, domProcessor, hoverPopup, apiKeys, preferences, settingsUI, main (retries up to 100 times at 100 ms). `main.js` builds `PersistentCore` (rate limiter, fetcher, id converter, title search, id lookup, storage) and `TransientUI` (DOM processor, hover popup). Exposes `window.metadataHelper` (for example `getTitle(imdbId)`) which `mpv-bridge.js` polls for up to 4 s.

Storage: IndexedDB through Dexie (`https://unpkg.com/dexie` is loaded at runtime). Data sources: TMDB v3 (`api.themoviedb.org/3`, image CDN `image.tmdb.org`), MDBList (`api.mdblist.com`), Cinemeta (`v3-cinemeta.strem.io`), Jikan/MAL for anime, plus CORS proxies (`proxy.cors.sh`, `api.allorigins.win`) and `imdb.iamidiotareyoutoo.com` search. User keys: `kai-api-key-tmdb`, `kai-api-key-mdblist` (see 9; stored in localStorage on this machine).

`Services/mpv-bridge.js` v2.2.0 `G: MpvBridge`: on `hashchange`, `storage` events for `kai-*` / `localProfile`, and `kai-settings-changed`, it re-sends config to mpv (see 7.2). Sequence on entering the player: content-metadata -> track-selector-config -> notify-skip-config -> (after metadata lookup) anime-metadata + track-selector-language + diagnostic.

### 8.3 Settings (`Settings/`)

- `mpv-settings.js` (about 68 KB) `G: MpvSettings` - injects the Kai section into Settings > Advanced and Player: HDR passthrough, HDR target peak, Anime4K preset (`optimized`/`fast`/`hq`), SVP on/global, color profile (`kai` default), ICC, Vulkan API, ultrawide zoom, audio preset, notify-skip toggles, smart-track options and reject lists. Public: `getColorProfile, getHdrPassthrough, getIccProfile, getUltrawideZoom/setUltrawideZoom, getSvpEnabled, getSvpGlobal/setSvpGlobal, getAudioPreset/setAudioPreset, getAnime4kPreset, getSmartTrackConfig, getLanguageAliasGroups, expandLanguage`. Fires `kai-settings-changed`.
- `auto-fullscreen.js` - `S: stremio-auto-fullscreen`. `document.documentElement.requestFullscreen()` on start, with a first-interaction fallback.
- `custom-shortcuts.js` - rewrites the Player Shortcuts settings section (text only).
- `oled-theme-toggle.js` - adds an OLED toggle (body class `oled-theme`).
- `enhanced-metadata.js` - settings UI for the metadata system.

### 8.4 UI (`UI/`)

- `hover-popup.js` + `.css` (about 65 KB) - metadata popup on catalog cards; Caps Lock toggles.
- `details-enhancer.js` + `.css` `G: ShowPageEnhancer` - ratings/cast/awards on detail pages.
- `Hero Banner/` `G: HeroPlugin` - home-page banner fed by Cinemeta and MDBList catalogs; `S: hero-movie-source-index, hero-series-source-index`; `E: hero-request-init, hero-banner-created, hero-start-rotation, hero-stop-rotation`.
- `player-clock-eta.js` - clock and "Ends at" in the player nav bar. `S: stremio-player-clock-enabled, stremio-player-clock-24h`.
- `seekbar-hover-time.js` - tooltip `#timeline-tooltip` on seek-bar hover.
- `welcome-wizard.js` `G: KaiWelcomeWizard` - first-run setup; `donation-manager.js` `G: DonationManager`; `update-notification.js` `G: KaiUpdatePlugin` (points to `allecsc.github.io/Stremio-Kai/changelog.html`).

### 8.5 Theme (`Theme/*.css`)

Main, Board, Episodes (detail and player), Library, Settings, Calendar, Addons, Discover. They override the hashed classes listed in section 4, so they break together with the JS when Stremio rebuilds.

---

## 9. Storage keys, globals, events

**localStorage (Kai):** `kai-hdr-passthrough`, `kai-hdr-target-peak`, `kai-anime4k-preset`, `kai-svp-enabled`, `kai-svp-global`, `kai-color-profile`, `kai-icc-profile`, `kai-vulkan-api`, `kai-ultrawide-zoom`, `kai-audio-preset`, `kai-osd-profile-messages`, `kai-notify-auto-skip`, `kai-notify-show-notifications`, `kai-smart-track-match-audio`, `kai-smart-track-use-forced`, `kai-smart-track-reject-audio`, `kai-smart-track-reject-subs`, `kai-smart-track-reject-audio-keywords`, `kai-smart-track-reject-sub-keywords`, `kai-metadata-debug`, `kai-api-key-tmdb`, `kai-api-key-mdblist`, `hero-movie-source-index`, `hero-series-source-index`, `stremio-auto-fullscreen`, `stremio-player-clock-enabled`, `stremio-player-clock-24h`.
**localStorage (Stremio):** `localProfile` (settings JSON, section 4.6).
**Globals:** `RouteDetector, MpvBridge, MpvSettings, MetadataModules, metadataHelper, KaiNavigation, ShowPageEnhancer, HeroPlugin, KaiWelcomeWizard, KaiUpdatePlugin, DonationManager, AnimeDetection, PopupTemplates, isAppFocused`.
**Events:** `kai-settings-changed`, `kai-pref-changed`, `metadata-updated`, `metadata-modules-ready`, `kai-enrichment-complete`, `hero-*` (above), `storage` (cross-window), `hashchange`, `gamepadconnected/disconnected`.

---

## 10. Streaming server (`server.js`, Node)

Started by the shell as `"stremio-runtime.exe" "server.js"` with the environment variable `NO_CORS=1` set first [SOURCE `server.cpp`], inside a Windows Job Object (it dies with the shell; stdout is piped into the shell log with a `[node]` prefix). Searches for `stremio-runtime.exe` and `server.js` in the exe folder, then in `%LocalAppData%\Programs\StremioService`. Disabled by `--streaming-server-disabled`. Default port 11470 (HTTP; `server.js` also builds URLs with `127.0.0.1:${serverPort}` and checks `Origin` against `(127.0.0.1|localhost):11470$`), 12470 for HTTPS. The `network-info` handler enumerates interfaces starting from `0.0.0.0`, which suggests the server is reachable on the LAN; [UNKNOWN] confirm with `netstat -an | findstr 11470` while the app runs. Routes found by grepping `server.js` (not tested): `GET /settings`, `POST /settings`, `/stats.json`, `/heartbeat`, `/status`, `/network-info`, `/device-info`, `/get-https`, `/hwaccel-profiler`, `/probe`, `/opensubHash`, `/subtitles.:ext`, `/subtitlesTracks`, `/thumb.jpg`, `/tracks/:url`, `/exec`, `/removeAll`, `/yt/:id`, `/yt/:id.json`, `/create` and `/:infoHash/create` (torrent), `/:infoHash/:idx` (+ `/stats.json`), `/:infoHash/remove`, HLS (`/hlsv2`, `.../master.m3u8`, `stream-q-:quality.m3u8`, `subs-:lang.m3u8`), `/transcode`, archive helpers (`/rar`, `/zip`, `/7zip`, `/tar`, `/nzip`), `/casting/` and `/:first/:second/dlna` (cast-to-device), `/local-addon`. Useful for a remote: `/stats.json` and `/heartbeat` (server alive and torrent stats). `/casting/` is Stremio's own cast discovery; its API shape is [UNKNOWN].

---

## 11. Mapping: what a remote needs vs. where to get it

| Remote feature | Source of truth | Control path |
|---|---|---|
| Play/pause, volume, mute | `mpv-prop-change` (`pause`, `volume`, `mute`) | `mpv-set-prop ["pause", true\|false]`, `["volume", n]`, `["mute","yes"\|"no"]` (all on the default allowlist), or the MediaPlayPause key event |
| Seek, position, duration | `mpv-prop-change` for `time-pos` (s) and `duration` (s); already observed by the web app | `mpv-set-prop ["time-pos", seconds]` (absolute; allowlisted). Relative seek via `mpv-command ["seek", n]` needs the allowlist entry on newer shells |
| Audio/subtitle tracks | `track-list`, `aid`, `sid` (already observed) | `mpv-set-prop ["aid", id]`, `["sid", id\|"no"]` using the numeric mpv id (strip `EMBEDDED_`), or driving the `.menu-layer-HZFG9` popup (S / A keys) |
| Subtitle delay/size/position | `sub-delay`, `sub-scale`, `sub-pos` | `mpv-set-prop` with the same conversions as the web app (2A.4) |
| Open a title from the phone | none needed | daemon runs `stremio.exe "stremio://detail/<type>/<id>[/<videoId>]"` (2A.7) or the bridge sets `location.hash` |
| Skip intro/outro | `notify_skip` | `script-message-to notify_skip perform-skip` |
| Next episode | `div[title="Next Video"]` | synthetic click (mousedown, mouseup, click) |
| Now playing info | `RouteDetector.getRouteState()`, `metadataHelper.getTitle(id)`, `.logo-X3hTV[title]` | read-only in the webmod |
| Browse/search/select | DOM + hash router | section 6 recipes, `location.hash` |
| Home/back | hash router, history | `location.hash = "#/"`, `history.back()` |
| Visual presets (Anime4K, SVP, audio preset, visual profile) | mpv props + `kai-*` storage | `script-message cycle-visual-profile / cycle-audio-preset`, or `localStorage` + `kai-settings-changed` |
| Quit app | tray menu in the shell runs `quit` then destroys the window | `mpv-command ["quit"]` only ends mpv (`EVENT_SHUTDOWN` destroys the handle); [UNKNOWN] whether the window closes. Not allowlisted on newer shells. Safer: the daemon closes the process (`taskkill`) or uses the tray |

---

## 12. Open questions to verify at runtime

Answered by reading source (kept for traceability):

1. ~~Event names and shapes~~ - answered in 2A.2, 2A.3, 2A.4. The web app already observes `track-list`, `time-pos`, `duration`, `pause`, `volume`, `aid`, `sid`, `sub-*`, `speed`.
2. ~~Does replacing `transport.send` intercept UI traffic~~ - yes by construction: the zarg page calls `transport.send(JSON.stringify(msg))` (module 43415). Install the wrapper at document creation.
3. ~~Load order and subfolders~~ - answered in section 3 (recursive, case-insensitive path sort, at document creation).
4. ~~Complete native event list~~ - answered in 2A.3 (source of the 5.0.2x line). Window/fullscreen events exist in newer shells only.
5. ~~Whether web.stremio.com is the UI~~ - no, `stremio.zarg.me` is tried first (section 1, 4.2).

Still open, needs a running app:

1. Whether `input-ipc-server=\\.\pipe\kai-mpv` in `mpv.conf` creates a JSON IPC pipe in the embedded libmpv (the shell sets `config=yes`, so it is read). Test with `echo '{"command":["get_property","pause"]}' | ...` against the pipe.
2. Whether `ws://127.0.0.1:PORT` from the `https://stremio.zarg.me` page is allowed (expected yes: loopback is treated as potentially trustworthy; a LAN IP is mixed content). Also test `fetch("http://127.0.0.1:PORT")`, which is the fallback if WebSocket is blocked (the daemon would need CORS headers and `Access-Control-Allow-Private-Network`).
3. Which port the streaming server listens on and whether it binds `0.0.0.0` (`netstat`).
4. Exact `activity` payload indexes (2A.6) in a live capture.
5. The real `mpv-prop-change` rate for `time-pos` (the shell forwards every change; the web app throttles to 1 per second, a remote should too).
6. Whether the page keeps working while Windows lock screen / minimize pauses playback (`PauseOnMinimize=1` in the ini makes the shell pause on minimize, which a remote must account for).
7. Whether `Kai Shortcuts` extras (M, R, Z, X, V) exist in the stock player; trial in the app.
8. Whether the shipped exe silently differs from source in handshake details; capture the first 20 messages after `app-ready` to confirm.

Suggested first step: a logging-only webmod (wrap `qt.webChannelTransport.send` at document creation, add a `chrome.webview` `message` listener, log both with timestamps), then play a title with subtitles and record the output.

---

## 13. Sources used for the [SOURCE] tags

- Shell source (C++), repo `Zaarrg/stremio-community-v5` (the exe's strings still use the old name `stremio-desktop-v5`): `src/webview/webview.cpp` (shim, webmods, handlers), `src/ui/mainwindow.cpp` (`HandleEvent`, `HandleInboundJSON`, `SendToJS`, `WM_COPYDATA`), `src/mpv/player.cpp` (mpv setup and events), `src/utils/config.cpp` (ini and allowlists), `src/core/globals.cpp` (web UI URLs), `src/node/server.cpp`, `src/utils/helpers.cpp` (`MakeInjectJsScript`), `src/utils/discord.cpp`. The source on `HEAD` is newer than the bundled 5.0.21 exe; where behaviour depends on version, the text says so (allowlist, `media-key`, `win-*` signals).
- Web side: `Stremio/stremio-video` `src/ShellVideo/ShellVideo.js` (property and command protocol), `Stremio/stremio-web` `development` branch `src/common/Platform/shell/useShell.ts` and `src/routes/Player/Player.js` (the official build's newer transport and player handling).
- Live bundles, fetched during analysis: `https://stremio.zarg.me/6f6b0558dbb064bca18a8dcc22cb1f3f4c455b22/{scripts/main.js,styles/main.css}` and `https://web.stremio.com/ca3cb08e51cae3ccf7531eabcd3ad2ee6e90a9d9/{scripts/main.js,styles/main.css}`. Build ids change; re-check them before trusting class hashes or the shortcut table.

---

## 14. Integration notes for the remote (design consequences)

1. **Two web generations exist.** The zarg build (what this shell loads first) speaks the QWebChannel-style envelope (`type 1/3/6/7`, `object:"transport"`). The official `web.stremio.com` build talks to `chrome.webview` with `{id:0, type:6, args:[method, ...args]}` and receives `{type:1, args:[name, data]}` and `{type:3,...}`. They differ in envelope fields. Write the bridge so that sending and parsing go through one small adapter, and detect which one is in use by checking for `window.qt` set by the shim plus the presence of `initShellComm` having been called.
2. **Prefer observing over polling.** All player state already flows as `mpv-prop-change`. The bridge only needs a single `message` listener plus the `send` wrapper. DOM scraping is for navigation state only.
3. **Throttle.** `time-pos` fires many times per second. Send the phone one update per second and always send immediately on `pause`, `aid`, `sid`, `track-list`, `duration`.
4. **Treat mpv writes as best effort.** A write the shell blocks (2A.5) returns only a `Mpv*Blocked` event. Show the failure on the phone, and ship an installer step that appends the needed names to the ini `[Security]` lists.
5. **Never trust the LAN.** The bridge can start playback, quit the app and run shell commands via the daemon. Bind the daemon to the LAN only when a pairing token is set; keep the webmod-to-daemon link on loopback.
6. **Mods run in every document.** Guard on origin, keep the module idempotent (`window.KaiRemote?.initialized`), never throw during setup (a throw re-runs the whole file every 25 ms), and never overwrite `window.onload` or `qt.webChannelTransport.onmessage`.
7. **Update resilience.** Pin on the stable interfaces (transport envelope, mpv property names, `#/` routes). Treat hashed class names as best-effort and always have a stem-based or text-based fallback (`[class*="stem-"]`, `title="Next Video"`, label text).
8. **Version gating.** Read `shellVersion` from the INIT reply and branch on it. The allowlist is known to be absent in 5.0.21 and present in the current source; the exact release that introduced it is unverified (a release note calls 5.0.22 a security patch, which may be it). Rather than hard-coding a version, handle `MpvCommandBlocked` / `MpvSetPropBlocked` at runtime.
9. **Content and artwork do not come from the DOM.** `window.services.core.transport` (state, `NewState` events, deep links) plus the daemon's own image proxy is the intended path. Mirror the PC for now-playing, browse independently for Home and Search, and strip session keys and tokens before anything leaves the PC. Details in section 15.

---

## 15. Artwork, banners and content data for a modern remote

Goal: the phone shows posters, banners, logos and episode art, rotating hero banners, a continue-watching row, search and detail screens, plus a now-playing screen with ambient art. This section lists where every piece of data comes from, what the image URLs look like, and the traps.

### 15.1 Data sources, best first

| # | Source | Reach it with | Gives you | Notes |
|---|---|---|---|---|
| A | **Stremio core state** (the app's own store, runs in a Web Worker) | `window.services.core.transport.getState(model)` (async), `.on("NewState", cb)`, `.dispatch(action, model)` | titles, posters, backgrounds, logos, episode thumbnails, watch progress, deep links, streams, installed add-ons, user settings | `window.services` is set by the app root in **both** web builds [SOURCE: `window.services=` in the zarg `main.js` and in the official `main.js`]. Object keys: `core, shell, chromecast, keyboardShortcuts, dragAndDrop` |
| B | **Kai metadata DB** (IndexedDB `MetadataDB`, table `titles`) | `window.metadataHelper.getTitle(imdbId)`, `.hasTitle`, `.db` (Dexie), `.findExistingTitle(...)` | premium TMDB backdrop and logo (`tmdbBackdrop`, `tmdbLogo`), multi-source ratings, genres, cast, directors, awards, status, runtime, content rating, `isAnime`, tagline | only titles the user has already looked at or the hero banner has processed; fetch on demand with `priorityEnrichTitle` |
| C | **Kai hero banner list** | `window.HeroPlugin.State.heroTitles` (array), `currentIndex`, `currentCatalog` (`movies` or `anime`) | ready-made banner entries: `id, title, background, logo, description, releaseInfo, status, duration, seasons, rating, numericRating, href, type` (shape from `State.fallbackTitles`) | exactly what the PC's home banner rotates; events `hero-banner-created`, `hero-start-rotation`, `hero-stop-rotation` |
| D | **DOM** | `.poster-image-NiV7O` (img src), `.logo-X3hTV` (img + title attr), `.hero-*` elements | whatever is on screen | last resort; hashed classes, see 4.2 |
| E | **Public APIs** | `https://v3-cinemeta.strem.io/meta/<type>/<imdbId>.json`, `.../catalog/<type>/top.json`, installed add-on manifests | same fields as A, independent of the PC screen | what the daemon can call by itself |

Use A for anything that exists in the app's state, B and C to upgrade artwork and for the banner, E when the remote must not disturb the PC screen (see 15.5).

### 15.2 Core models and their image fields [SOURCE: stremio-web `src/core/types`; confirm against a live capture]

Model names accepted by `getState(...)` in the zarg bundle: `ctx, board, continue_watching_preview, discover, library, meta_details, player, search, local_search, installed_addons, remote_addons, calendar, addon_details, streaming_server, data_export`.

| Model | Useful content | Image fields |
|---|---|---|
| `continue_watching_preview` | resume row. Items wrap a library item (shape not in the type files; capture it) | `poster` of the library item, progress from `state.timeOffset / state.duration` |
| `board` (type `CatalogsWithExtra`) | `catalogs[]`, each `{name, type, content: Loadable<MetaItemPreview[]>}` | `poster`, `background`, `logo`, `posterShape` (`poster`, `landscape`, `square`) |
| `discover`, `search` | `catalog.content` / `catalogs[]` of `MetaItemPreview` with `inLibrary`, `deepLinks` | same |
| `library` | `catalog[]` of library items with `progress` and `deepLinks`; `selectable` sorts and types | `poster`, `posterShape` |
| `meta_details` | `metaItem.content` (`MetaItem` + `videos[]`, `inLibrary`, `watched`), `streams[]` per add-on (`Stream[]`: `name`, `description`, `url` or `infoHash` + `fileIdx`, `deepLinks.player`), `ratingInfo` | item `poster`, `background`, `logo`; each `Video` has `thumbnail` (episode image), `overview`, `released`, `season`, `episode`, `watched`, `progress`, `deepLinks` |
| `player` | `metaItem`, `nextVideo`, `seriesInfo {season, episode}`, `selected.stream`, `subtitles[]`, `streamState`, `title` | item `background`, `logo`, `poster`; `nextVideo.thumbnail` |
| `ctx` | `profile.settings` (see below), `searchHistory`, `notifications`, `streamingServerUrls` | none |
| `streaming_server` | `baseUrl`, `statistics`, `casting`, `playbackDevices` | none |
| `installed_addons` | add-on manifests and `transportUrl` | add-on logos |

`MetaItemPreview` fields [SOURCE]: `id, type, name, description, logo, background, poster, posterShape, releaseInfo, runtime, released, trailerStreams[], links[], behaviorHints{defaultVideoId, featuredVideoId, hasScheduledVideos, isLive}`.

**Deep links are ready-made hash routes.** Items and videos carry `deepLinks.metaDetailsVideos`, `deepLinks.metaDetailsStreams`, `deepLinks.player`, and streams carry `deepLinks.player`. The remote never has to build a route: send the string to the bridge and assign it to `location.hash` (check whether it includes the leading `#`; capture one).

**Sensitive fields to strip before anything leaves the PC**: `ctx.profile.auth.key` (Stremio session key), `ctx.profile.auth.user.email`, `trakt.access_token`, `streamingServerUrls`, `remoteHttps`, any stream URL containing a debrid token or API key. Whitelist fields per message instead of forwarding raw state.

**Sizes.** A full `board` state can be hundreds of items. Send the phone only the rows it is showing and fetch more on scroll (the core has `LoadRange` and `LoadNextPage` actions for this, see 15.5).

### 15.3 Image URL formats (probed live)

Default Stremio artwork comes from Metahub and works without any key:

| Asset | URL pattern | Verified |
|---|---|---|
| Poster | `https://images.metahub.space/poster/{small,medium,large}/{imdbId}/img` | 200 `image/jpeg`; no CORS header on small and medium |
| Background (16:9) | `https://images.metahub.space/background/{medium,large}/{imdbId}/img` | 200 `image/jpeg`; `Access-Control-Allow-Origin: *` on large |
| Logo (transparent) | `https://images.metahub.space/logo/{medium,large}/{imdbId}/img` | 200 `image/png`; CORS `*` (medium probed) |
| Episode thumbnail | `https://episodes.metahub.space/{imdbId}/{season}/{episode}/w780.jpg` | 200 `image/jpeg`; CORS `*` |

Cinemeta's `meta` response returns the small poster and medium background and logo (`poster`/`background`/`logo` fields) plus `videos[].thumbnail` episode URLs. Upgrading `small` or `medium` to `large` in the path gives sharper art (large poster and large background returned 200; large logo was not probed).

Kai's TMDB upgrades (`tmdbBackdrop`, `tmdbLogo`, hero `background`/`logo`): base `https://image.tmdb.org/t/p/`, sizes used by the fetcher: poster `w500, w780, original`; backdrop `original, w2160, w1440, w1280`; profile `w185, w300, original`; company logos `w92`; title logos `original`. **TMDB logos can be SVG** (the fetcher explicitly handles `.svg`), so the image proxy must pass SVG through or rasterize it.

Add-on catalogs (anime, Kitsu, custom) return their own hosts and sometimes `http://` or relative URLs; never assume Metahub.

### 15.4 Image pipeline in the daemon (recommended)

Serve every image to the phone through `GET /img?u=<url>&w=<px>` on the daemon instead of letting the phone hit third-party hosts.

- **Why:** (1) mixed content if the remote UI is ever served over HTTPS and the source is `http://`; (2) canvas colour extraction for ambient backgrounds needs CORS, which the small and medium Metahub posters do not send; (3) caching and resizing (the phone never downloads a 4K backdrop); (4) the phone does not leak your viewing habits to image hosts; (5) offline fallback for already seen art.
- **Cache:** disk cache keyed by `sha256(url + width)`, honour `ETag` and `Cache-Control`, long TTL (artwork rarely changes), size cap with LRU eviction.
- **Resize and encode:** Rust `image` (or `fast_image_resize`) to WebP or AVIF at 1x and 2x widths (for example posters 180 and 360, backgrounds 800 and 1600, logos 400 with alpha preserved). Keep alpha for logos. SVG: pass through, or rasterize with `resvg`.
- **Ambient colour:** compute a dominant colour and a tiny blurred placeholder (BlurHash or a 16 px WebP) once per image server-side and send them in the metadata JSON, so cards can paint instantly and the now-playing screen can theme itself.
- **SSRF and abuse guard (mandatory):** the proxy takes a URL from the network. Allow only `https` and `http`, resolve the host and reject loopback, private, link-local and cloud-metadata IP ranges (re-check after every redirect), cap response size (for example 10 MB) and time, accept only `image/*`, and prefer a host allowlist (`images.metahub.space`, `episodes.metahub.space`, `image.tmdb.org`, hosts seen in the user's installed add-ons) that the user can extend. Require the pairing token on this route too.
- **Never proxy** URLs that contain credentials from the stream list.

### 15.5 Two ways to get browse data, and the shared-state trap

The core models `board`, `discover`, `library`, `search`, `meta_details`, `player` are **shared with the PC's screen**. Their content reflects what the PC UI has loaded (`Load` actions are issued by the routes when they mount). Consequences:

1. **Mirror mode (read what the PC shows).** The bridge listens to `NewState`, reads the changed models and forwards sanitized slices. Zero side effects, the phone always matches the TV, but it only has data for the page the TV is currently on (for example no `board` data while the TV is in the player).
2. **Independent mode (the phone browses on its own).** The daemon calls the add-on HTTP API directly (`<transportUrl>/catalog/<type>/<id>.json`, `/meta/<type>/<id>.json`, `/stream/<type>/<id>.json`, with `transportUrl` values taken from `installed_addons`), builds its own rows with art from 15.1 to 15.3, and only when the user selects something does it send a deep link to the bridge (`location.hash = ...`). No shared state is touched, so the TV UI is not disturbed while the phone scrolls. It needs the add-on list, read once from `installed_addons`; add-on URLs can embed user tokens, so never log them.
3. **Dispatching `Load` from the bridge is risky:** it replaces the state the on-screen UI is rendering, so browsing on the phone would change what the TV shows. Avoid it unless "drive the TV UI" is the intended behaviour.

Recommended: mirror mode for the now-playing, continue-watching and detail screens (cheap, accurate), independent mode for Home, Discover and Search.

Search specifically: independent mode queries the catalogs that declare a `search` extra; mirror mode can instead make the PC search (`location.hash = "#/search?query=..."`) and read the `search` model.

### 15.6 Screen-by-screen mapping

| Remote screen | Data | Art |
|---|---|---|
| Home hero carousel | C (`HeroPlugin.State.heroTitles`), or B top entries, or Cinemeta `top` | `background` (TMDB original, resized by the proxy), `logo`, tagline and genre badges from B |
| Continue watching | `continue_watching_preview` (A) | library item `poster`; progress bar from `timeOffset / duration`; episode label from `video_id` |
| Rows (board, discover) | A mirror or E independent | `poster` (shape from `posterShape`), badge for `inLibrary` and watched |
| Search | E independent, or the `search` model | `poster` |
| Detail | `meta_details` (A) or `/meta` (E), plus B for ratings, cast, awards | `background` header, `logo`, per-episode `thumbnail`, watched and progress flags |
| Stream picker | `meta_details.streams[]` (A) or `/stream` (E) | add-on logos; label from `name` and `description` |
| Now playing | `player` model (A) + mpv props (2A.4) + `activity` args (2A.6) | `background` blurred as page backdrop, `logo`, `poster`, `nextVideo.thumbnail` for a "Next episode" card |
| Library | `library` (A) | `poster` |
| Remote settings | `ctx.profile.settings` subset (audio language, subtitle language and style, seek durations, binge watching, hardware decoding) | none |

### 15.7 Other facts that came up

- **libmpv is `mpv v0.39.0-502`** (string in `libmpv-2.dll`, which also contains `user-data` property strings). `user-data/*` properties exist, so a Lua script can publish state with `mp.set_property_native("user-data/kai/<name>", value)` and the web side can observe it with `mpv-observe-prop ["user-data/kai/<name>"]`; it arrives as a normal `mpv-prop-change` with `data` as JSON. No Kai script does this today (`thumbfast.lua` only reads `user-data/frontend/process-path`).
- **Skip-intro state is invisible to the web layer.** `notify_skip` keeps its state in Lua (`skip_state.mode`, `awaiting_confirmation`, the current skippable chapter) and draws the skip button as an ASS overlay. To show "Skip intro" on the phone, add a few lines to `notify_skip` that publish `user-data/kai/skip` (for example `{available, label, start, end, confirm}`) when the overlay is shown or hidden, then call the existing `perform-skip` message. Segments come from chapters, black-frame and silence detection, and the IntroDB service (fetched in Lua by `fetch_introdb_segments` using `imdb_id`, season and episode).
- **`portable_config/mpv/mpv.exe` is a helper for thumbfast** (`script-opts/thumbfast.conf`: `mpv_path=portable_config/mpv/mpv.exe`), not an external player. thumbfast draws seek previews as an overlay inside the PC window, so those frames are **not** available to the phone. For scrub previews on the remote, have the daemon extract frames itself (for example `ffmpeg -ss <t> -i <stream url> -frames:v 1`, using the bundled `ffmpeg.exe`) or call the streaming server's thumbnail route; test which stream URL works (the streaming server's `/<infoHash>/<idx>` for torrents, the add-on `url` for direct links).
- **Titles:** prefer the player model's `metaItem.name` and `title` (what the user sees) over Kai's DB `title`. Kai stores some fields HTML-escaped (`escapeHTML` in the TMDB fetcher), so decode before showing them on the phone.
- **Anime IDs:** items may be keyed `kitsu:`, `mal:` or `anilist:` instead of IMDb. Metahub art needs an IMDb id; for non-IMDb items use the item's own `poster` and `background` from core state, or Kai's resolved `imdb` from B, and never construct Metahub URLs from a non-IMDb id.
- **Library items** use `_id` (the meta id), and their `poster` may be a small image, so prefer the meta item's art when both are available.

### 15.8 What to capture first for this area

With the logging mod running, open the app and in the page console (or from the mod) call `await services.core.transport.getState("continue_watching_preview")`, then `"board"` and `"ctx"`; open a series and read `"meta_details"`; start playback and read `"player"`. Also register `services.core.transport.on("NewState", (m) => console.log(m))`. Save the JSON (with secrets removed) as test fixtures for the Rust types. Also record `HeroPlugin.State.heroTitles[0]` and `await metadataHelper.getTitle("tt0903747")` to fix the exact Kai record shape.
