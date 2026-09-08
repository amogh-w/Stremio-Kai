/**
 * @name Remote - Actuators
 * @description Synthetic keyboard/mouse actuation of the Stremio React UI, adapted
 *              from webmods/Utilities/navigation.js. Every "webmod command" that
 *              the phone can send is executed here.
 * @version 1.2.0
 * @changelog 1.2.0 - removed nav_dpad / nav_ok and the geometric spatial-focus
 *            engine (moveFocus / visibleFocusables / FOCUSABLE). The D-pad drove
 *            Stremio's focus ring, which needs the WebView2 surface focused (the
 *            unsolved "click the window once" bug) and duplicated Browse. `key()`
 *            no longer forces window.isAppFocused (that was only for the D-pad).
 *   1.1.7 - server foregrounds the Stremio window before commands, so nav_dpad
 *           is back to keys (navigation.js) with moveFocus as fallback;
 *           toggle_fullscreen prefers the control-bar button.
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
    // `composed: true` matches navigation.js's own synthetic events.
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

  const Actuators = {
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
  console.log("[Kai Remote] actuators loaded (v1.2.0)");
})();
