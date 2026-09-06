# Phone Remote — rollout & test checklist

**Code status:** Stages 0–6 are fully implemented and ready to test. Stage 7 is
not built yet.

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
