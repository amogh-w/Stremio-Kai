/**
 * @name Remote - Actuators
 * @description Synthetic keyboard/mouse actuation of the Stremio React UI, adapted
 *              from webmods/Utilities/navigation.js. Every "webmod command" that
 *              the phone can send is executed here.
 * @version 1.1.7
 * @changelog 1.1.7 - server foregrounds the Stremio window before commands, so
 *            nav_dpad is back to keys (navigation.js) with moveFocus as fallback;
 *            toggle_fullscreen prefers the control-bar button.
 *   1.1.6 - toggle_fullscreen: send the player's `f` key (the shell, not mpv,
 *           owns the window).
 *   1.1.5 - nav_dpad does its own geometric spatial focus off the player
 *           (Stremio has no native arrow nav, navigation.js gates on window
 *           focus); arrows still passed through on the player.
 *   1.1.4 - synthetic keys force window.isAppFocused=true first, so
 *           navigation.js's focus-gated D-pad handler runs for phone input.
 *   1.1.3 - season_step: page the seasons bar for the Browse episode list.
 *   1.1.2 - open_details: "tap the title" action that always opens the details
 *           page (never resumes), mirroring Stremio's own card.
 *   1.1.1 - nav_ok: use a literal play-icon selector (selectors.js no longer
 *           defines playIconLayer; the undefined key threw SyntaxError).
 *   1.1.0 - play/pause routed through the web player (space) instead of the mpv
 *           pipe, which only paused reliably (web UI owns the state).
 * @author allecsc / Stremio Kai
 */

(function () {
  "use strict";
  window.KaiRemote = window.KaiRemote || {};
  if (window.KaiRemote.Actuators) return;

  const onPlayer = () => window.location.hash.startsWith("#/player");

  function key(target, k, code, keyCode) {
    // navigation.js owns arrow-key spatial nav and gates its keydown handler on
    // `window.isAppFocused` / document.hasFocus(). A phone-driven event usually
    // arrives while the PC window is unfocused, so force the flag true first
    // (its own focus/blur listeners correct it again). `composed: true` matches
    // navigation.js's own synthetic events.
    try { window.isAppFocused = true; } catch (e) {}
    (target || document).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k,
        code: code || k,
        keyCode: keyCode || 0,
        which: keyCode || 0,
        bubbles: true,
        cancelable: true,
        composed: true,
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

  // Re-find the exact catalog card the scraper reported, using the `ref` it
  // carried (dom id > title > ordinal). More reliable than rebuilding a URL,
  // which needs a content type the DOM often doesn't expose.
  function findCard(ref) {
    if (!ref) return null;
    const SEL = window.KaiRemote.SEL;
    if (ref.domId) {
      const byId =
        document.getElementById(ref.domId) ||
        document.querySelector('[id="' + CSS.escape(ref.domId) + '"]');
      if (byId) return byId.closest(SEL.metaItem) || byId;
    }
    const cards = Array.from(document.querySelectorAll(SEL.metaItem));
    if (ref.title) {
      const hit = cards.find(function (c) {
        return (
          (c.getAttribute("title") || "").trim() === ref.title ||
          c.textContent.trim().replace(/\s+/g, " ").indexOf(ref.title) === 0
        );
      });
      if (hit) return hit;
    }
    if (ref.ordinal != null && cards[ref.ordinal]) return cards[ref.ordinal];
    return null;
  }

  async function clickInView(el) {
    if (!el) return { ok: false, error: "element not found" };
    el.scrollIntoView({ block: "center", inline: "center" });
    await new Promise(function (r) { setTimeout(r, 140); });
    return { ok: clickReal(el) };
  }

  const DPAD = {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
  };
  const DPAD_CODE = { up: 38, down: 40, left: 37, right: 39 };

  // --- geometric spatial focus navigation ---------------------------------
  // Stremio Web has no native arrow-key grid navigation (navigation.js adds it,
  // but gates on window focus so phone input is ignored). So off the player we
  // move DOM focus ourselves: from the focused element, pick the nearest
  // focusable in the requested direction.
  const FOCUSABLE =
    'a[href], button, [role="button"], [tabindex="0"], input, select, ' +
    ".meta-item-container-Tj0Ib, [class*='meta-item-container-'], " +
    ".video-container-ezBpK, [class*='video-container-'], " +
    "[class*='stream-container-'], [class*='action-button-']";

  function visibleFocusables() {
    const vw = window.innerWidth, vh = window.innerHeight;
    return Array.prototype.filter.call(
      document.querySelectorAll(FOCUSABLE),
      function (el) {
        if (el.disabled || el.closest("[aria-hidden='true']")) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        // on-screen or just past an edge
        if (r.bottom < -40 || r.top > vh + 40 || r.right < -40 || r.left > vw + 40) return false;
        const cs = window.getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none" && cs.pointerEvents !== "none";
      },
    );
  }

  function moveFocus(dir) {
    const items = visibleFocusables();
    if (!items.length) return false;
    const cur = document.activeElement;
    const curItem = cur && items.indexOf(cur) !== -1 ? cur : null;

    if (!curItem) {
      // nothing focused yet — grab the item nearest the top-centre of the view
      const cx = window.innerWidth / 2;
      let best = items[0], bestD = Infinity;
      items.forEach(function (el) {
        const r = el.getBoundingClientRect();
        const d = Math.max(0, r.top) + Math.abs((r.left + r.right) / 2 - cx) * 0.5;
        if (d < bestD) { bestD = d; best = el; }
      });
      best.focus({ preventScroll: false });
      best.scrollIntoView({ block: "nearest", inline: "nearest" });
      return true;
    }

    const cr = curItem.getBoundingClientRect();
    const ccx = (cr.left + cr.right) / 2, ccy = (cr.top + cr.bottom) / 2;
    let best = null, bestScore = Infinity;
    items.forEach(function (el) {
      if (el === curItem) return;
      const r = el.getBoundingClientRect();
      const ex = (r.left + r.right) / 2, ey = (r.top + r.bottom) / 2;
      const dx = ex - ccx, dy = ey - ccy;
      let along, across;
      if (dir === "left") { if (dx > -6) return; along = -dx; across = Math.abs(dy); }
      else if (dir === "right") { if (dx < 6) return; along = dx; across = Math.abs(dy); }
      else if (dir === "up") { if (dy > -6) return; along = -dy; across = Math.abs(dx); }
      else { if (dy < 6) return; along = dy; across = Math.abs(dx); } // down
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (!best) return false;
    best.focus({ preventScroll: false });
    best.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }

  const Actuators = {
    // The server foregrounds the Stremio window before this runs, so
    // navigation.js's focus-gated spatial nav works again - dispatch the arrow
    // key and let it drive. Off the player, if navigation.js didn't move focus
    // (older build / edge page), fall back to our own geometric move.
    async nav_dpad(args) {
      const dir = (args && args.dir) || "";
      const k = DPAD[dir];
      if (!k) return { ok: false, error: "bad dir" };
      const code = "Arrow" + dir[0].toUpperCase() + dir.slice(1);
      if (onPlayer()) {
        key(document, k, code, DPAD_CODE[dir]);  // seek / volume / popup nav
        return { ok: true, via: "key" };
      }
      const before = document.activeElement;
      key(document, k, code, DPAD_CODE[dir]);
      await new Promise(function (r) { setTimeout(r, 40); });
      if (document.activeElement === before || document.activeElement === document.body) {
        return { ok: moveFocus(dir), via: "focus" };
      }
      return { ok: true, via: "key" };
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
          // literal selector - selectors.js no longer carries a playIconLayer key
          const PLAY_ICON = "[class*='play-icon'], [class*='play-button']";
          const icon =
            a.querySelector(PLAY_ICON) ||
            (a.closest(window.KaiRemote.SEL.metaItem) || document.body).querySelector(
              PLAY_ICON,
            );
          if (icon) return { ok: clickReal(icon), did: "resume" };
        }
        return { ok: clickReal(a), did: "click" };
      }
      return { ok: false, error: "nothing focused" };
    },

    // Play/pause. Sent to the Stremio web player (space), not the mpv pipe:
    // the web UI owns play/pause state and reverts an out-of-band unpause.
    toggle_pause() {
      if (!onPlayer()) return { ok: false, error: "not on player" };
      key(document, " ", "Space", 32);
      return { ok: true };
    },

    // Fullscreen: the C++ shell (not mpv) owns the window. Prefer clicking the
    // control-bar fullscreen button (its onClick messages the shell - no user
    // gesture needed); fall back to the `f` shortcut.
    toggle_fullscreen() {
      if (!onPlayer()) return { ok: false, error: "not on player" };
      const bar = document.querySelector(window.KaiRemote.SEL.controlBar) || document;
      const btn = bar.querySelector(window.KaiRemote.SEL.fullscreenButton);
      if (btn) { clickReal(btn); return { ok: true, via: "button" }; }
      key(document, "f", "KeyF", 70);
      return { ok: true, via: "key" };
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

    // Primary path from the Browse tab: open a catalog item by clicking its
    // real card. `ref` comes straight from the scraper.
    async open_item(args) {
      const a = args || {};
      let el = findCard(a.ref);
      if (!el && a.type && a.metaId) {
        window.location.hash =
          "#/detail/" + a.type + "/" + encodeURIComponent(a.metaId) +
          "/" + encodeURIComponent(a.metaId);
        return { ok: true, via: "hash" };
      }
      if (!el) return { ok: false, error: "card not found" };
      return clickInView(el);
    },

    // "Tap the title" from Browse: always open the details page, never resume.
    // Prefer a direct hash nav; for cards with no known type (e.g. Continue
    // Watching) fall back to clicking the card's title element, which is what
    // Stremio itself routes to the details page.
    async open_details(args) {
      const a = args || {};
      if (a.type && a.metaId) {
        window.location.hash =
          "#/detail/" + a.type + "/" + encodeURIComponent(a.metaId) +
          "/" + encodeURIComponent(a.metaId);
        return { ok: true, via: "hash" };
      }
      const card = findCard(a.ref);
      if (!card) return { ok: false, error: "card not found" };
      const titleEl = card.querySelector(window.KaiRemote.SEL.metaItemTitle);
      return clickInView(titleEl || card);
    },

    // Step the Stremio seasons bar one season left/right. Stremio renders only
    // the active season's episodes, so the phone list refreshes on next scrape.
    season_step(args) {
      const dir = args && args.dir === "prev" ? "prev" : "next";
      const bar = document.querySelector(window.KaiRemote.SEL.seasonsBar);
      const btn =
        bar &&
        bar.querySelector(
          dir === "prev"
            ? window.KaiRemote.SEL.seasonPrev
            : window.KaiRemote.SEL.seasonNext,
        );
      if (!btn) return { ok: false, error: "no season bar" };
      return { ok: clickReal(btn) };
    },

    async pick_episode(args) {
      const a = args || {};
      const rows = window.KaiRemote.Scrapers.episodeRows();
      let match = null;
      if (a.season != null && a.episode != null) {
        match = rows.find((r) => r.season == a.season && r.episode == a.episode);
      }
      if (!match && a.ordinal != null) match = rows[a.ordinal];
      if (!match || !match.el) return { ok: false, error: "episode not found" };
      return clickInView(match.el);
    },

    launch_stream(args) {
      const idx = (args && args.index) || 0;
      const links = document.querySelectorAll(window.KaiRemote.SEL.streamLink);
      if (!links.length) return { ok: false, error: "no streams" };
      return { ok: clickReal(links[Math.min(idx, links.length - 1)]) };
    },

    async instant_resume(args) {
      const ref = args && args.ref;
      const cwRow = document.querySelector(window.KaiRemote.SEL.continueWatchingRow);
      let card = null;
      if (cwRow && ref) {
        card = findCard(ref);
        if (card && !cwRow.contains(card)) card = null;
      }
      if (!card && cwRow) card = cwRow.querySelector(window.KaiRemote.SEL.metaItem);
      if (!card) return { ok: false, error: "not in continue watching" };
      const play =
        card.querySelector("[class*='play-icon'], [class*='play-button']") || card;
      return clickInView(play);
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
  console.log("[Kai Remote] actuators loaded (v1.1.7)");
})();
