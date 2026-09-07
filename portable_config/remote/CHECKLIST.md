# Phone Remote — rollout & test checklist

**Code status:** Stages 0–6 are fully implemented and ready to test. Stage 7 is
not built yet. See **Known issues & further work** at the bottom for what's still
open (the main one: D-pad grid nav needs a physical click per session).

Checkbox legend:
- `[x]` verified working
- `[~]` code complete, not yet verified by you
- `[ ]` Stage 7 — not implemented

Reference while testing:
- App DevTools console: `Ctrl+Shift+I` in Stremio Kai
- Lua/mpv log: `<install>\portable_config\LOG.txt`
- Health check: `curl http://127.0.0.1:5000/healthz`
- Manual command: `curl -H "X-Kai-Remote: 1" -H "Content-Type: application/json" -d "{\"cmd\":\"toggle_pause\"}" http://127.0.0.1:5000/cmd`
- Fast web-app iteration: edit `remote/webapp/index.html`, just refresh the phone (server reads it from disk per request)

---

## Stage 0 — Standalone server sanity (no app)

- [x] `python remote/server.py --port 5000` prints `LISTENING <ip>:5000` and one `URL` line per NIC
- [x] `http://127.0.0.1:5000/healthz` returns JSON with `"port": 5000`
- [x] `http://127.0.0.1:5000/` loads the remote UI in a desktop browser
- [x] SSE endpoint streams a state frame; ctypes named-pipe client confirmed against real mpv
- [ ] Phone on same Wi-Fi opens the printed `http://192.168.x.x:5000` (accept the Windows Firewall prompt)
- [ ] Both status pills show red when nothing is connected — expected

## Stage 1 — Supervisor & wiring inside the app

- [x] Fully quit Stremio Kai (check tray), relaunch
- [~] `LOG.txt` shows `[remote-control] ... python.exe found: <path>`
- [~] `LOG.txt` shows `input-ipc-server OK` (or "adopting pipe ...")
- [~] DevTools console shows `[Kai Remote] initialized`
- [~] DevTools console shows `[Kai Remote] selectors/actuators/scrapers loaded`
- [x] Settings page has a **Phone Remote** card
- [~] If `LOG.txt` says `python.exe not auto-detected` → set `python_path=` in `script-opts/remote_control.conf`, toggle the setting off/on

## Stage 2 — Enable & connect

- [x] Settings → Phone Remote → **Enable** toggle on
- [~] `LOG.txt` shows `starting remote server: 0.0.0.0:5000` then `LISTENING`
- [x] Settings card shows an `http://<ip>:5000` address
- [x] Phone opens that address — app loads
- [x] Phone: **ui** pill green
- [x] Start playing something on the PC → phone **player** pill green
- [~] `curl .../healthz` shows `"mpv_connected": true` while playing

## Stage 3 — Transport controls (Now Playing tab)

Play a movie, then from the phone:

- [~] Title + play/pause state show correctly
- [~] Scrubber tracks position; dragging it seeks on the PC
- [~] Play / Pause button toggles playback **without** the PC UI desyncing
- [~] −10s / +10s / −85s / +85s seek
- [~] Volume slider changes PC volume; Mute works
- [~] Speed 1x / 1.5x / 2x
- [~] Audio track dropdown switches track
- [~] Subtitle dropdown switches / turns off subs
- [~] Trigger an intro → **Skip Intro/Outro** button fires the skip
- [~] Play a series → **Next Episode** advances

> If play/pause over IPC desyncs the PC player: change `toggle_pause` in
> `server.py`'s `MPV_COMMANDS` to route through the webmod (`nav_ok` /
> synthetic `MediaPlayPause`) instead.

## Stage 4 — Navigation (Navigate tab)

- [~] D-pad arrows move focus around the Stremio UI on the PC
- [~] OK activates the focused item / play-pauses on the player
- [~] Back and Home work
- [~] Page buttons (Board / Discover / Library / Calendar / Settings) navigate
- [~] Subs menu / Audio menu / Fullscreen / Stop (player-only) work

## Stage 5 — Browse & launch (Browse tab)

- [~] On PC Board: phone Browse shows the catalog rows with posters
- [~] Tap a movie poster → PC opens its detail page
- [~] Streams list appears on the phone → tap one → playback starts
- [~] Phone auto-switches to Now Playing when playback begins
- [~] Series: open detail → episode list shows on phone → tap S/E → streams → launch
- [~] Search box: type a query → results appear → open one
- [~] Continue Watching item → resumes immediately (not just detail page)
- [~] Where a list is empty/wrong: inspect the live DOM in DevTools and fix the
      matching selector in `webmods/Remote/selectors.js`

> Browse/launch selectors are best-effort and only lightly exercised — expect
> to tune `selectors.js` here.

## Stage 6 — Edge cases

- [~] Kill `python.exe` in Task Manager → `LOG.txt` shows a respawn within ~3s, phone reconnects
- [~] Disable the toggle in Settings → server stops, phone pills go red
- [~] Re-enable → comes back
- [~] Change the port in Settings → server restarts on the new port, phone address updates
- [~] Set a PIN → phone must reconnect via the new URL (contains `#t=`); a plain URL is rejected
- [~] Quit Stremio Kai → no orphan `python.exe` left running
- [~] Second phone can connect at the same time; both see the same state
- [~] Lock/roam Wi-Fi → reopen Settings shows the current LAN address

## Stage 7 — Polish (NOT implemented)

- [ ] Vendor an MIT QR generator into `remote/webapp/qr.min.js`, render a QR of the URL in the Settings card
- [ ] Buffering % indicator on the scrubber
- [ ] Chapter list / chapter skip buttons
- [ ] Subtitle & audio delay controls
- [ ] Multi-NIC picker in Settings when several addresses exist
- [ ] `player_prev_video` (currently a no-op — Stremio has no prev control)
- [ ] Re-verify every selector in `selectors.js` after any `stremio-community-v5` rebase

---

## Known issues & further work

### 1. D-pad grid navigation needs one physical click per session  *(open — biggest gap)*

Off the player, arrow commands from the phone only scroll / don't enter the
catalogue grid until the user physically clicks the Stremio window once. After
that, everything works for the rest of the session.

Root cause: `_activate_window()` (`server.py`) foregrounds the top-level window,
but that gives the WebView2 (Chromium) child neither OS input focus nor
[transient user activation]. `navigation.js`'s spatial-nav keydown handler and
React's own focus machinery need the web surface truly focused. `element.click()`
from a webmod is `isTrusted:false` so JS can't self-fix it.

What was tried this round and **reverted** (didn't hold up):
- `SendInput` / `PostMessage(WM_LBUTTONDOWN/UP)` synthesized click into the
  render-widget HWND. The click *did* land and grant focus, but it kept hitting
  the Stremio logo (`div.logo-container-jteMT`, top-left) → navigation.js routes
  a logo click to Board, so every command bounced you home. A webmod-provided
  "safe point" (gap in the top nav bar) was added then also removed.
- `SetFocus` walking the WebView2 child's parent chain — no visible effect.

What still works and stayed in (`REAL_KEY_COMMANDS` in `server.py`):
- `toggle_fullscreen`, `toggle_pause` inject a real `SendInput` keystroke after
  foregrounding. Fullscreen confirmed working from the phone with the window
  backgrounded (it previously threw `Permissions check failed` because
  `requestFullscreen()` needs a gesture).

Options not yet tried, roughly in order of preference:
- [ ] **Route `nav_dpad` through `SendInput` real arrow keys** (like fullscreen).
      Real trusted arrows + whatever focus the foreground gives may be enough for
      `navigation.js` to drive the grid. Cheapest next step; never actually tested.
- [ ] **Synthesized click at a genuinely safe pixel.** Needs a point that
      navigates nowhere on every route — the nav-bar gap idea was on the right
      track but flaky; a webmod that reports the rect of a known-inert element
      each state POST would be more reliable than a hard-coded pixel.
- [ ] **Fix it in the C++ shell** via `ICoreWebView2Controller::MoveFocus` on
      window activate. Correct fix, but lives in `Zaarrg/stremio-community-v5`,
      not this repo.

Diagnostic aid left in place: set `localStorage kai-remote-debug=true` in the
Stremio DevTools console + reload → `remote-client.js` logs every
pointer/click/focus event and per-command `hasFocus` / `userActivation` state.

### 2. Orphaned command handlers — decide keep vs. delete

The web app no longer sends these; handlers still exist in `WEBMOD_COMMANDS`
(`server.py`) and `actuators.js`:
- [ ] `toggle_subs_menu`, `toggle_audio_menu` — buttons were removed when the
      player panel moved to `set_sub_track` / `add_sub_delay` etc. Dead unless
      re-added.
- [ ] `open_detail`, `open_streams` — superseded by `open_details` / `open_item`.
      Arguably keep as a generic hash-nav API.
- [ ] `nav_hash` — no caller; generic, low cost to keep.

### 3. Smaller cleanups

- [ ] `actuators.js` `pick_episode` calls `Scrapers.episodeRows()` with no arg;
      the scraper now takes `episodeRows(activeSeason)` for season backfill. Pass
      the active season through.
- [ ] `actuators.js` `toggle_fullscreen` comment claims the control-bar button
      needs "no user gesture" — false (that's why fullscreen moved to
      `SendInput`). It's only the fallback path now; fix the comment.
- [ ] `actuators.js` logs a hard-coded `"(v1.1.7)"` string — drifts from
      `@version`.
- [ ] `stremio-settings.ini` `[Window]` geometry is rewritten by the app on every
      close — decide whether to keep tracking it or gitignore.

[transient user activation]: https://developer.mozilla.org/en-US/docs/Web/Security/User_activation
