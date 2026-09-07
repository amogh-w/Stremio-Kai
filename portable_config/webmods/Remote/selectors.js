/**
 * @name Remote - Selector Map
 * @description The ONE file in webmods/Remote/ that hard-codes Stremio's hashed
 *              class names. Values are taken from the classes navigation.js /
 *              Metadata/dom-processor.js / details-enhancer.js already rely on,
 *              with a [class^=] / [class*=] fallback so a hash change degrades
 *              instead of breaking.
 * @version 1.1.2
 * @author allecsc / Stremio Kai
 *
 * @changelog
 *   1.1.2 - fullscreenButton (control-bar) for the phone fullscreen toggle.
 *   1.1.1 - season bar selectors (prev / next / current-label) for the phone
 *           season stepper. Confirmed against a live series page.
 *   1.1.0 - Real class names from the working webmods; poster + video-row + grid
 *           container selectors corrected.
 *   1.0.0 - Initial (prefix guesses).
 *
 * !! RE-VERIFY ON EVERY stremio-community-v5 REBASE !!
 */

(function () {
  "use strict";
  window.KaiRemote = window.KaiRemote || {};
  if (window.KaiRemote.SEL) return;

  window.KaiRemote.SEL = {
    // --- board (home) --------------------------------------------------
    boardContent: ".board-content-nPWv1, [class^='board-content-']",
    boardRow: ".board-row-CoJrZ, [class^='board-row-']",
    // Stremio renders the row heading as an <a>/<div> with a title- class,
    // a direct child of the row (not inside a meta-item).
    boardRowLabel:
      ":scope > a [class*='title-'], :scope > div [class*='title-'], [class*='header-'] [class*='title-'], [class*='title-container-'] [class*='title-']",
    seeAll: ".see-all-container-MoOtW, [class^='see-all-']",

    // --- meta grid (board / discover / library / search) --------------
    metaItemsContainer:
      ".meta-items-container-n8vNz, .meta-items-container-qcuUA, .meta-items-container-IKrND, [class^='meta-items-container-']",
    // The meta-item IS an <a> (navigation.js checks classList on it directly).
    metaItem: ".meta-item-container-Tj0Ib, [class^='meta-item-container-']",
    metaItemTitle: "[class*='title-bar-'] [class*='title-'], [class*='title-']",
    posterImg: "img.poster-image-NiV7O, img[class*='poster-image'], img[src*='poster']",
    posterContainer: ".poster-container-qkw48, [class*='poster-container'], [class*='poster-image']",
    continueWatchingRow:
      ".continue-watching-row-ZiNSa, [class*='continue-watching']",

    // --- detail / episodes / streams ---------------------------------
    videosList: ".videos-list-nE0LJ, .videos-container-msX8s, [class^='videos-list-'], [class*='videos-container-']",
    videoRow: ".video-container-ezBpK, [class^='video-container-']",
    videoRowTitle: ".title-container-NcfV9, [class*='title-container-'], [class*='title-']",
    seasonsBar: ".seasons-bar-container-nOZjG, .seasons-bar-Ma8vp, [class*='seasons-bar']",
    seasonLabel: ".seasons-popup-label-container-fZcu4 .label-SoEGc, [class*='seasons-popup-label'] [class*='label-']",
    seasonPrev: ".prev-season-button-bs1GQ, [class*='prev-season']",
    seasonNext: ".next-season-button-RrYAq, [class*='next-season']",
    streamsList: ".streams-list-Y1lCM, [class^='streams-list-']",
    streamLink:
      ".streams-list-Y1lCM a[href], [class^='streams-list-'] a[href]",
    streamAddonName: "[class*='addon-name-'], [class*='name-container-'], [class*='label-']",

    // --- player ------------------------------------------------------
    nextVideoButton: 'div[title="Next Video"], [title="Next Video"]',
    controlBar: ".control-bar-container-xsWA7, [class^='control-bar-']",
    fullscreenButton:
      '[title="Enter Fullscreen"], [title="Exit Fullscreen"], [title*="Fullscreen"], [title*="Full Screen"], [class*="fullscreen-button"]',
    logoImage: ".logo-X3hTV, [class*='logo-']",

    // --- search / nav ----------------------------------------------
    searchInput:
      ".search-input-IQ0ZW input, [class*='search-input-'] input, [class*='search-bar-'] input, input[type='search']",
  };

  window.KaiRemote.PAGES = [
    "#/",
    "#/discover",
    "#/library",
    "#/calendar",
    "#/addons",
    "#/settings",
  ];

  console.log("[Kai Remote] selectors loaded (v1.1)");
})();
