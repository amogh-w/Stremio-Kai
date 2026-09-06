/**
 * @name Remote - Actuators
 * @description Synthetic keyboard/mouse actuation of the Stremio React UI, adapted
 *              from webmods/Utilities/navigation.js. Every "webmod command" that
 *              the phone can send is executed here.
 * @version 1.0.0
 * @author allecsc / Stremio Kai
 */

(function () {
  "use strict";
  window.KaiRemote = window.KaiRemote || {};
  if (window.KaiRemote.Actuators) return;

  const onPlayer = () => window.location.hash.startsWith("#/player");

  function key(target, k, code, keyCode) {
    (target || document).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k,
        code: code || k,
        keyCode: keyCode || 0,
        which: keyCode || 0,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  // React ignores programmatic Enter on non-form nodes; a physical-style
  // mousedown+mouseup+click is what drives its pointer state (navigation.js).
  function clickReal(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }

  const DPAD = {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
  };
  const DPAD_CODE = { up: 38, down: 40, left: 37, right: 39 };

  const Actuators = {
    nav_dpad(args) {
      const dir = (args && args.dir) || "";
      const k = DPAD[dir];
      if (!k) return { ok: false, error: "bad dir" };
      key(document, k, "Arrow" + dir[0].toUpperCase() + dir.slice(1), DPAD_CODE[dir]);
      return { ok: true };
    },

    nav_ok() {
      // Play/pause when on the player and not focused on a control.
      const a = document.activeElement;
      const isControl =
        a &&
        (a.tagName === "BUTTON" ||
          a.tagName === "A" ||
          parseInt(a.getAttribute("tabindex"), 10) >= 0);
      if (onPlayer() && (!a || a === document.body || !isControl)) {
        key(document, "MediaPlayPause", "MediaPlayPause", 179);
        return { ok: true, did: "playpause" };
      }
      if (a && a !== document.body) {
        const cw = a.closest(window.KaiRemote.SEL.continueWatchingRow);
        if (cw) {
          const icon =
            a.querySelector(window.KaiRemote.SEL.playIconLayer) ||
            a
              .closest(window.KaiRemote.SEL.metaItem)
              ?.querySelector(window.KaiRemote.SEL.playIconLayer);
          if (icon) return { ok: clickReal(icon), did: "resume" };
        }
        return { ok: clickReal(a), did: "click" };
      }
      return { ok: false, error: "nothing focused" };
    },

    nav_back() {
      window.history.back();
      return { ok: true };
    },

    nav_home() {
      window.location.hash = "#/";
      return { ok: true };
    },

    nav_page(args) {
      const pages = window.KaiRemote.PAGES;
      const target = args && args.page;
      if (target && target.startsWith("#/")) {
        window.location.hash = target;
        return { ok: true };
      }
      const cur = window.location.hash;
      let i = pages.findIndex((p) => cur === p || cur.startsWith(p + "/"));
      if (i < 0) i = 0;
      const step = args && args.dir === "prev" ? -1 : 1;
      window.location.hash = pages[(i + step + pages.length) % pages.length];
      return { ok: true };
    },

    nav_hash(args) {
      if (args && typeof args.hash === "string" && args.hash.startsWith("#/")) {
        window.location.hash = args.hash;
        return { ok: true };
      }
      return { ok: false, error: "bad hash" };
    },

    player_next_video() {
      const btn = document.querySelector(window.KaiRemote.SEL.nextVideoButton);
      if (!btn) return { ok: false, error: "no next button" };
      return { ok: clickReal(btn) };
    },

    player_prev_video() {
      // Stremio has no dedicated prev button; step back via seek to 0 then
      // rely on user; expose only if a prev control appears. For now: no-op ack.
      return { ok: false, error: "not supported" };
    },

    toggle_subs_menu() {
      if (!onPlayer()) return { ok: false, error: "not on player" };
      key(document, "s", "KeyS", 83);
      return { ok: true };
    },

    toggle_audio_menu() {
      if (!onPlayer()) return { ok: false, error: "not on player" };
      key(document, "a", "KeyA", 65);
      return { ok: true };
    },

    open_detail(args) {
      const { type, id } = args || {};
      if (!type || !id) return { ok: false, error: "type+id required" };
      window.location.hash = `#/detail/${type}/${encodeURIComponent(id)}/${encodeURIComponent(id)}`;
      return { ok: true };
    },

    open_streams(args) {
      const { type, id, videoId } = args || {};
      if (!type || !id) return { ok: false, error: "type+id required" };
      const vid = videoId || id;
      window.location.hash = `#/detail/${type}/${encodeURIComponent(id)}/${encodeURIComponent(vid)}`;
      return { ok: true };
    },

    async pick_episode(args) {
      const { season, episode } = args || {};
      const rows = window.KaiRemote.Scrapers.episodeRows();
      const match = rows.find(
        (r) => r.season == season && r.episode == episode,
      );
      if (!match || !match.el) return { ok: false, error: "episode not found" };
      match.el.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 120));
      return { ok: clickReal(match.el) };
    },

    launch_stream(args) {
      const idx = (args && args.index) || 0;
      const links = document.querySelectorAll(window.KaiRemote.SEL.streamLink);
      if (!links.length) return { ok: false, error: "no streams" };
      const link = links[Math.min(idx, links.length - 1)];
      return { ok: clickReal(link) };
    },

    instant_resume(args) {
      const metaId = args && args.metaId;
      const rows = document.querySelectorAll(
        window.KaiRemote.SEL.continueWatchingRow + " " + window.KaiRemote.SEL.metaItem,
      );
      for (const item of rows) {
        const href = item.querySelector("a[href]")?.getAttribute("href") || "";
        if (!metaId || href.includes(metaId)) {
          const icon = item.querySelector(window.KaiRemote.SEL.playIconLayer);
          if (icon) return { ok: clickReal(icon) };
          return { ok: clickReal(item) };
        }
      }
      return { ok: false, error: "not in continue watching" };
    },

    async search(args) {
      const q = (args && args.query) || "";
      if (!window.location.hash.startsWith("#/search")) {
        window.location.hash = "#/search";
        await new Promise((r) => setTimeout(r, 400));
      }
      const input = document.querySelector(window.KaiRemote.SEL.searchInput);
      if (!input) return { ok: false, error: "no search input" };
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, q);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    },

    refresh_browse() {
      return { ok: true }; // state POST already carries a fresh scrape
    },
  };

  window.KaiRemote.Actuators = Actuators;
  console.log("[Kai Remote] actuators loaded");
})();
