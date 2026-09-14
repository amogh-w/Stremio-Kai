/**
 * @name Phone Remote Settings
 * @description Injects a "Phone Remote" card into Stremio's Settings page. Writes
 *              kai-remote-* localStorage keys and dispatches `kai-settings-changed`
 *              so webmods/Remote/remote-client.js pushes the config down to
 *              scripts/remote-control/main.lua.
 * @version 1.1.0
 * @author allecsc / Stremio Kai
 *
 * @changelog
 *   v1.1.0 - Fix: was blindly appended to the end of the whole settings page
 *            (.settings-content-lLXmk), so it landed wherever that happened to
 *            render and overlapped other sections. Now anchored right after the
 *            Kai Shortcuts section by title text, same technique as
 *            custom-shortcuts.js / mpv-settings.js.
 *   v1.0.0 - Initial: enable toggle, port, PIN, live URL readout.
 *            (QR code is a planned follow-up - needs a vendored generator.)
 */

(function () {
  "use strict";
  if (window.KaiRemoteSettings?.initialized) return;
  window.KaiRemoteSettings = { initialized: true };

  const KEYS = {
    enabled: "kai-remote-enabled",
    port: "kai-remote-port",
    token: "kai-remote-token",
  };
  const DEFAULT_PORT = 5000;
  // custom-shortcuts.js renames "Player Shortcuts" -> "Kai Shortcuts" in place;
  // match either so this works whether or not that webmod has run yet.
  const ANCHOR_SECTION_LABELS = ["Kai Shortcuts", "Player Shortcuts"];
  const MARK = "kai-remote-setting";

  const get = (k, d) => {
    const v = localStorage.getItem(k);
    return v === null ? d : v;
  };
  const set = (k, v) => {
    localStorage.setItem(k, String(v));
    window.dispatchEvent(new Event("kai-settings-changed"));
  };

  function ensureStyles() {
    if (document.getElementById("kai-settings-ui-css") || !document.head) return;
    const link = document.createElement("link");
    link.id = "kai-settings-ui-css";
    link.rel = "stylesheet";
    link.href = "webmods/Theme/Settings.css";
    document.head.appendChild(link);
  }

  // --- tiny UI factories (Stremio-styled, mirrors mpv-settings.js) --------
  function toggle(labelText, descText, checked, onChange) {
    const c = document.createElement("div");
    c.className = "option-container-EGlcv kai-mpv-setting " + MARK;

    const nameC = document.createElement("div");
    nameC.className = "option-name-container-exGMI";
    const label = document.createElement("div");
    label.className = "label-FFamJ";
    label.textContent = labelText;
    if (descText) {
      const d = document.createElement("div");
      d.className = "label-FFamJ";
      d.style.cssText =
        "color:rgba(191,191,191,.5);display:block;white-space:normal;line-height:1.4;margin-top:.25rem";
      d.textContent = descText;
      label.appendChild(d);
    }
    nameC.appendChild(label);

    const tC = document.createElement("div");
    tC.tabIndex = -1;
    tC.className =
      "option-input-container-NPgpT toggle-container-lZfHP button-container-zVLH6" +
      (checked ? " checked" : "");
    const knob = document.createElement("div");
    knob.className = "toggle-toOWM";
    tC.appendChild(knob);
    tC.addEventListener("click", () => {
      const v = !tC.classList.contains("checked");
      tC.classList.toggle("checked", v);
      onChange(v);
    });

    c.appendChild(nameC);
    c.appendChild(tC);
    return c;
  }

  function textInput(labelText, descText, value, placeholder, onCommit) {
    const c = document.createElement("div");
    c.className = "option-container-EGlcv kai-mpv-setting " + MARK;

    const nameC = document.createElement("div");
    nameC.className = "option-name-container-exGMI";
    const label = document.createElement("div");
    label.className = "label-FFamJ";
    label.textContent = labelText;
    if (descText) {
      const d = document.createElement("div");
      d.className = "label-FFamJ";
      d.style.cssText =
        "color:rgba(191,191,191,.5);display:block;white-space:normal;line-height:1.4;margin-top:.25rem";
      d.textContent = descText;
      label.appendChild(d);
    }
    nameC.appendChild(label);

    const inC = document.createElement("div");
    inC.className = "option-input-container-NPgpT";
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder || "";
    input.className = "kai-settings-input";
    input.addEventListener("blur", () => onCommit(input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
    inC.appendChild(input);

    c.appendChild(nameC);
    c.appendChild(inC);
    return c;
  }

  function header(text) {
    const h = document.createElement("div");
    h.className = "section-category-container-EOuS0 kai-mpv-setting " + MARK;
    h.insertAdjacentHTML(
      "beforeend",
      '<svg class="icon-REQkK" viewBox="0 0 24 24" fill="none"><path d="M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm5 13h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    );
    const l = document.createElement("div");
    l.className = "label-FFamJ";
    l.textContent = text;
    h.appendChild(l);
    return h;
  }

  function infoNote(html) {
    const n = document.createElement("div");
    n.className = "description-label-h5DXc kai-info-note kai-mpv-setting " + MARK;
    n.innerHTML = html;
    return n;
  }

  // --- URL readout (polls the local server's /healthz) -------------------
  function urlReadout() {
    const box = document.createElement("div");
    box.className = "option-container-EGlcv kai-mpv-setting " + MARK;
    box.style.flexDirection = "column";
    box.style.alignItems = "flex-start";
    box.style.gap = ".4rem";

    const label = document.createElement("div");
    label.className = "label-FFamJ";
    label.textContent = "Address for your phone";
    label.style.cssText = "color:rgba(255,255,255,.55)";
    box.appendChild(label);

    const value = document.createElement("div");
    value.className = "kai-remote-address";
    value.style.cssText =
      "font-size:1.1rem;font-weight:600;color:#fff;user-select:all;word-break:break-all";
    value.textContent = "…";
    box.appendChild(value);

    const hint = document.createElement("div");
    hint.style.cssText = "color:rgba(191,191,191,.5);font-size:.85rem";
    hint.textContent =
      "Open this in your phone's browser on the same Wi‑Fi. Allow the Windows Firewall prompt the first time.";
    box.appendChild(hint);

    async function refresh() {
      const port = get(KEYS.port, DEFAULT_PORT);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        const j = await r.json();
        const tok = get(KEYS.token, "");
        const urls = (j.urls || []).map((u) =>
          tok ? `${u}/#t=${encodeURIComponent(tok)}` : u,
        );
        value.textContent = urls[0] || `http://<this-pc>:${port}`;
        if (urls.length > 1) {
          value.title = "Other addresses:\n" + urls.join("\n");
        }
      } catch (e) {
        value.textContent = get(KEYS.enabled, "false") === "true"
          ? "Starting server… reopen Settings in a moment"
          : "Enable the remote above to see the address";
      }
    }
    refresh();
    box._refresh = refresh;
    setTimeout(refresh, 1500);
    setTimeout(refresh, 4000);
    return box;
  }

  // --- locate the Kai Shortcuts section (title text match, like
  // custom-shortcuts.js / mpv-settings.js do for their own sections) --------
  function findAnchorSection() {
    const titles = document.querySelectorAll(".section-title-Nt71Z");
    for (const title of titles) {
      const txt = title.textContent.trim();
      if (ANCHOR_SECTION_LABELS.some((l) => txt.includes(l))) {
        return title.closest(".section-container-twzKQ");
      }
    }
    return null;
  }

  // --- build + inject ---------------------------------------------------
  function build() {
    const wrap = document.createElement("div");
    wrap.className = "section-container-twzKQ " + MARK;

    wrap.appendChild(header("Phone Remote"));

    const readout = urlReadout();

    wrap.appendChild(
      toggle(
        "Enable Phone Remote",
        "Runs a small local web server so a phone on your Wi‑Fi can control playback, navigation and browsing.",
        get(KEYS.enabled, "false") === "true",
        (v) => {
          set(KEYS.enabled, v);
          setTimeout(() => readout._refresh && readout._refresh(), 1200);
        },
      ),
    );

    wrap.appendChild(
      textInput(
        "Port",
        "Default 5000. Change only if it clashes with another app.",
        get(KEYS.port, DEFAULT_PORT),
        String(DEFAULT_PORT),
        (v) => {
          const n = parseInt(v, 10);
          set(KEYS.port, n >= 1024 && n <= 65535 ? n : DEFAULT_PORT);
          setTimeout(() => readout._refresh && readout._refresh(), 1200);
        },
      ),
    );

    wrap.appendChild(
      textInput(
        "PIN (optional)",
        "When set, the phone must include this PIN. Recommended on shared or public networks.",
        get(KEYS.token, ""),
        "leave empty for open access",
        (v) => {
          set(KEYS.token, v);
          setTimeout(() => readout._refresh && readout._refresh(), 800);
        },
      ),
    );

    wrap.appendChild(readout);
    wrap.appendChild(
      infoNote(
        "The remote can browse catalogs, open titles/episodes and start streams. " +
          "It only works while Stremio Kai is running on this PC.",
      ),
    );

    return wrap;
  }

  function inject() {
    if (document.querySelector("." + MARK)) return true;
    const anchor = findAnchorSection();
    if (!anchor) return false; // Kai Shortcuts section not mounted (yet)
    anchor.insertAdjacentElement("afterend", build());
    console.log("[Kai Remote] settings section injected (below Kai Shortcuts)");
    return true;
  }

  function observe() {
    ensureStyles();
    inject();
    // Keep observing (don't disconnect): the settings DOM is torn down and
    // rebuilt on each visit, so we must re-inject each time. The MARK guard
    // inside inject() makes this idempotent within a single mount.
    let t = null;
    const obs = new MutationObserver(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        inject();
      }, 60);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe);
  } else {
    observe();
  }
})();
