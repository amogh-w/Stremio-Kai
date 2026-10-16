// Kai Remote bridge. Relays mpv state and Stremio now-playing info to the local kai-remote daemon
// (ws://127.0.0.1:5000/bridge) and executes a small whitelist of commands sent back by it.
// Never throws: the webmods loader would re-run a throwing file every 25 ms.
(function () {
  try {
    if (window.top !== window) return;
    if (window.KaiRemote?.initialized) return;
    if (!/^https:\/\/(stremio\.zarg\.me|zaarrg\.github\.io|web\.stremio\.com)$/.test(location.origin)) return;

    const R = (window.KaiRemote = { initialized: true, ws: null, props: {}, now: null, seq: 9000, lastTime: 0, lastTimeVal: -1 });

    // Only these mpv props leave the page. Notably not `path`, which holds the stream URL (debrid tokens).
    const FORWARD = new Set(["time-pos", "duration", "pause", "volume", "mute", "speed", "track-list", "aid", "sid", "sub-delay", "paused-for-cache", "glsl-shaders", "vf", "deband", "deinterlace", "panscan", "icc-profile-auto"]);
    const EXTRA_OBSERVE = ["mute", "glsl-shaders", "vf", "deband", "deinterlace", "panscan", "icc-profile-auto"];

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
      // Enhancement state for the Enhance tab: shader names only (no paths), filter label + graph only.
      if (name === "glsl-shaders") data = (Array.isArray(data) ? data : []).map((p) => String(p).replace(/^.*[\\/]/, "").replace(/\.glsl$/i, ""));
      if (name === "vf") data = (Array.isArray(data) ? data : []).map((f) => ({
        label: (f && f.label) || "", name: (f && f.name) || "", enabled: !(f && f.enabled === false),
        graph: f && f.params && typeof f.params.graph === "string" ? f.params.graph.slice(0, 120) : "",
      }));
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
    // ---- home (continue watching, catalog rows, hero) ------------------------------------------
    // Items carry only ids. Routes, and above all stream deep links (which embed debrid tokens),
    // are resolved here at command time and never leave the PC.
    const cap = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
    const enc = encodeURIComponent;
    const epLabel = (it) => {
      const p = String((it.state && it.state.videoId) || "").split(":");
      return p.length >= 3 && it.type === "series" ? "S" + p[p.length - 2] + " E" + p[p.length - 1] : null;
    };
    const buildHome = async () => {
      const t = window.services.core.transport;
      const [cw, board] = await Promise.all([t.getState("continue_watching_preview"), t.getState("board")]);
      const home = { hero: [], cw: [], rows: [] };
      for (const it of ((cw && cw.items) || []).slice(0, 20)) {
        home.cw.push({
          ref: "resume:" + enc(it._id), more: "streams:" + enc(it._id), id: it._id, type: it.type, name: cap(it.name, 120),
          poster: it.poster || null, label: epLabel(it), progress: Math.max(0, Math.min(100, Number(it.progress) || 0)),
        });
      }
      for (const cat of ((board && board.catalogs) || []).slice(0, 12)) {
        const c = cat.content;
        if (!c || c.type !== "Ready" || !Array.isArray(c.content)) continue;
        home.rows.push({
          name: cap(cat.name, 60) + " - " + cap(cat.type, 20), type: cat.type,
          items: c.content.slice(0, 30).map((m) => ({
            ref: "detail:" + enc(m.type) + "/" + enc(m.id), name: cap(m.name, 120), poster: m.poster || null,
            shape: m.posterShape || "poster", year: cap(m.releaseInfo, 12),
          })),
        });
      }
      const H = window.HeroPlugin && window.HeroPlugin.State;
      for (const h of ((H && H.heroTitles) || []).slice(0, 12)) {
        if (!h || !h.imdb || !h.background) continue;
        home.hero.push({
          ref: "detail:" + enc(h.type || "movie") + "/" + enc(h.imdb), title: cap(h.title, 120), tagline: cap(h.tagline, 160),
          year: cap(h.year, 8), runtime: cap(h.runtime, 20), genres: (h.genres || []).slice(0, 3),
          rating: h.ratings && h.ratings.imdb ? h.ratings.imdb.score : null, plot: cap(h.plot, 320),
          background: h.background, logo: h.logo || null,
        });
      }
      return home;
    };
    let homeSig = "";
    const refreshHome = async (force) => {
      try {
        const home = await buildHome();
        const sig = JSON.stringify(home);
        if (sig === homeSig && !force) return;
        homeSig = sig;
        up({ k: "home", home });
      } catch (e) {}
    };
    // Resolve a phone ref to a route using fresh core state.
    const openRef = async (ref) => {
      try {
        const [kind, rest] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
        if (kind === "detail") {
          const [type, id] = rest.split("/");
          if (type && id) location.hash = "#/detail/" + type + "/" + id;
          return;
        }
        const cw = await window.services.core.transport.getState("continue_watching_preview");
        const it = ((cw && cw.items) || []).find((x) => x._id === decodeURIComponent(rest));
        if (!it || !it.deepLinks) return;
        const link = kind === "resume" ? it.deepLinks.player || it.deepLinks.metaDetailsStreams : it.deepLinks.metaDetailsStreams || it.deepLinks.metaDetailsVideos;
        if (typeof link === "string" && link.startsWith("#/")) location.hash = link;
      } catch (e) {}
    };

    // ---- detail page (mirror of meta_details) --------------------------------------------------
    // Streams are listed by index only. Their deep links embed stream URLs and debrid tokens, so they
    // are resolved here from fresh state when the phone says "play idx at revision rev".
    const flattenStreams = (st) => {
      const groups = [];
      let loading = false;
      for (const g of (st && st.streams) || []) {
        const c = g && g.content;
        if (!c) continue;
        if (c.type === "Loading") loading = true;
        if (c.type !== "Ready" || !Array.isArray(c.content)) continue;
        const items = c.content.filter((s) => s && s.deepLinks && typeof s.deepLinks.player === "string");
        if (!items.length) continue;
        const man = (g.addon && g.addon.manifest) || {};
        groups.push({ addon: { name: cap(man.name, 60), logo: man.logo || null }, items });
      }
      return { groups, loading };
    };
    const detailMatchesRoute = (m) => {
      const mm = /^#\/detail\/[^/]+\/([^/?]+)/.exec(location.hash);
      return !!mm && decodeURIComponent(mm[1]) === m.id;
    };
    const buildDetail = (st) => {
      const mi = st && st.metaItem && st.metaItem.content;
      if (!mi || mi.type !== "Ready" || !mi.content || !detailMatchesRoute(mi.content)) return null;
      const m = mi.content;
      const { groups, loading } = flattenStreams(st);
      let idx = 0;
      return {
        id: m.id, type: m.type, name: cap(m.name, 160), description: cap(m.description, 700),
        background: m.background || null, logo: m.logo || null, poster: m.poster || null,
        releaseInfo: cap(m.releaseInfo, 20), runtime: cap(m.runtime, 20), rating: m.imdbRating || null,
        videos: (m.videos || []).slice(0, 500).map((v) => ({
          id: v.id, season: v.season, episode: v.episode, title: cap(v.title || v.name, 140),
          thumbnail: v.thumbnail || null, watched: !!v.watched, released: cap(v.released, 10),
        })),
        selected: st.selected && st.selected.streamPath ? st.selected.streamPath.id : null,
        loading,
        groups: groups.map((g) => ({
          addon: g.addon,
          items: g.items.map((s) => ({ idx: idx++, name: cap(s.name, 160), description: cap(s.description, 320) })),
        })),
      };
    };
    let detailSig = "null";
    let detailRev = 0;
    const refreshDetail = async (force) => {
      try {
        let d = null;
        if (/^#\/detail\//.test(location.hash)) d = buildDetail(await window.services.core.transport.getState("meta_details"));
        const sig = JSON.stringify(d);
        if (sig !== detailSig) { detailSig = sig; detailRev++; } else if (!force) return;
        up({ k: "detail", detail: d, rev: detailRev });
      } catch (e) {}
    };
    const openVideo = async (id) => {
      try {
        const st = await window.services.core.transport.getState("meta_details");
        const v = (st.metaItem.content.content.videos || []).find((x) => x.id === id);
        const link = v && v.deepLinks && v.deepLinks.metaDetailsStreams;
        if (typeof link === "string" && link.startsWith("#/")) location.hash = link;
      } catch (e) {}
    };
    const playStream = async (idx, rev) => {
      try {
        if (rev !== detailRev) return refreshDetail(true); // phone saw an older list: resync instead of guessing
        const st = await window.services.core.transport.getState("meta_details");
        const s = flattenStreams(st).groups.flatMap((g) => g.items)[idx];
        if (s) location.hash = s.deepLinks.player;
      } catch (e) {}
    };

    const attachCore = () => {
      try {
        const core = window.services && window.services.core;
        if (!core) return setTimeout(attachCore, 1000);
        core.transport.on("NewState", (models) => {
          if (!Array.isArray(models)) return;
          if (models.includes("player")) refreshNow();
          if (models.includes("continue_watching_preview") || models.includes("board")) refreshHome();
          if (models.includes("meta_details")) refreshDetail();
        });
        refreshNow();
        refreshHome();
        setInterval(() => refreshHome(), 20000); // hero list is filled asynchronously by Kai
      } catch (e) { setTimeout(attachCore, 2000); }
    };
    setTimeout(attachCore, 1500);

    // ---- route ---------------------------------------------------------------------------------
    const sendRoute = () => up({ k: "route", hash: /^#\/player/.test(location.hash) ? "#/player" : location.hash || "#/" });
    window.addEventListener("hashchange", () => { sendRoute(); setTimeout(() => refreshDetail(), 150); });

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
        case "hotkey": // same key mpv would get from the keyboard, so input.conf stays the single source of truth
          if (typeof m.key === "string" && /^(?:(?:Ctrl|Shift)\+)?(?:F(?:[1-9]|1[0-2])|[1-4])$|^[qtTu`]$/.test(m.key)) send("mpv-command", ["keypress", m.key]);
          return;
        case "back": return history.back();
        case "key": return pressKey(m.key);
        case "open": return openRef(String(m.ref));
        case "video": return openVideo(String(m.id));
        case "play": return playStream(Number(m.idx), Number(m.rev));
        case "hash": if (typeof m.h === "string" && /^#\/[\w#/?=&:%.~-]*$/.test(m.h)) location.hash = m.h; return;
      }
    };

    // ---- socket --------------------------------------------------------------------------------
    const connect = () => {
      try {
        const ws = new WebSocket("ws://127.0.0.1:5000/bridge");
        R.ws = ws;
        ws.onopen = () => {
          observeExtra();
          for (const [name, data] of Object.entries(R.props)) up({ k: "prop", name, data });
          up({ k: "now", now: R.now });
          sendRoute();
          refreshNow();
          refreshHome(true);
          refreshDetail(true);
        };
        ws.onmessage = (ev) => { try { run(JSON.parse(ev.data)); } catch (e) {} };
        ws.onclose = () => setTimeout(connect, 2000);
        ws.onerror = () => { try { ws.close(); } catch (e) {} };
      } catch (e) { setTimeout(connect, 2000); }
    };
    connect();
  } catch (e) { /* swallow */ }
})();
