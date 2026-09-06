/**
 * @name Remote - Selector Map
 * @description The ONLY file in webmods/Remote/ that hard-codes Stremio's hashed
 *              class names. Prefer [class^="prefix-"] + attribute/title selectors
 *              that survive class-hash churn between community-v5 rebases.
 * @version 1.0.0
 * @author allecsc / Stremio Kai
 *
 * !! RE-VERIFY EVERY SELECTOR HERE ON EVERY UPSTREAM (stremio-community-v5) REBASE !!
 */

(function () {
  "use strict";
  window.KaiRemote = window.KaiRemote || {};
  if (window.KaiRemote.SEL) return;

  window.KaiRemote.SEL = {
    // --- routing / shell ------------------------------------------------
    routesContainer: ".router-lqoloM, [class^='routes-container']",

    // --- board (home) --------------------------------------------------
    boardRow: "[class^='board-row-']",
    boardRowLabel: "[class^='row-label-'], [class*='header-'] [class^='title-']",

    // --- generic meta grid (board / discover / library / search) ------
    metaItem: "[class^='meta-item-container-'], [class^='meta-item-']",
    metaItemLabel: "[class^='title-bar-container-'] [class^='title-'], [class^='title-']",
    metaItemPoster: "[class^='poster-image-'], [class^='poster-container-'] img",
    metaItemsContainer: "[class^='meta-items-container-'], [class^='meta-items-']",
    continueWatchingRow: "[class^='continue-watching-row-']",
    playIconLayer: "[class^='play-icon-layer-']",

    // --- detail / episodes / streams ---------------------------------
    videosList: "[class^='videos-list-']",
    videoRow: "[class^='video-container-'], [class^='video-']",
    videoRowTitle: "[class^='title-']",
    videoRowNumber: "[class^='episode-'], [class^='season-episode-']",
    streamsList: "[class^='streams-list-']",
    streamLink: "[class^='streams-list-'] a[href]",
    streamAddonName: "[class^='addon-name-'], [class^='label-']",

    // --- player ------------------------------------------------------
    player: "#/player",
    nextVideoButton: 'div[title="Next Video"]',
    controlBar: "[class^='control-bar-']",
    logoImage: ".logo-X3hTV, [class^='logo-']",

    // --- search ----------------------------------------------------
    searchInput:
      "[class^='search-input-'] input, [class^='search-bar-'] input, input[type='search']",

    // --- top nav / sidebar (for D-pad focus targets) --------------
    horizontalNav: "[class^='horizontal-nav-bar-']",
    verticalNav: "[class^='vertical-nav-bar-']",
  };

  // Page hashes for nav_page cycling (mirrors navigation.js PAGES).
  window.KaiRemote.PAGES = [
    "#/",
    "#/discover",
    "#/library",
    "#/calendar",
    "#/addons",
    "#/settings",
  ];

  console.log("[Kai Remote] selectors loaded");
})();
