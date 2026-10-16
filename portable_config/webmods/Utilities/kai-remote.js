// Kai Remote bridge. Relays mpv state and Stremio now-playing info to the local kai-remote daemon
// (ws://127.0.0.1:8765/bridge) and executes a small whitelist of commands sent back by it.
// Never throws: the webmods loader would re-run a throwing file every 25 ms.
(function () {
  try {
    if (window.top !== window) return;
    if (window.KaiRemote?.initialized) return;
    if (!/^https:\/\/(stremio\.zarg\.me|zaarrg\.github\.io|web\.stremio\.com)$/.test(location.origin)) return;

    const R = (window.KaiRemote = { initialized: true, ws: null, props: {}, now: null, seq: 9000, lastTime: 0, lastTimeVal: -1 });

    // Only these mpv props leave the page. Notably not `path`, which holds the stream URL (debrid tokens).
    const FORWARD = new Set(["time-pos", "duration", "pause", "volume", "mute", "speed", "track-list", "aid", "sid", "sub-delay", "paused-for-cache"]);
    const EXTRA_OBSERVE = ["mute"];

    const up = (o) => {
      try { if (R.ws && R.ws.readyState === 1) R.ws.send(JSON.stringify(o)); } catch (e) {}
    };

    // ---- page -> shell -------------------------------------------------------------------------
    const send = (event, args) => {
      try {
        window.chrome.webview.postMessage(JSON.stringify({ type: 6, object: "transport", method: "handleInboundJSON", id: ++R.seq, args: [event, args] }));
      } catch (e) {}
    };
    const setProp = (name, value) => send("mpv-set-prop", [name, value]);
    const observeExtra = () => EXTRA_OBSERVE.forEach((p) => send("mpv-observe-prop", [p]));

    // ---- synthetic input (recipes from the reference, section 6) -------------------------------
    const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Tab: 9, Enter: 13 };
    const pressKey = (key) => {
      const keyCode = KEYS[key];
      if (!keyCode) return;
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }));
    };
    const clickEl = (el) => {
      if (!el) return;
      try { el.focus && el.focus(); } catch (e) {}
      for (const t of ["mousedown", "mouseup"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      el.click();
    };

    // ---- shell -> page: mpv state --------------------------------------------------------------
    const cleanTracks = (list) =>
      Array.isArray(list)
        ? list.filter((t) => t && (t.type === "audio" || t.type === "sub")).map((t) => ({
            id: t.id, type: t.type, lang: t.lang || null, title: t.title || null,
            codec: t.codec || null, selected: !!t.selected, forced: !!t.forced, default: !!t.default,
          }))
        : [];

    const onProp = (name, data) => {
      if (name === "path") { observeExtra(); return; }
      if (!FORWARD.has(name)) return;
      if (name === "track-list") data = cleanTracks(data);
      R.props[name] = data;
      if (name === "time-pos") {
        // 20+ updates/s from mpv: pass one per second, plus any jump (seek).
        const t = Date.now();
        const jump = typeof data === "number" && Math.abs(data - R.lastTimeVal) > 2.5;
        if (t - R.lastTime < 1000 && !jump) return;
        R.lastTime = t;
        R.lastTimeVal = typeof data === "number" ? data : -1;
      }
      up({ k: "prop", name, data });
      if (name === "pause" && "time-pos" in R.props) up({ k: "prop", name: "time-pos", data: R.props["time-pos"] });
    };

    try {
      window.chrome.webview.addEventListener("message", (ev) => {
        try {
          const d = JSON.parse(ev.data);
          const a = d && d.args;
          if (!a) return;
          if (a[0] === "mpv-prop-change" && a[1]) onProp(a[1].name, a[1].data);
          else if (a[0] === "MpvCommandBlocked" || a[0] === "MpvSetPropBlocked") up({ k: "blocked", what: a[0], info: a[1] || null });
        } catch (e) {}
      });
    } catch (e) {}

    // ---- now playing (sanitized: no stream URLs, no profile) -----------------------------------
    const buildNow = (st) => {
      if (!st || !st.selected) return null;
      const meta = st.metaItem && st.metaItem.content;
      const nv = st.nextVideo;
      return {
        title: st.title || (meta && meta.name) || null,
        name: (meta && meta.name) || null,
        type: (meta && meta.type) || null,
        id: (meta && meta.id) || null,
        poster: (meta && meta.poster) || null,
        background: (meta && meta.background) || null,
        logo: (meta && meta.logo) || null,
        season: st.seriesInfo ? st.seriesInfo.season : null,
        episode: st.seriesInfo ? st.seriesInfo.episode : null,
        next: nv ? { title: nv.title || null, season: nv.season, episode: nv.episode, thumbnail: nv.thumbnail || null } : null,
      };
    };
    const refreshNow = async () => {
      try {
        const st = await window.services.core.transport.getState("player");
        R.now = buildNow(st);
        up({ k: "now", now: R.now });
      } catch (e) {}
    };
    const attachCore = () => {
      try {
        const core = window.services && window.services.core;
        if (!core) return setTimeout(attachCore, 1000);
        core.transport.on("NewState", (models) => { if (Array.isArray(models) && models.includes("player")) refreshNow(); });
        refreshNow();
      } catch (e) { setTimeout(attachCore, 2000); }
    };
    setTimeout(attachCore, 1500);

    // ---- route ---------------------------------------------------------------------------------
    const sendRoute = () => up({ k: "route", hash: location.hash || "#/" });
    window.addEventListener("hashchange", sendRoute);

    // ---- daemon -> page: commands --------------------------------------------------------------
    const run = (m) => {
      switch (m.cmd) {
        case "pause": return setProp("pause", !!m.v);
        case "seek": return setProp("time-pos", Number(m.s));
        case "volume": setProp("mute", "no"); return setProp("volume", Number(m.v));
        case "mute": return setProp("mute", m.v ? "yes" : "no");
        case "speed": return setProp("speed", Number(m.v));
        case "aid": return setProp("aid", String(m.id));
        case "sid": return setProp("sid", String(m.id));
        case "subdelay": return setProp("sub-delay", Number(m.s));
        case "skip": return send("mpv-command", ["script-message-to", "notify_skip", "perform-skip"]);
        case "next": return clickEl(document.querySelector('div[title="Next Video"]'));
        case "ok": {
          const el = document.activeElement;
          if (el && el !== document.body) return clickEl(el);
          return pressKey("Enter");
        }
        case "back": return history.back();
        case "key": return pressKey(m.key);
        case "hash": if (typeof m.h === "string" && /^#\/[\w#/?=&:%.~-]*$/.test(m.h)) location.hash = m.h; return;
      }
    };

    // ---- socket --------------------------------------------------------------------------------
    const connect = () => {
      try {
        const ws = new WebSocket("ws://127.0.0.1:8765/bridge");
        R.ws = ws;
        ws.onopen = () => {
          observeExtra();
          for (const [name, data] of Object.entries(R.props)) up({ k: "prop", name, data });
          up({ k: "now", now: R.now });
          sendRoute();
          refreshNow();
        };
        ws.onmessage = (ev) => { try { run(JSON.parse(ev.data)); } catch (e) {} };
        ws.onclose = () => setTimeout(connect, 2000);
        ws.onerror = () => { try { ws.close(); } catch (e) {} };
      } catch (e) { setTimeout(connect, 2000); }
    };
    connect();
  } catch (e) { /* swallow */ }
})();
