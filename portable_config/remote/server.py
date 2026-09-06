#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Stremio Kai - Phone Remote server
=================================

@version 1.0.0
@author  allecsc / Stremio Kai
@requires Python 3.8+ standard library only (ships as portable_config/../python.exe)

A single-file LAN remote-control hub. Spawned and supervised by
scripts/remote-control/main.lua. Bridges three connections:

    Phone browser  <--HTTP: SSE + POST-->  server.py  <--named pipe-->  main mpv
                                              ^  |
                            fetch long-poll / |  v  POST /webmod/state
                            queued commands   Remote webmod (window.KaiRemote)

  * Phone  <-> server : GET /  GET /events (SSE)  POST /cmd  GET /healthz  GET /poll
  * server <-> mpv    : \\.\pipe\<pipe>  JSON IPC  (real playback state + transport)
  * server <-> webmod : GET /webmod/poll (long-poll)  POST /webmod/state
                        (route nav, DOM scraping, synthetic events, stream launch)

Design notes
------------
  * SSE + POST, not a hand-rolled WebSocket. State is high-frequency server->phone
    (SSE's native case); commands are low-frequency phone->server (plain POST).
  * ThreadingHTTPServer, one pipe reader thread, one guarded writer, one StateStore
    behind a Lock with a Condition to wake blocked SSE / long-poll handlers.
  * The webapp is read from disk per request - edit remote/webapp/* and refresh the
    phone, no restart needed.

Command-line
------------
  python server.py --port 5000 --host 0.0.0.0 --pipe kai-mpv --token ""

Prints one line to stdout when the listen socket is up (captured into LOG.txt):
  LISTENING <primary-ip>:<port>
  URL http://<candidate-ip>:<port>        (one per NIC)
"""

import argparse
import atexit
import hmac
import json
import os
import signal
import socket
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IS_WINDOWS = os.name == "nt"
HERE = os.path.dirname(os.path.abspath(__file__))
WEBAPP_DIR = os.path.join(HERE, "webapp")

# Properties we ask mpv to observe. Each maps 1:1 into the state snapshot.
OBSERVED_PROPERTIES = [
    "pause",
    "time-pos",
    "duration",
    "percent-pos",
    "media-title",
    "path",
    "filename",
    "track-list",
    "aid",
    "sid",
    "speed",
    "volume",
    "mute",
    "sub-delay",
    "audio-delay",
    "chapter",
    "chapter-list",
    "eof-reached",
    "core-idle",
    "fullscreen",
    "demuxer-cache-state",
]

# Transport commands actuated directly against mpv over the pipe.
# value is a callable(args:dict) -> list  (an mpv "command" array)
def _clamp(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return lo
    return max(lo, min(hi, v))


MPV_COMMANDS = {
    "toggle_pause":      lambda a: ["cycle", "pause"],
    "set_pause":         lambda a: ["set_property", "pause", bool(a.get("value"))],
    "seek_relative":     lambda a: ["seek", _clamp(a.get("secs", 0), -3600, 3600), "relative"],
    "seek_absolute":     lambda a: ["seek", _clamp(a.get("pos", 0), 0, 1e7), "absolute"],
    "seek_percent":      lambda a: ["seek", _clamp(a.get("pct", 0), 0, 100), "absolute-percent"],
    "frame_step":        lambda a: ["frame-step"],
    "frame_back_step":   lambda a: ["frame-back-step"],
    "set_volume":        lambda a: ["set_property", "volume", _clamp(a.get("value", 100), 0, 130)],
    "mute":              lambda a: ["cycle", "mute"],
    "set_speed":         lambda a: ["set_property", "speed", _clamp(a.get("value", 1), 0.1, 4)],
    "set_audio_track":   lambda a: ["set_property", "aid", a.get("id", "auto")],
    "set_sub_track":     lambda a: ["set_property", "sid", a.get("id", "auto")],
    "sub_seek":          lambda a: ["sub-seek", int(a.get("n", 1))],
    "add_sub_delay":     lambda a: ["add", "sub-delay", _clamp(a.get("s", 0), -60, 60)],
    "add_audio_delay":   lambda a: ["add", "audio-delay", _clamp(a.get("s", 0), -60, 60)],
    "chapter_next":      lambda a: ["add", "chapter", 1],
    "chapter_prev":      lambda a: ["add", "chapter", -1],
    "stop_playback":     lambda a: ["stop"],
    "perform_skip":      lambda a: ["script-message-to", "notify_skip", "perform-skip"],
    "toggle_fullscreen": lambda a: ["cycle", "fullscreen"],
}

# Commands forwarded to the webmod (things mpv IPC cannot do). Just a whitelist -
# the webmod knows how to actuate each one.
WEBMOD_COMMANDS = {
    "nav_dpad", "nav_ok", "nav_back", "nav_home", "nav_page", "nav_hash",
    "player_next_video", "player_prev_video",
    "toggle_subs_menu", "toggle_audio_menu",
    "open_detail", "open_streams", "pick_episode", "launch_stream",
    "instant_resume", "search", "refresh_browse",
}


# ---------------------------------------------------------------------------
#  Named-pipe / socket transport to mpv
# ---------------------------------------------------------------------------

class _WinPipe:
    r"""Blocking bidirectional client for a Windows named pipe via ctypes.

    A plain open(r'\\.\pipe\name', 'r+b') often works, but ctypes CreateFileW is
    reliable across Python builds and lets us set the byte-mode + overlapped
    flags mpv expects.
    """

    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    OPEN_EXISTING = 3
    ERROR_PIPE_BUSY = 231
    ERROR_FILE_NOT_FOUND = 2

    def __init__(self, name):
        import ctypes
        from ctypes import wintypes

        self._k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._ctypes = ctypes
        self._wintypes = wintypes
        self._path = r"\\.\pipe\{}".format(name)
        self._handle = None
        # INVALID_HANDLE_VALUE is (HANDLE)-1; as an unsigned pointer that is
        # 2**bits - 1. Compare against that, not against -1.
        self._invalid = (1 << (8 * ctypes.sizeof(ctypes.c_void_p))) - 1

        self._k32.CreateFileW.restype = wintypes.HANDLE
        self._k32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        self._k32.ReadFile.restype = wintypes.BOOL
        self._k32.ReadFile.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
        ]
        self._k32.WriteFile.restype = wintypes.BOOL
        self._k32.WriteFile.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
        ]

    def connect(self, timeout=3.0):
        ctypes = self._ctypes
        deadline = time.time() + timeout
        while True:
            h = self._k32.CreateFileW(
                self._path,
                self.GENERIC_READ | self.GENERIC_WRITE,
                0, None, self.OPEN_EXISTING, 0, None,
            )
            h_int = h if isinstance(h, int) else (h or 0)
            if h and h_int != self._invalid:
                self._handle = h
                return
            err = ctypes.get_last_error()
            if err in (self.ERROR_PIPE_BUSY, self.ERROR_FILE_NOT_FOUND) and time.time() < deadline:
                time.sleep(0.15)
                continue
            raise OSError("CreateFileW failed on {} (err {})".format(self._path, err))

    def write(self, data):
        ctypes = self._ctypes
        wintypes = self._wintypes
        written = wintypes.DWORD(0)
        ok = self._k32.WriteFile(
            self._handle, data, len(data), ctypes.byref(written), None
        )
        if not ok:
            raise OSError("WriteFile failed (err {})".format(ctypes.get_last_error()))

    def read_some(self, n=4096):
        ctypes = self._ctypes
        wintypes = self._wintypes
        buf = ctypes.create_string_buffer(n)
        got = wintypes.DWORD(0)
        ok = self._k32.ReadFile(self._handle, buf, n, ctypes.byref(got), None)
        if not ok:
            raise OSError("ReadFile failed (err {})".format(ctypes.get_last_error()))
        return buf.raw[: got.value]

    def close(self):
        if self._handle is not None:
            try:
                self._k32.CloseHandle(self._handle)
            except Exception:
                pass
            self._handle = None


class _UnixSock:
    """Client for a unix-domain socket path (for non-Windows local testing)."""

    def __init__(self, path):
        self._path = path
        self._sock = None

    def connect(self, timeout=3.0):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(self._path)
        s.settimeout(None)
        self._sock = s

    def write(self, data):
        self._sock.sendall(data)

    def read_some(self, n=4096):
        return self._sock.recv(n)

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None


class MpvPipe(threading.Thread):
    """Owns the connection to mpv: reconnect-forever reader + guarded writer."""

    def __init__(self, pipe_name, store):
        super().__init__(name="mpv-pipe", daemon=True)
        self._pipe_name = pipe_name
        self._store = store
        self._transport = None
        self._write_lock = threading.Lock()
        self._req_id = 0
        self._pending = {}          # request_id -> [event, result_holder]
        self._pending_lock = threading.Lock()
        self._stop = threading.Event()
        self._last_ok = 0.0

    # -- public -----------------------------------------------------------
    def stop(self):
        self._stop.set()
        t = self._transport
        if t:
            t.close()

    def last_ok(self):
        return self._last_ok

    def send_command(self, command_array, want_result=False, timeout=2.0):
        """Send an mpv IPC command. Returns (ok, data)."""
        t = self._transport
        if t is None:
            return False, "mpv pipe not connected"
        with self._pending_lock:
            self._req_id += 1
            rid = self._req_id
            holder = {}
            ev = threading.Event()
            self._pending[rid] = (ev, holder)
        payload = json.dumps({"command": command_array, "request_id": rid}) + "\n"
        try:
            with self._write_lock:
                t.write(payload.encode("utf-8"))
        except OSError as e:
            with self._pending_lock:
                self._pending.pop(rid, None)
            return False, "write failed: {}".format(e)
        if not want_result:
            return True, None
        if ev.wait(timeout):
            return holder.get("error") == "success", holder.get("data")
        with self._pending_lock:
            self._pending.pop(rid, None)
        return False, "timeout waiting for mpv"

    def get_property(self, name, timeout=2.0):
        ok, data = self.send_command(["get_property", name], want_result=True, timeout=timeout)
        return data if ok else None

    # -- thread ---------------------------------------------------------------
    def run(self):
        backoff = 0.5
        while not self._stop.is_set():
            try:
                self._connect_and_pump()
                backoff = 0.5
            except Exception as e:
                self._store.set_pipe_connected(False, str(e))
            if self._stop.is_set():
                break
            time.sleep(backoff)
            backoff = min(backoff * 1.7, 5.0)

    def _connect_and_pump(self):
        if IS_WINDOWS:
            t = _WinPipe(self._pipe_name)
        else:
            # local dev: treat pipe_name as a socket path if it looks like one
            path = self._pipe_name if "/" in self._pipe_name else "/tmp/{}.sock".format(self._pipe_name)
            t = _UnixSock(path)
        t.connect()
        self._transport = t
        self._store.set_pipe_connected(True, None)

        # Ask for the initial values + change events.
        for i, prop in enumerate(OBSERVED_PROPERTIES):
            self.send_command(["observe_property", i + 1, prop])

        buf = b""
        while not self._stop.is_set():
            chunk = t.read_some(65536)
            if not chunk:
                raise OSError("mpv pipe EOF")
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    self._handle_line(line)

    def _handle_line(self, raw):
        try:
            msg = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            return
        self._last_ok = time.time()

        if "request_id" in msg and "event" not in msg:
            rid = msg["request_id"]
            with self._pending_lock:
                entry = self._pending.pop(rid, None)
            if entry:
                ev, holder = entry
                holder["error"] = msg.get("error")
                holder["data"] = msg.get("data")
                ev.set()
            return

        event = msg.get("event")
        if event == "property-change":
            self._store.update_mpv_prop(msg.get("name"), msg.get("data"))
        elif event in ("end-file", "start-file", "file-loaded", "playback-restart", "seek"):
            self._store.bump(force=True)


# ---------------------------------------------------------------------------
#  State + broadcast
# ---------------------------------------------------------------------------

class StateStore:
    """Merged snapshot: mpv properties + last webmod payload + connection flags."""

    TIMEPOS_HZ = 2.0  # throttle time-pos-only broadcasts

    def __init__(self):
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._seq = 0
        self._mpv = {}
        self._webmod = {}
        self._pipe_connected = False
        self._pipe_error = None
        self._webmod_seen = 0.0
        self._last_timepos_push = 0.0
        self._history = deque(maxlen=8)   # (seq, snapshot-json)

    # -- writers ------------------------------------------------------------
    def update_mpv_prop(self, name, value):
        if not name:
            return
        with self._cond:
            self._mpv[name] = value
            now = time.time()
            only_timepos = name in ("time-pos", "percent-pos", "demuxer-cache-state")
            if only_timepos and (now - self._last_timepos_push) < (1.0 / self.TIMEPOS_HZ):
                return
            if only_timepos:
                self._last_timepos_push = now
            self._bump_locked()

    def set_pipe_connected(self, connected, error):
        with self._cond:
            changed = connected != self._pipe_connected
            self._pipe_connected = connected
            self._pipe_error = error
            if not connected:
                self._mpv = {}
            if changed:
                self._bump_locked()

    def update_webmod(self, payload):
        with self._cond:
            was_live = (time.time() - self._webmod_seen) < 10.0
            self._webmod_seen = time.time()
            if isinstance(payload, dict):
                changed = json.dumps(payload, sort_keys=True) != json.dumps(
                    self._webmod, sort_keys=True
                )
                self._webmod = payload
                if changed or not was_live:
                    self._bump_locked()
            else:
                self._bump_locked()

    def bump(self, force=False):
        with self._cond:
            self._bump_locked()

    # -- internal ---------------------------------------------------------
    def _bump_locked(self):
        self._seq += 1
        snap = self._snapshot_locked()
        self._history.append((self._seq, snap))
        self._cond.notify_all()

    def _snapshot_locked(self):
        mpv = self._mpv
        tl = mpv.get("track-list") or []
        audio = [t for t in tl if t.get("type") == "audio"]
        subs = [t for t in tl if t.get("type") == "sub"]
        cache = mpv.get("demuxer-cache-state") or {}
        webmod_live = (time.time() - self._webmod_seen) < 10.0
        return json.dumps({
            "seq": self._seq,
            "ts": round(time.time(), 3),
            "connections": {
                "mpv": self._pipe_connected,
                "mpv_error": self._pipe_error,
                "webmod": webmod_live,
            },
            "player": {
                "pause": mpv.get("pause"),
                "time_pos": mpv.get("time-pos"),
                "duration": mpv.get("duration"),
                "percent_pos": mpv.get("percent-pos"),
                "media_title": mpv.get("media-title"),
                "path": mpv.get("path"),
                "speed": mpv.get("speed"),
                "volume": mpv.get("volume"),
                "mute": mpv.get("mute"),
                "sub_delay": mpv.get("sub-delay"),
                "audio_delay": mpv.get("audio-delay"),
                "chapter": mpv.get("chapter"),
                "chapters": mpv.get("chapter-list") or [],
                "eof": mpv.get("eof-reached"),
                "idle": mpv.get("core-idle"),
                "fullscreen": mpv.get("fullscreen"),
                "buffering_pct": cache.get("cache-duration"),
                "aid": mpv.get("aid"),
                "sid": mpv.get("sid"),
                "audio_tracks": [
                    {"id": t.get("id"), "title": t.get("title"),
                     "lang": t.get("lang"), "selected": t.get("selected")}
                    for t in audio
                ],
                "sub_tracks": [
                    {"id": t.get("id"), "title": t.get("title"),
                     "lang": t.get("lang"), "selected": t.get("selected")}
                    for t in subs
                ],
            },
            "webmod": self._webmod,
        }, separators=(",", ":"))

    # -- readers ----------------------------------------------------------
    def current(self):
        with self._lock:
            if not self._history:
                self._history.append((self._seq, self._snapshot_locked()))
            return self._history[-1]

    def wait_after(self, since_seq, timeout):
        """Block until seq > since_seq (or timeout). Returns (seq, snapshot) or None."""
        with self._cond:
            deadline = time.time() + timeout
            while self._seq <= since_seq:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self._cond.wait(remaining)
            for seq, snap in self._history:
                if seq > since_seq:
                    return seq, snap
            return self._history[-1] if self._history else None

    def pipe_connected(self):
        with self._lock:
            return self._pipe_connected

    def route_view(self):
        with self._lock:
            return ((self._webmod.get("route") or {}).get("view")) if self._webmod else None


class WebmodQueue:
    """FIFO of commands destined for the webmod + ack futures keyed by cmd_id."""

    def __init__(self):
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._q = deque()
        self._acks = {}       # cmd_id -> {event, result}
        self._counter = 0

    def push(self, cmd, args, want_ack=False, timeout=6.0):
        with self._cond:
            self._counter += 1
            cid = "w{}".format(self._counter)
            item = {"cmd_id": cid, "cmd": cmd, "args": args or {}}
            self._q.append(item)
            holder = None
            if want_ack:
                holder = {"event": threading.Event(), "result": None}
                self._acks[cid] = holder
            self._cond.notify_all()
        if not want_ack:
            return True, None
        if holder["event"].wait(timeout):
            return True, holder["result"]
        with self._lock:
            self._acks.pop(cid, None)
        return False, "webmod ack timeout"

    def drain(self, timeout=25.0):
        """Long-poll: return queued items, waiting up to `timeout` for the first."""
        with self._cond:
            if not self._q:
                self._cond.wait(timeout)
            out = list(self._q)
            self._q.clear()
            return out

    def ack(self, cmd_id, result):
        with self._lock:
            holder = self._acks.pop(cmd_id, None)
        if holder:
            holder["result"] = result
            holder["event"].set()


# ---------------------------------------------------------------------------
#  HTTP handler
# ---------------------------------------------------------------------------

_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "StremioKaiRemote/1.0"
    protocol_version = "HTTP/1.1"

    # injected by make_server()
    cfg = None
    store = None
    pipe = None
    webq = None
    sse_count = None  # list([int]) mutable counter

    def log_message(self, fmt, *args):
        # keep LOG.txt quiet; uncomment for debugging
        pass

    # -- helpers --------------------------------------------------------------
    def _token_ok(self):
        want = self.cfg["token"]
        if not want:
            return True
        got = None
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            got = auth[7:]
        if got is None:
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            got = (q.get("t") or [None])[0]
        return got is not None and hmac.compare_digest(str(got), str(want))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Kai-Remote")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, data, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {}

    # -- verbs --------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Kai-Remote")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        from urllib.parse import urlparse
        path = urlparse(self.path).path

        if path == "/healthz":
            return self._handle_healthz()

        # everything else needs the token
        if not self._token_ok():
            return self._send_json({"error": "unauthorized"}, 401)

        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path == "/events":
            return self._handle_sse()
        if path == "/poll":
            return self._handle_poll()
        if path == "/webmod/poll":
            return self._handle_webmod_poll()
        if path.startswith("/webapp/"):
            return self._serve_static(path[len("/webapp/"):])
        if path in ("/qr.min.js",):
            return self._serve_static("qr.min.js")
        return self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        from urllib.parse import urlparse
        path = urlparse(self.path).path

        if not self._token_ok():
            return self._send_json({"error": "unauthorized"}, 401)

        if path == "/cmd":
            return self._handle_cmd()
        if path == "/webmod/state":
            return self._handle_webmod_state()
        if path == "/webmod/ack":
            return self._handle_webmod_ack()
        return self._send_json({"error": "not found"}, 404)

    # -- endpoints ----------------------------------------------------------
    def _handle_healthz(self):
        return self._send_json({
            "ok": True,
            "port": self.cfg["port"],
            "urls": self.cfg["urls"],
            "token_required": bool(self.cfg["token"]),
            "mpv_connected": self.store.pipe_connected(),
            "sse_clients": self.sse_count[0],
            "version": "1.0.0",
        })

    def _serve_static(self, rel):
        rel = rel.replace("\\", "/").lstrip("/")
        if ".." in rel.split("/"):
            return self._send_json({"error": "bad path"}, 400)
        full = os.path.normpath(os.path.join(WEBAPP_DIR, rel))
        if not full.startswith(WEBAPP_DIR) or not os.path.isfile(full):
            return self._send_json({"error": "not found"}, 404)
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as fh:
            data = fh.read()
        return self._send_bytes(data, _STATIC_TYPES.get(ext, "application/octet-stream"))

    def _handle_cmd(self):
        if self.headers.get("X-Kai-Remote") != "1":
            return self._send_json({"error": "missing X-Kai-Remote header"}, 400)
        body = self._read_body()
        cmd = body.get("cmd")
        args = body.get("args") or {}

        if cmd in MPV_COMMANDS:
            view = self.store.route_view()
            transport_like = cmd not in ("toggle_fullscreen",)
            if transport_like and view not in (None, "PLAYER") and not self.store.pipe_connected():
                return self._send_json({"ok": False, "reason": "no playback"})
            arr = MPV_COMMANDS[cmd](args)
            ok, data = self.pipe.send_command(arr, want_result=False)
            return self._send_json({"ok": ok, "detail": data})

        if cmd in WEBMOD_COMMANDS:
            want_ack = bool(body.get("wait"))
            ok, res = self.webq.push(cmd, args, want_ack=want_ack)
            return self._send_json({"ok": ok, "result": res})

        return self._send_json({"error": "unknown cmd: {}".format(cmd)}, 400)

    def _handle_sse(self):
        if self.sse_count[0] >= 8:
            return self._send_json({"error": "too many clients"}, 503)
        self.sse_count[0] += 1
        self.close_connection = True  # streaming response, don't keep-alive
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            last_id = self.headers.get("Last-Event-ID")
            since = int(last_id) if (last_id and last_id.isdigit()) else -1
            seq, snap = self.store.current()
            self._sse_write(seq, snap)
            since = seq

            while True:
                res = self.store.wait_after(since, timeout=15.0)
                if res is None:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                since, snap = res
                self._sse_write(since, snap)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.sse_count[0] -= 1

    def _sse_write(self, seq, snapshot_json):
        self.wfile.write("id: {}\ndata: {}\n\n".format(seq, snapshot_json).encode("utf-8"))
        self.wfile.flush()

    def _handle_poll(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        since = int((q.get("since") or ["-1"])[0])
        res = self.store.wait_after(since, timeout=25.0)
        if res is None:
            seq, snap = self.store.current()
            return self._send_bytes(snap.encode("utf-8"), "application/json")
        seq, snap = res
        return self._send_bytes(snap.encode("utf-8"), "application/json")

    def _handle_webmod_poll(self):
        items = self.webq.drain(timeout=25.0)
        return self._send_json({"commands": items})

    def _handle_webmod_state(self):
        body = self._read_body()
        self.store.update_webmod(body.get("state") or body)
        for ack in body.get("acks") or []:
            self.webq.ack(ack.get("cmd_id"), ack)
        return self._send_json({"ok": True})

    def _handle_webmod_ack(self):
        body = self._read_body()
        self.webq.ack(body.get("cmd_id"), body)
        return self._send_json({"ok": True})


# ---------------------------------------------------------------------------
#  wiring / main
# ---------------------------------------------------------------------------

def lan_ip_candidates():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    if not ips:
        ips.append("127.0.0.1")
    return ips


def make_server(cfg, store, pipe, webq):
    sse_count = [0]

    class Bound(Handler):
        pass

    Bound.cfg = cfg
    Bound.store = store
    Bound.pipe = pipe
    Bound.webq = webq
    Bound.sse_count = sse_count

    httpd = ThreadingHTTPServer((cfg["host"], cfg["port"]), Bound)
    httpd.daemon_threads = True
    httpd.allow_reuse_address = True
    return httpd


def main(argv=None):
    ap = argparse.ArgumentParser(description="Stremio Kai phone remote server")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--pipe", default="kai-mpv")
    ap.add_argument("--token", default="")
    ap.add_argument("--pidfile", default="")
    args = ap.parse_args(argv)

    if args.pidfile:
        try:
            with open(args.pidfile, "w") as fh:
                fh.write(str(os.getpid()))
        except OSError:
            pass

    ips = lan_ip_candidates()
    urls = ["http://{}:{}".format(ip, args.port) for ip in ips]
    cfg = {
        "port": args.port, "host": args.host, "pipe": args.pipe,
        "token": args.token, "urls": urls,
    }

    store = StateStore()
    pipe = MpvPipe(args.pipe, store)
    webq = WebmodQueue()

    try:
        httpd = make_server(cfg, store, pipe, webq)
    except OSError as e:
        sys.stderr.write("FATAL bind {}:{} - {}\n".format(args.host, args.port, e))
        return 2

    pipe.start()

    stopping = {"v": False}

    def shutdown(*_):
        if stopping["v"]:
            return
        stopping["v"] = True
        sys.stdout.write("SHUTDOWN\n")
        sys.stdout.flush()
        try:
            pipe.stop()
        except Exception:
            pass
        if args.pidfile:
            try:
                os.remove(args.pidfile)
            except OSError:
                pass
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    atexit.register(shutdown)
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Orphan safety-net: if the Lua supervisor's taskkill ever misses us, exit once
    # the mpv pipe has been unreachable for a long stretch AND no phone is connected.
    def watchdog():
        start = time.time()
        while not stopping["v"]:
            time.sleep(10.0)
            if time.time() - start < 120.0:
                continue
            last = pipe.last_ok()
            pipe_dead = (last == 0.0) or (time.time() - last > 120.0)
            no_clients = httpd.RequestHandlerClass.sse_count[0] == 0
            if pipe_dead and no_clients:
                sys.stderr.write("watchdog: mpv gone + no clients, exiting\n")
                sys.stderr.flush()
                shutdown()
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()

    sys.stdout.write("LISTENING {}:{}\n".format(ips[0], args.port))
    for u in urls:
        sys.stdout.write("URL {}\n".format(u))
    sys.stdout.flush()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
