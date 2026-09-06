/**
 * @name Remote - Scrapers
 * @description Enumerate whatever page is currently open (board rows / library /
 *              search results / episode list / stream list) into plain objects the
 *              phone can render. Never navigates on its own.
 * @version 1.0.0
 * @author allecsc / Stremio Kai
 */

(function () {
  "use strict";
  window.KaiRemote = window.KaiRemote || {};
  if (window.KaiRemote.Scrapers) return;

  const SEL = () => window.KaiRemote.SEL;

  function text(el, sel) {
    const n = el.querySelector(sel);
    return n ? n.textContent.trim() : "";
  }

  function posterUrl(el) {
    const img = el.querySelector(SEL().metaItemPoster);
    if (img && img.src) return img.src;
    const bg = el.querySelector("[style*='background-image']");
    if (bg) {
      const m = bg.getAttribute("style").match(/url\(["']?(.*?)["']?\)/);
      if (m) return m[1];
    }
    return "";
  }

  function parseDeepLink(href) {
    // #/detail/series/tt123/tt123  or  #/detail/movie/tt456
    const m = (href || "").match(/#\/detail\/(movie|series)\/([^/?]+)/);
    if (!m) return null;
    return { type: m[1], id: decodeURIComponent(m[2]).split("/")[0] };
  }

  function scrapeGridItem(el) {
    const a = el.querySelector("a[href]") || el.closest("a[href]");
    const href = a ? a.getAttribute("href") : "";
    const dl = parseDeepLink(href);
    return {
      name: text(el, SEL().metaItemLabel) || el.getAttribute("title") || "",
      poster: posterUrl(el),
      deepLink: href,
      type: dl ? dl.type : null,
      metaId: dl ? dl.id : null,
    };
  }

  const Scrapers = {
    boardRows() {
      const rows = [];
      document.querySelectorAll(SEL().boardRow).forEach((row) => {
        const items = [];
        row.querySelectorAll(SEL().metaItem).forEach((it) => {
          const parsed = scrapeGridItem(it);
          if (parsed.name || parsed.metaId) items.push(parsed);
        });
        if (items.length) {
          rows.push({
            rowTitle: text(row, SEL().boardRowLabel),
            continueWatching: !!row.closest(SEL().continueWatchingRow),
            items: items.slice(0, 30),
          });
        }
      });
      return rows;
    },

    grid() {
      // library / discover / search results - a single flat grid
      const out = [];
      const container =
        document.querySelector(SEL().metaItemsContainer) || document;
      container.querySelectorAll(SEL().metaItem).forEach((it) => {
        const parsed = scrapeGridItem(it);
        if (parsed.name || parsed.metaId) out.push(parsed);
      });
      return out.slice(0, 100);
    },

    episodeRows() {
      const list = document.querySelector(SEL().videosList);
      if (!list) return [];
      const rows = [];
      list.querySelectorAll(SEL().videoRow).forEach((row) => {
        const label = row.textContent.trim().replace(/\s+/g, " ");
        // Try to pull S/E from a "1x03" / "S1 E3" style label or data attrs.
        let season = null,
          episode = null;
        const m = label.match(/(?:S(\d+)\s*[·:]?\s*E(\d+))|(\d+)\s*[x×]\s*(\d+)/i);
        if (m) {
          season = parseInt(m[1] || m[3], 10);
          episode = parseInt(m[2] || m[4], 10);
        }
        rows.push({
          label,
          title: text(row, SEL().videoRowTitle) || label,
          season,
          episode,
          watched: /watched|seen/i.test(row.className),
          el: row,
        });
      });
      return rows;
    },

    streamList() {
      const links = document.querySelectorAll(SEL().streamLink);
      const out = [];
      links.forEach((a, i) => {
        out.push({
          index: i,
          label: a.textContent.trim().replace(/\s+/g, " ").slice(0, 120),
          addon: text(a, SEL().streamAddonName),
          href: a.getAttribute("href") || "",
        });
      });
      return out;
    },

    // Snapshot appropriate to the current route.
    browse() {
      const route = window.RouteDetector
        ? window.RouteDetector.getRouteState()
        : { view: "UNKNOWN" };
      const hash = window.location.hash;
      const out = { view: route.view, hash };

      if (hash === "#/" || hash === "" || hash === "#") {
        out.boardRows = this.boardRows();
      } else if (hash.startsWith("#/library") || hash.startsWith("#/board")) {
        out.grid = this.grid();
      } else if (hash.startsWith("#/search")) {
        out.searchResults = this.grid();
      } else if (hash.startsWith("#/discover")) {
        out.grid = this.grid();
      }

      if (route.view === "DETAIL" || route.view === "STREAMS") {
        out.episodes = this.episodeRows().map(({ el, ...rest }) => rest);
        out.streams = this.streamList();
      }
      return out;
    },

    nowPlayingMeta() {
      const logo = document.querySelector(SEL().logoImage);
      return {
        title: logo ? logo.getAttribute("title") || logo.getAttribute("alt") : null,
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
  console.log("[Kai Remote] scrapers loaded");
})();
