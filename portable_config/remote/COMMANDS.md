# Phone Remote - how commands are handled

Every command the phone issues is a `POST /cmd` with a JSON body
`{"cmd": "<name>", "args": {...}}` and the header `X-Kai-Remote: 1`. The server
(`server.py`, `Handler._handle_cmd`) routes each `cmd` down exactly one of three
paths, decided purely by which lookup table the name appears in.

```
phone  --POST /cmd-->  server.py _handle_cmd
                         |
       +-----------------+----------------------------------+
       |                 |                                  |
  MPV_COMMANDS      REAL_KEY_COMMANDS                   WEBMOD_COMMANDS
  (named pipe)      (SendInput real key)               (webmod long-poll)
       |                 |                                  |
   \\.\pipe\kai-mpv   foreground window +               GET /webmod/poll
   -> mpv IPC         OS keystroke -> Stremio           -> KaiRemote.Actuators
```

## 1. `MPV_COMMANDS` - straight to mpv over the named pipe

Transport / render state that mpv owns outright: seek, volume, speed, track
selection, sub and audio delay, chapters, `panscan` (ultrawide zoom), `stop`,
`perform_skip`. Each entry is `lambda args -> [mpv command array]`, sent over
`\\.\pipe\kai-mpv` with `send_command(..., want_result=False)`.

- No web UI involved, no focus needed, works whether or not the Stremio window
  is foreground.
- Guard: if the route view is known and is not `PLAYER` and the pipe is not
  connected, the server answers `{"ok": false, "reason": "no playback"}`.
- `set_pause` lives here but is **not** how the phone's play/pause button works
  (see below) - the web UI re-asserts pause state and would fight an
  out-of-band unpause.

## 2. `REAL_KEY_COMMANDS` - a real keypress via `SendInput`

Player shortcuts that Stremio's **web UI** handles but only from a genuine user
gesture. The synthetic `KeyboardEvent` the webmod dispatches is
`isTrusted: false` and carries no [transient activation], so these silently
failed from the phone - fullscreen threw `TypeError: Permissions check failed`
(`document.*.requestFullscreen()`), and only worked for one press right after a
physical click on the window.

| cmd | key | VK |
|-----|-----|----|
| `toggle_fullscreen` | `F` | `0x46` |
| `toggle_pause` | `Space` | `0x20` |

Flow in `_handle_cmd` (these names are also in `WEBMOD_COMMANDS`, so this runs
inside that branch, first):

1. `_activate_window()` pulls the Stremio Kai window to the foreground
   (`SetForegroundWindow` + the `AttachThreadInput` dance, matched by
   `--host-pid`).
2. `_send_key(vk)` injects one real key-down + key-up with `SendInput`.
   `SendInput` always targets the current foreground window, hence step 1.
3. On success the server returns `{"ok": true, "via": "sendkey"}` and stops.
   If injection fails (non-Windows, `SendInput` blocked by UIPI, etc.) it falls
   through to the webmod path with the synthetic event as a best-effort
   fallback.

`_send_key` is Windows-only and self-contained (defines the `INPUT` /
`KEYBDINPUT` ctypes structs inline, standard-library only).

## 3. `WEBMOD_COMMANDS` - queued for the browser webmod

Everything that needs the DOM / React app: route navigation (`nav_home`,
`nav_page`, `nav_hash`, `nav_back`), opening details / streams, episode and
season picking, catalog scraping triggers, `search`, `instant_resume`,
`launch_stream`.

These work by scraping the page and clicking real elements / changing
`location.hash`, which do **not** need the WebView2 surface focused - unlike
driving Stremio's on-screen focus ring, which is why the old D-pad
(`nav_dpad` / `nav_ok`) was removed (see `CHECKLIST.md`).

Flow:

1. `_activate_window()` foregrounds the window (`SetForegroundWindow` + the
   `AttachThreadInput` dance) - kept mainly for the `REAL_KEY_COMMANDS` path;
   the DOM/hash work below doesn't strictly need it.
2. `webq.push(cmd, args)` enqueues the command.
3. `webmods/Remote/remote-client.js` is long-polling `GET /webmod/poll`
   (`webq.drain`, 25 s hold). It pulls the queue, and for each item calls
   `window.KaiRemote.Actuators[cmd](args)` (`actuators.js`).
4. The actuator does its DOM work - a `location.hash` change, or a physical-style
   `mousedown`/`mouseup`/`click` (`clickReal`) on a scraped element.
5. Results are POSTed back as `acks` on the next `POST /webmod/state`, alongside
   a fresh scrape of route + catalog + player UI state.

## Adding a command

- **Pure mpv property or command?** Add to `MPV_COMMANDS`.
- **A player keyboard shortcut the web UI owns, needs a gesture?** Add the name
  to `WEBMOD_COMMANDS` *and* to `REAL_KEY_COMMANDS` with its VK, and give
  `actuators.js` a synthetic fallback under the same name. Only add it to
  `REAL_KEY_COMMANDS` once the web app actually sends it.
- **DOM / navigation / scraping?** Add to `WEBMOD_COMMANDS` and implement
  `Actuators.<cmd>` in `actuators.js`. Keep every hashed selector in
  `selectors.js`.

Manual test:

```
curl -H "X-Kai-Remote: 1" -H "Content-Type: application/json" \
     -d "{\"cmd\":\"toggle_fullscreen\"}" http://127.0.0.1:5000/cmd
```

[transient activation]: https://developer.mozilla.org/en-US/docs/Web/Security/User_activation
