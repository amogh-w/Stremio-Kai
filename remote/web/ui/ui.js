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

  icons();
  window.UI = { icon, icons, toast };
})();
