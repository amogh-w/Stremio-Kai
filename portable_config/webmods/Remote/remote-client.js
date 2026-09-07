/**
 * @name Remote - Client bridge
 * @description Connects the Stremio web UI to the local Phone Remote server
 *              (portable_config/remote/server.py). Long-polls for queued webmod
 *              commands, actuates them, and POSTs route + scraped state back.
 *              Also pushes the Settings-UI remote config down to
 *              scripts/remote-control/main.lua via the WebView bridge.
 * @version 1.2.0
 * @changelog 1.2.0 - opt-in debug watcher (localStorage kai-remote-debug=true):
 *            logs every pointer/mouse/click event (isTrusted, target, coords),
 *            window focus/blur, and per-command focus/userActivation state to
 *            the Stremio DevTools console - for diagnosing focus/input issues.
 *   1.1.0 - per-scraper error guards in buildState(); errors surface in
 *            browse._scrapeErrors for phone-side diagnosis.
 * @author allecsc / Stremio Kai
 *
 * @requires window.KaiRemote.SEL / .Actuators / .Scrapers  (Remote/*.js)
 * @requires window.RouteDetector                            (Metadata/Utils)
 * @requires window.chrome.webview                           (C++ shell bridge)
 */

(function () {
  "use strict";
  if (window.KaiRemote && window.KaiRemote.initialized) return;
  window.KaiRemote = window.KaiRemote || {};
  window.KaiRemote.initialized = true;

  const LS = {
    enabled: "kai-remote-enabled",
    port: "kai-remote-port",
    host: "kai-remote-host",
    token: "kai-remote-token",
    pipe: "kai-remote-pipe",
  };
  const DEFAULT_PORT = 5000;

  const cfg = () => ({
    enabled: localStorage.getItem(LS.enabled) === "true",
    port: parseInt(localStorage.getItem(LS.port), 10) || DEFAULT_PORT,
    host: localStorage.getItem(LS.host) || "0.0.0.0",
    token: localStorage.getItem(LS.token) || "",
    pipe_name: localStorage.getItem(LS.pipe) || "kai-mpv",
  });

  const base = () => `http://127.0.0.1:${cfg().port}`;

  function authHeaders(extra) {
    const h = Object.assign({ "X-Kai-Remote": "1" }, extra || {});
    const t = cfg().token;
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  // ---- WebView bridge: push remote config to the Lua supervisor ----------
  function sendToMpv(command, args) {
    try {
      window.chrome?.webview?.postMessage(
        JSON.stringify({
          type: 6,
          object: "transport",
          method: "handleInboundJSON",
          args: ["mpv-command", [command, ...args]],
        }),
      );
    } catch (e) {
      console.warn("[Kai Remote] bridge send failed", e);
    }
  }

  function pushConfigToLua() {
    const c = cfg();
    sendToMpv("script-message", [
      "remote-control-config",
      JSON.stringify(c),
    ]);
    console.log("[Kai Remote] pushed config to supervisor", c);
  }

  window.KaiRemote.restartServer = () =>
    sendToMpv("script-message", ["remote-control-restart"]);
  window.KaiRemote.pushConfig = pushConfigToLua;

  // ---- debug: watch synthetic clicks / focus (opt-in) ----------------
  // Enable from the Stremio DevTools console:
  //   localStorage.setItem('kai-remote-debug', 'true'); location.reload();
  // Then press a phone button and watch the console.
  const DEBUG = localStorage.getItem("kai-remote-debug") === "true";
  function dbg() {
    if (DEBUG)
      console.log.apply(
        console,
        ["[Kai Remote DBG]"].concat([].slice.call(arguments)),
      );
  }
  if (DEBUG) {
    const desc = (el) =>
      !el || !el.tagName
        ? String(el)
        : el.tagName.toLowerCase() +
          (el.id ? "#" + el.id : "") +
          (el.className && el.className.baseVal === undefined
            ? "." + String(el.className).trim().replace(/\s+/g, ".")
            : "");
    ["pointerdown", "mousedown", "mouseup", "click", "dblclick"].forEach((t) => {
      window.addEventListener(
        t,
        (e) => {
          dbg(
            t,
            "trusted=" + e.isTrusted,
            "btn=" + e.button,
            "@(" + e.clientX + "," + e.clientY + ")",
            "target=" + desc(e.target),
          );
        },
        true,
      );
    });
    ["focus", "blur"].forEach((t) =>
      window.addEventListener(t, () =>
        dbg("window " + t, "hasFocus=" + document.hasFocus()),
      ),
    );
    document.addEventListener("visibilitychange", () =>
      dbg("visibility=" + document.visibilityState),
    );
    dbg(
      "watcher armed. hasFocus=" + document.hasFocus(),
      "visibility=" + document.visibilityState,
    );
  }

  // ---- command execution ----------------------------------------------
  async function runCommand(item) {
    const fn = window.KaiRemote.Actuators[item.cmd];
    let result;
    if (DEBUG) {
      const ua = navigator.userActivation || {};
      dbg(
        "runCommand",
        item.cmd,
        JSON.stringify(item.args || {}),
        "| hasFocus=" + document.hasFocus(),
        "activeEl=" +
          (document.activeElement &&
            document.activeElement.tagName.toLowerCase()),
        "userAct(active=" + ua.isActive + ",been=" + ua.hasBeenActive + ")",
      );
    }
    if (typeof fn === "function") {
      try {
        result = await fn(item.args || {});
      } catch (e) {
        result = { ok: false, error: String(e && e.message ? e.message : e) };
      }
    } else {
      result = { ok: false, error: "unknown cmd " + item.cmd };
    }
    return { cmd_id: item.cmd_id, ok: !!(result && result.ok), result };
  }

  // ---- state snapshot --------------------------------------------------
  function buildState() {
    const route = window.RouteDetector
      ? window.RouteDetector.getRouteState()
      : { view: "UNKNOWN" };
    // One guard per scraper: a throw in browse() must not silently blank the
    // other two (and vice-versa). Errors surface in `browse._scrapeErrors` so
    // the phone can show them instead of just an empty placeholder.
    const errs = {};
    const safe = (fn, k) => {
      try {
        return fn();
      } catch (e) {
        errs[k] = String((e && e.message) || e);
        return {};
      }
    };
    const browse = safe(() => window.KaiRemote.Scrapers.browse(), "browse");
    const playerUi = safe(() => window.KaiRemote.Scrapers.playerUi(), "playerUi");
    const nowPlaying = safe(
      () => window.KaiRemote.Scrapers.nowPlayingMeta(),
      "nowPlaying",
    );
    if (Object.keys(errs).length) browse._scrapeErrors = errs;
    return { route, browse, player_ui: playerUi, now_playing_meta: nowPlaying };
  }

  async function postState(acks) {
    try {
      await fetch(base() + "/webmod/state", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: buildState(), acks: acks || [] }),
      });
    } catch (e) {
      /* server down - the poll loop backoff handles it */
    }
  }

  // ---- poll loop -----------------------------------------------------
  let backoff = 1000;
  let stopped = false;

  async function pollOnce() {
    if (!cfg().enabled) {
      backoff = 3000;
      return;
    }
    let res;
    try {
      res = await fetch(base() + "/webmod/poll", { headers: authHeaders() });
    } catch (e) {
      backoff = Math.min(backoff * 1.5, 10000);
      return;
    }
    if (!res.ok) {
      backoff = Math.min(backoff * 1.5, 10000);
      return;
    }
    backoff = 300;
    let data;
    try {
      data = await res.json();
    } catch (e) {
      data = { commands: [] };
    }
    const acks = [];
    for (const item of data.commands || []) {
      acks.push(await runCommand(item));
    }
    // Always report fresh state after handling commands (or every poll cycle).
    await postState(acks);
  }

  async function loop() {
    while (!stopped) {
      await pollOnce();
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // Push state immediately on navigation so the phone tracks route changes fast.
  window.addEventListener("hashchange", () => {
    if (cfg().enabled) postState([]);
  });

  // Lightweight heartbeat so the phone sees scrape/route updates without waiting
  // for the 25s long-poll to return. Skipped when the tab is hidden.
  setInterval(() => {
    if (cfg().enabled && document.visibilityState === "visible") postState([]);
  }, 2500);

  // React to Settings changes (mpv-settings.js dispatches this).
  window.addEventListener("kai-settings-changed", () => {
    pushConfigToLua();
  });
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith("kai-remote-")) pushConfigToLua();
  });

  // ---- boot: wait for sibling modules, then start ---------------------
  function ready() {
    return (
      window.KaiRemote.SEL &&
      window.KaiRemote.Actuators &&
      window.KaiRemote.Scrapers &&
      window.RouteDetector
    );
  }

  let tries = 0;
  (function boot() {
    if (!ready()) {
      if (tries++ < 100) return void setTimeout(boot, 100);
      console.warn("[Kai Remote] dependencies missing after 10s, starting anyway");
    }
    console.log("[Kai Remote] initialized");
    pushConfigToLua(); // sync current Settings state to the supervisor on load
    loop();
  })();
})();
