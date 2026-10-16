/* ui.js: tiny behaviours for the kit (about 2 KB gzipped, no dependencies).
   Load at the end of <body>. Optional: set window.UI_SPRITE before it (default "/icons.svg"). */
(() => {
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const NS = "http://www.w3.org/2000/svg";
  const SPRITE = () => window.UI_SPRITE || "/icons.svg";

  /* Icons: <i data-i="house" class="size-5"></i> becomes an inline <svg><use/></svg>. */
  const icon = (name, cls = "size-5") => {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("class", cls + " shrink-0");
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS(NS, "use");
    u.setAttribute("href", SPRITE() + "#" + name);
    s.appendChild(u);
    return s;
  };
  const icons = (root = document) => $$("i[data-i]", root).forEach((i) => i.replaceWith(icon(i.dataset.i, i.className)));

  /* Segmented control with a sliding thumb: <div class="seg" data-group><span class="thumb"></span><button aria-pressed>... */
  const placeThumb = (s) => {
    const t = s.querySelector(".thumb"), on = s.querySelector("[aria-pressed=true]");
    if (!t || !on) return;
    t.style.width = on.offsetWidth + "px";
    t.style.transform = `translateX(${on.offsetLeft - 2}px)`;
  };
  $$(".seg[data-group]").forEach((s) => {
    s.addEventListener("sync", () => placeThumb(s));
    s.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", s).forEach((x) => x.setAttribute("aria-pressed", x === b));
      placeThumb(s);
    });
    placeThumb(s);
  });
  addEventListener("resize", () => $$(".seg[data-group]").forEach(placeThumb));
  addEventListener("load", () => $$(".seg[data-group]").forEach(placeThumb));

  /* Underline tabs, tab bars, sidebars: [data-tabs] > button[aria-selected]. Chips: [data-chips] > .chip[aria-pressed]. */
  $$("[data-tabs],[data-tabs-group]").forEach((g) =>
    g.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !g.contains(b)) return;
      $$("button", g).forEach((x) => x.setAttribute("aria-selected", x === b));
    }));
  $$("[data-chips]").forEach((g) =>
    g.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (b) b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
    }));

  /* Range: paints the filled part of the track. */
  $$(".range").forEach((r) => {
    const f = () => r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%");
    r.addEventListener("input", f);
    f();
  });

  /* Toasts: UI.toast("Saved", "success" | "info" | "error"). Creates #toasts if the page has none. */
  const TOAST_ICON = { info: ["info", "text-blue"], success: ["circle-check", "text-green"], error: ["circle-x", "text-red"] };
  const toast = (msg, kind = "info") => {
    let box = document.getElementById("toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "toasts";
      box.className = "pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2";
      document.body.appendChild(box);
    }
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    const [name, color] = TOAST_ICON[kind] || TOAST_ICON.info;
    el.appendChild(icon(name, "size-5 " + color));
    el.appendChild(document.createTextNode(msg));
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s, transform .3s";
      el.style.opacity = 0;
      el.style.transform = "translateY(-20px)";
      setTimeout(() => el.remove(), 300);
    }, 2600);
  };

  /* Dialogs and menus (native <dialog> and popover):
     [data-open="id"] opens a dialog, [data-close] closes its dialog, a click on the backdrop closes it.
     [data-menu="id"] toggles a popover.menu next to the trigger, [data-menu-close] closes it. */
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) return document.getElementById(o.dataset.open).showModal();
    if (e.target.closest("[data-close]")) return e.target.closest("dialog").close();
    if (e.target.tagName === "DIALOG") return e.target.close();
    const m = e.target.closest("[data-menu]");
    if (m) {
      const p = document.getElementById(m.dataset.menu), r = m.getBoundingClientRect();
      p.togglePopover();
      p.style.top = Math.min(r.bottom + 8, innerHeight - p.offsetHeight - 8) + "px";
      p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + "px";
      return;
    }
    if (e.target.closest("[data-menu-close]")) e.target.closest("[popover]").hidePopover();
  });

  /* Bottom sheets: drag the .sheet-grip (grabber and title row) down to dismiss, or pull down from the top of
     scrolled content. Past 30% of the height, or a quick flick, closes it; otherwise it springs back. */
  const sheetDrag = (d) => {
    const SCRIM = 55; // matches the default --scrim in kit.css
    let y0 = 0, t0 = 0, dy = 0, active = false, pull = false;
    const reset = () => {
      d.style.transition = "";
      d.style.transform = "";
      d.style.removeProperty("--scrim");
    };
    const move = (v) => {
      dy = Math.max(0, v);
      d.style.transition = "none";
      d.style.transform = `translateY(${dy}px)`;
      d.style.setProperty("--scrim", Math.max(0, SCRIM * (1 - dy / d.offsetHeight)) + "%");
    };
    const finish = () => {
      const fast = dy / Math.max(1, performance.now() - t0) > 0.6;
      active = false;
      if (dy > d.offsetHeight * 0.3 || (fast && dy > 40)) {
        d.style.transition = "transform .25s var(--ease)";
        d.style.transform = "translateY(100%)";
        setTimeout(() => { d.close(); reset(); }, 230);
      } else {
        reset();
      }
    };
    $$(".sheet-grip", d).forEach((g) => {
      g.addEventListener("pointerdown", (e) => { active = true; y0 = e.clientY; t0 = performance.now(); dy = 0; g.setPointerCapture(e.pointerId); });
      g.addEventListener("pointermove", (e) => { if (active) move(e.clientY - y0); });
      g.addEventListener("pointerup", () => { if (active) finish(); });
      g.addEventListener("pointercancel", () => { if (active) finish(); });
    });
    d.addEventListener("touchstart", (e) => {
      pull = d.scrollTop <= 0 && !e.target.closest(".sheet-grip");
      if (pull) { y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; }
    }, { passive: true });
    d.addEventListener("touchmove", (e) => {
      if (!pull) return;
      const m = e.touches[0].clientY - y0;
      if (m > 8 && d.scrollTop <= 0) { active = true; move(m); e.preventDefault(); }
      else if (!active && m < 0) pull = false;
    }, { passive: false });
    d.addEventListener("touchend", () => { if (active && pull) finish(); pull = false; });
  };
  $$("dialog.sheet").forEach(sheetDrag);

  /* Horizontal rows (season chips, tabs, poster strips) have hidden scrollbars, so a mouse had no way to move them.
     No markup needed: any element that scrolls sideways gets
       - wheel to sideways scroll, on short rows only (chips and tabs, up to 72px tall), so tall strips never hijack page scrolling
       - click-and-drag with a mouse, on every row
     Touch keeps its native scrolling. */
  const hscrollOf = (t) => {
    for (let n = t; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1) {
        const o = getComputedStyle(n).overflowX;
        if (o === "auto" || o === "scroll") return n;
      }
    }
    return null;
  };
  document.addEventListener("wheel", (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // pinch zoom, or already a sideways wheel
    const el = hscrollOf(e.target);
    if (!el || el.clientHeight > 72) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const next = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + dy));
    if (next === el.scrollLeft) return; // at an edge: let the page scroll on
    el.scrollLeft = next;
    e.preventDefault();
  }, { passive: false });

  let rowDrag = null;
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = hscrollOf(e.target);
    if (el) rowDrag = { el, x: e.clientX, left: el.scrollLeft, moved: false, snap: el.style.scrollSnapType };
  });
  document.addEventListener("pointermove", (e) => {
    if (!rowDrag || e.pointerType !== "mouse") return;
    const dx = e.clientX - rowDrag.x;
    if (!rowDrag.moved) {
      if (Math.abs(dx) < 6) return; // a click, not a drag
      rowDrag.moved = true;
      rowDrag.el.style.scrollSnapType = "none";
      rowDrag.el.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }
    rowDrag.el.scrollLeft = rowDrag.left - dx;
  });
  const endRowDrag = () => {
    if (!rowDrag) return;
    if (rowDrag.moved) {
      const el = rowDrag.el;
      el.style.scrollSnapType = rowDrag.snap;
      el.style.cursor = "";
      document.body.style.userSelect = "";
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; // the drag must not also "click" a chip or poster
      el.addEventListener("click", swallow, true);
      setTimeout(() => el.removeEventListener("click", swallow, true), 0);
    }
    rowDrag = null;
  };
  document.addEventListener("pointerup", endRowDrag);
  document.addEventListener("pointercancel", endRowDrag);
  document.addEventListener("dragstart", (e) => { if (hscrollOf(e.target)) e.preventDefault(); }); // no ghost-image drags inside rows

  /* Motion helpers (only transform and opacity animate; reduced motion is honored in kit.css).
     UI.play(el, "fade" | "pop" | "slide" | "shake" | "stagger", duration)  replays an entrance animation.
       "stagger" rises the first 6 children one after another.
     UI.reveal(img)         <img> inside a .skel wrapper: the wrapper shimmers until the picture loads, then it fades in.
     UI.loadBg(el, url, cb) background-image that fades in once it has loaded (cb runs then, e.g. to remove a skeleton). */
  const play = (el, kind = "fade", dur) => {
    if (!el) return;
    el.classList.remove("anim", "m-pop", "m-slide", "m-fade", "m-shake", "m-stagger");
    if (kind === "stagger") [...el.children].forEach((c, i) => c.style.setProperty("--i", Math.min(i, 5)));
    if (dur) el.style.setProperty("--m-dur", dur);
    void el.offsetWidth; // restart the animation
    el.classList.add("anim", "m-" + kind);
  };
  const reveal = (img) => {
    img.classList.add("opacity-0", "transition-opacity", "duration-300");
    const done = () => {
      img.classList.remove("opacity-0");
      const w = img.closest(".skel");
      if (w) w.classList.remove("skel");
    };
    if (img.complete && img.naturalWidth) done();
    else {
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    }
  };
  const loadBg = (el, url, onShown) => {
    if (!el) return;
    const key = url || "";
    if (el.dataset.bg === key) return;
    el.dataset.bg = key;
    if (!url) { el.style.backgroundImage = ""; return; }
    const i = new Image();
    i.onload = () => {
      if (el.dataset.bg !== key) return; // a newer picture was requested meanwhile
      el.style.transition = "none";
      el.style.opacity = 0;
      el.style.backgroundImage = `url("${url}")`;
      void el.offsetWidth;
      el.style.transition = "opacity .5s var(--ease)";
      el.style.opacity = 1;
      if (onShown) onShown();
    };
    i.src = url;
  };

  icons();
  window.UI = { icon, icons, toast, sheetDrag, play, reveal, loadBg };
})();
