/**
 * @name Remote - Scrapers
 * @description Enumerate whatever page is currently open (board rows / library /
 *              search results / episode list / stream list) into plain objects the
 *              phone can render. Never navigates on its own.
 * @version 1.1.5
 * @author allecsc / Stremio Kai
 *
 * @changelog
 *   1.1.5 - episodeRows() carries a landscape `thumb` (first <img> src, else a
 *           background-image URL from SEL.videoThumb) so the phone episode list
 *           shows Stremio's episode stills. Re-verify SEL.videoThumb on rebase.
 *   1.1.4 - Browse season stepper: seasonInfo() returns the "Season N" label
 *           (never the prev/next button text) + prev/next availability; episode
 *           number also parsed from the title. Other seasons sit behind a closed
 *           popup, so there is no list to enumerate.
 *   1.1.3 - cap streamList (80) + episodeRows (400): debrid addons list 100s of
 *           results and the whole list rode in every SSE frame (~640 KB seen).
 *   1.1.2 - `_debug` emitted only when the route's expected list came back empty.
 *   1.1.1 - `_debug` always emitted (route + selector-match flags + counts).
 *   1.1.0 - Robust id/poster extraction (href OR <a id> OR poster URL); carry a
 *           DOM-findable `ref` so the phone opens items by clicking the real card
 *           instead of guessing a URL. Self-diagnosing `_debug` sample.
 *   1.0.0 - Initial.
 */

(function () {
  "use strict";
  window.KaiRemote = window.KaiRemote || {};
  if (window.KaiRemote.Scrapers) return;

  const SEL = () => window.KaiRemote.SEL;
  const ID_RE = /(tt\d{6,}|(?:tmdb|tvdb|mal|anilist|kitsu|anidb):[A-Za-z0-9]+)/i;

  function text(el, sel) {
    const n = el && el.querySelector(sel);
    return n ? n.textContent.trim().replace(/\s+/g, " ") : "";
  }

  function posterFrom(el) {
    // 1. <img> (may be lazy: data-src / not-yet-loaded)
    const img = el.querySelector(SEL().posterImg);
    if (img) {
      const src = img.currentSrc || img.getAttribute("src") || img.dataset.src || "";
      if (src && !src.startsWith("data:")) return src;
    }
    // 2. CSS background-image on the poster container / any descendant
    const bgEl =
      el.querySelector(SEL().posterContainer) ||
      el.querySelector("[style*='background-image']");
    if (bgEl) {
      let bg = bgEl.getAttribute("style") || "";
      if (!/url\(/.test(bg)) {
        try { bg = getComputedStyle(bgEl).backgroundImage || ""; } catch (e) {}
      }
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !m[1].startsWith("data:")) return m[1];
    }
    return "";
  }

  const _urlOk = (s) => s && !s.startsWith("data:") && s !== "none";

  // Landscape thumbnail for an episode row (Stremio pulls these from
  // Cinemeta/TMDB; rows without one just fall back to the number badge).
  // Prefer the thumbnail-classed element (its bg-image or a nested <img>),
  // then fall back to any bg-image / <img> in the row.
  function thumbFrom(row) {
    const cands = [];
    const box = row.querySelector(SEL().videoThumb);
    if (box) cands.push(box);
    cands.push(row.querySelector("[style*='background-image']"));
    for (const el of cands) {
      if (!el) continue;
      const inner = el.tagName === "IMG" ? el : el.querySelector("img");
      if (inner) {
        const src = inner.currentSrc || inner.getAttribute("src") || inner.dataset.src || "";
        if (_urlOk(src)) return src;
      }
      let bg = el.getAttribute("style") || "";
      if (!/url\(/.test(bg)) {
        try { bg = getComputedStyle(el).backgroundImage || ""; } catch (e) {}
      }
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && _urlOk(m[1])) return m[1];
    }
    const img = row.querySelector("img");
    const s = img && (img.currentSrc || img.getAttribute("src") || img.dataset.src || "");
    return _urlOk(s) ? s : "";
  }

  // Pull {type,id} from a Stremio detail/player href.
  function fromHref(href) {
    const m = (href || "").match(/#\/(?:detail|player)\/(movie|series|other|channel|tv)\/([^/?]+)/);
    if (!m) return null;
    return { type: m[1], id: decodeURIComponent(m[2]).split("/")[0] };
  }

  // el is a .meta-item-container (itself an <a>, or wrapping/inside one).
  function scrapeGridItem(el, ordinal) {
    const anchor =
      (el.matches && el.matches("a") && el) ||
      el.querySelector("a[href], a[id]") ||
      el.closest("a[href], a[id]") ||
      el;

    const href = anchor.getAttribute ? anchor.getAttribute("href") || "" : "";
    const domId = (anchor.id || el.id || "").trim();
    const title =
      el.getAttribute("title") ||
      (anchor.getAttribute && anchor.getAttribute("title")) ||
      text(el, SEL().metaItemTitle);
    const poster = posterFrom(el);

    let type = null,
      metaId = null;
    const dl = fromHref(href);
    if (dl) { type = dl.type; metaId = dl.id; }
    if (!metaId && domId) {
      const im = domId.match(ID_RE);
      metaId = im ? im[1] : domId;
    }
    if (!metaId && poster) {
      const pm = poster.match(/(tt\d{6,})/);
      if (pm) metaId = pm[1];
    }

    return {
      name: (title || "").trim(),
      poster: poster,
      type: type,
      metaId: metaId,
      deepLink: href,
      // How the webmod re-finds this exact card to click it:
      ref: { domId: domId || null, title: (title || "").trim() || null, ordinal: ordinal },
    };
  }

  function scrapeContainer(root) {
    const seen = new Set();
    const out = [];
    root.querySelectorAll(SEL().metaItem).forEach((it, i) => {
      if (it.closest(SEL().seeAll)) return;
      const parsed = scrapeGridItem(it, i);
      const k = parsed.metaId || parsed.name;
      if (!k || seen.has(k)) return;
      seen.add(k);
      if (parsed.name || parsed.metaId) out.push(parsed);
    });
    return out;
  }

  const Scrapers = {
    boardRows() {
      const rows = [];
      document.querySelectorAll(SEL().boardRow).forEach((row) => {
        const items = scrapeContainer(row).slice(0, 25);
        if (!items.length) return;
        rows.push({
          rowTitle:
            text(row, SEL().boardRowLabel) ||
            (row.getAttribute("aria-label") || "").trim() ||
            "",
          continueWatching: !!row.closest(SEL().continueWatchingRow) ||
            /continue/i.test(text(row, SEL().boardRowLabel)),
          items: items,
        });
      });
      return rows;
    },

    grid() {
      const container =
        document.querySelector(SEL().metaItemsContainer) ||
        document.querySelector(SEL().boardContent) ||
        document.body;
      return scrapeContainer(container).slice(0, 120);
    },

    // { label: "Season 29", active: 29|null, hasPrev, hasNext }
    // Stremio shows one season at a time; other seasons are behind a closed popup.
    seasonInfo(routeSeason) {
      const bar = document.querySelector(SEL().seasonsBar);
      if (!bar) return null;
      const dis = (el) => !el || el.disabled || /disabled/i.test(el.className) || el.getAttribute("aria-disabled") === "true";
      const prev = bar.querySelector(SEL().seasonPrev);
      const next = bar.querySelector(SEL().seasonNext);

      // The label: the dedicated popup-label, else the first descendant whose
      // *whole* text reads like a season. Never the prev/next button text.
      const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
      const seasonish = (t) => /^(season\s*)?\d{1,3}$/i.test(t) || /^season\s+\d/i.test(t);
      let curLabel = clean(text(bar, SEL().seasonLabel));
      if (!seasonish(curLabel)) {
        curLabel = "";
        const cands = bar.querySelectorAll("[class*='label-'], span, div");
        for (let i = 0; i < cands.length; i++) {
          const t = clean(cands[i].textContent);
          if (seasonish(t)) { curLabel = t; break; }
        }
      }
      let active = routeSeason != null ? parseInt(routeSeason, 10) : null;
      if (active == null && curLabel) {
        const m = curLabel.match(/(\d+)/);
        active = m ? parseInt(m[1], 10) : null;
      }

      // Stremio's other seasons live in a closed popup (multiselect-menu), so
      // there's no strip to enumerate - the phone uses the prev/next stepper.
      return {
        label: curLabel || (active != null ? "Season " + active : "Season"),
        active: active,
        hasPrev: !dis(prev),
        hasNext: !dis(next),
      };
    },

    episodeRows(activeSeason) {
      const list = document.querySelector(SEL().videosList);
      if (!list) return [];
      const rows = [];
      const nodes = Array.prototype.slice.call(
        list.querySelectorAll(SEL().videoRow),
        0,
        400,
      );
      nodes.forEach((row, i) => {
        const label = row.textContent.trim().replace(/\s+/g, " ");
        const title = text(row, SEL().videoRowTitle) || label.slice(0, 80);
        let season = null,
          episode = null;
        const m =
          label.match(/S\s*(\d+)\s*[·:\s]*E\s*(\d+)/i) ||
          label.match(/(\d+)\s*[x×]\s*(\d+)/);
        if (m) { season = parseInt(m[1], 10); episode = parseInt(m[2], 10); }
        if (episode == null) {
          const tm = title.match(/^(\d+)\b/);
          if (tm) episode = parseInt(tm[1], 10);
        }
        if (season == null && activeSeason != null) season = parseInt(activeSeason, 10);
        rows.push({
          label: label.slice(0, 120),
          title: title,
          season: season,
          episode: episode,
          ordinal: i,
          thumb: thumbFrom(row),
          watched: /watched|seen/i.test(row.className),
          el: row,
        });
      });
      return rows;
    },

    streamList() {
      const out = [];
      // Cap hard: debrid/torrent addons can list many hundreds of results and
      // the whole list rides in every SSE frame to the phone.
      const links = Array.prototype.slice.call(
        document.querySelectorAll(SEL().streamLink),
        0,
        80,
      );
      links.forEach((a, i) => {
        out.push({
          index: i,
          label: a.textContent.trim().replace(/\s+/g, " ").slice(0, 140),
          addon: text(a, SEL().streamAddonName),
          href: a.getAttribute("href") || "",
        });
      });
      return out;
    },

    browse() {
      const route = window.RouteDetector
        ? window.RouteDetector.getRouteState()
        : { view: "UNKNOWN" };
      const hash = window.location.hash;
      const out = { view: route.view, hash: hash };

      if (hash === "" || hash === "#" || hash === "#/" || hash.startsWith("#/board")) {
        out.boardRows = this.boardRows();
      } else if (
        hash.startsWith("#/library") ||
        hash.startsWith("#/discover") ||
        hash.startsWith("#/search")
      ) {
        out.grid = this.grid();
      }

      if (route.view === "DETAIL" || route.view === "STREAMS") {
        out.season = this.seasonInfo(route.season);
        var activeS = out.season ? out.season.active : route.season;
        out.episodes = this.episodeRows(activeS).map(function (r) {
          return {
            label: r.label, title: r.title, season: r.season,
            episode: r.episode, ordinal: r.ordinal, watched: r.watched,
            thumb: r.thumb,
          };
        });
        out.streams = this.streamList();
      }

      // Self-diagnosis: only when the list the route expects came back empty,
      // ship selector-match flags + one raw sample so a selector break can be
      // fixed from the phone without PC console access.
      const wantList =
        hash === "" || hash === "#" || hash === "#/" || hash.startsWith("#/board")
          ? "board"
          : /^#\/(library|discover|search)/.test(hash)
            ? "grid"
            : route.view === "DETAIL" || route.view === "STREAMS"
              ? "detail"
              : null;
      const gotItems =
        wantList === "board"
          ? (out.boardRows || []).length
          : wantList === "grid"
            ? (out.grid || []).length
            : wantList === "detail"
              ? (out.episodes || []).length || (out.streams || []).length
              : true;
      if (wantList && !gotItems) {
        const raw = document.querySelector(SEL().metaItem);
        out._debug = {
          hash: hash,
          view: route.view,
          want: wantList,
          rowMatch: !!document.querySelector(SEL().boardRow),
          containerMatch: !!document.querySelector(SEL().metaItemsContainer),
          metaItemMatch: !!raw,
          metaItem: raw ? raw.outerHTML.slice(0, 700) : "(no match)",
          videoRow: (document.querySelector(SEL().videoRow) || {}).outerHTML
            ? document.querySelector(SEL().videoRow).outerHTML.slice(0, 400)
            : null,
        };
      }
      return out;
    },

    nowPlayingMeta() {
      const logo = document.querySelector(SEL().logoImage);
      return {
        title: logo
          ? logo.getAttribute("title") || logo.getAttribute("alt") || null
          : null,
      };
    },

    playerUi() {
      return {
        controlBarVisible: !!document.querySelector(SEL().controlBar),
        nextVideoAvailable: !!document.querySelector(SEL().nextVideoButton),
      };
    },
  };

  window.KaiRemote.Scrapers = Scrapers;
  console.log("[Kai Remote] scrapers loaded (v1.1)");
})();
