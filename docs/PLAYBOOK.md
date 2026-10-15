# Project playbook

A project-agnostic recipe for building a small, polished, local-first app the way I like it: one
program that serves its own web UI, a thin typed protocol, a clean separation between the platform
layer and the logic, strong tests, honest docs, and a calm visual style.

Hand this file to an AI coding agent (or a person) at the start of a new project. Following it should
give the same kind of result: the same stack, the same structure, the same conventions, the same
order of work, and the same mistakes avoided.

Placeholders used below:

- `<app>`: the project name (lowercase, no spaces, used for the binary and folder names).
- `<App>`: the display name.
- `<platform layer>`: whatever talks to the operating system (input injection, files, media, and so on).

Prose rule for everything in this document and everything the agent writes: use the plain hyphen
(`-`) as the only dash. No em dashes, no en dashes. Use a comma, a colon, parentheses or two
sentences instead. This applies to docs, comments, UI copy, commit messages and chat replies.

---

## Part 1. How to use this document

1. Put this file in the new project's `docs/` folder (or paste it into the first message).
2. Tell the agent what the app should do in plain words. Add anything that is specific to this
   project (target OS, what the platform layer must do).
3. Tell the agent: "Follow docs/PLAYBOOK.md. Start with Part 9 (the build order). Ask me only about
   decisions that block you. Recommend a default for everything else and go."
4. After the first working version, ask the agent to create `CLAUDE.md` from the template in
   Part 14 and keep it updated.

What stays fixed across projects: the principles (Part 2), stack (Part 3), layout (Part 4),
architecture patterns (Part 5), security rules (Part 6), frontend rules (Part 7), testing rules
(Part 8), docs rules (Part 11), hygiene rules (Part 12), git rules (Part 13).

What changes per project: the feature list, the protocol messages, the platform layer.

---

## Part 2. Principles and working style

### 2.1 About the product

- **Small and focused.** One program, one binary, one port, no installer needed to try it.
- **Local first.** No cloud, no accounts, no telemetry, no external requests from the UI. The app
  works on a local network or on one machine.
- **Self-contained UI.** The program serves its own web app. No CDN, no fonts or scripts loaded from
  elsewhere. The page works offline once loaded.
- **Simple beats clever.** If a screen feels complicated, it is. The test: can a new user understand
  the screen in three seconds without reading help text? If not, cut features from the screen or
  split the screen. (Example from experience: a clipboard screen with tabs, five buttons and a paste
  box was replaced by one box to send, one button to fetch, and one status line. Same functions,
  far easier.)
- **Honest UI.** Every action reports a real outcome. Never show "sent" when nothing was confirmed.
  Never show a button that does nothing. Empty and error states say what happened and what to do.
- **Do not ship a feature that is not good enough.** A first version of an authentication flow was
  built, judged not good, and removed completely (code, UI, tests, docs) with a note in the roadmap.
  Removing is better than keeping something half-right. Say in the README that it is planned.
- **Boring technology, used well.** Pick well-supported libraries. Add a dependency only when it
  removes real work. Remove a dependency when the feature using it goes away.

### 2.2 About working with an AI agent

- **Plan first for anything large.** Explore, then write a short plan (context, approach, files,
  order of work, verification, risks). Get a yes before building a big change.
- **Ask few questions.** Only ask when the answer changes what you do and cannot be found in the code
  or decided by a sensible default. When asking, offer 2-4 concrete options with a recommendation.
- **Act when you have enough information.** Do not re-argue decisions already made. Do not list
  options you will not pursue. Give a recommendation, not a survey.
- **Verify by running.** Build, run the tests, and look at the real thing (a browser screenshot, a
  real HTTP call, a real WebSocket call). Say what you did not test, especially anything that needs a
  real phone or real hardware.
- **Report outcomes faithfully.** If a test fails, say so and show the failing line. If a step was
  skipped, say so. If something is done and verified, say it plainly without hedging.
- **Own mistakes briefly.** If your change broke something, say what you broke and why, fix it, and
  add a test or check so it cannot silently happen again.
- **Do not over-iterate on things you cannot see.** When a problem only appears on a device you
  cannot test (for example an OS beta bug), make at most two or three evidence-based attempts, add a
  diagnostic the user can read on the device, and stop. Revert guesses that did not help. Do not
  pile speculative fixes on top of each other.
- **Keep the user's time in mind.** Slow checks (long browser sessions) should be short and
  targeted. If the user says tests are slow, stop testing that way and wrap up.
- **Finish with a short summary.** What changed, what was verified, what was not, what is next.
  Offer the commit. Keep it plain; no long recaps.
- **Never take irreversible or outward-facing actions without being asked.** No commits, pushes,
  publishing, deleting, or changes to the user's real data unless requested. Use fakes for anything
  risky (see Part 8).

---

## Part 3. The stack

These are my defaults. Use them unless the project cannot.

### 3.1 Language and server

| Concern | Choice | Notes |
|---|---|---|
| Language | Rust, stable, edition 2021 | One binary. |
| Async runtime | `tokio` (features: `rt-multi-thread`, `macros`, `net`, `signal`) | |
| HTTP + WebSocket | `axum` 0.8 with the `ws` feature | One port serves the UI, the socket and small HTTP routes. |
| Serialization | `serde` + `serde_json` | Tagged enum for messages. |
| LAN addresses | `if-addrs` | To show the user where to connect. |
| Images | `png` | Validate and encode PNG yourself, do not trust uploads. |
| Clipboard | `arboard` (feature `image-data`) | Windows. |
| Tray icon | `tray-icon` (no default features) | Windows. |
| Win32 calls | `windows-sys` (only the features you use) | Raw, no wrappers. |
| WinRT calls | `windows` crate (only the needed features) | Only when a Windows runtime API has no sys equivalent, for example the system media session. |
| Dev-only | `tokio-tungstenite`, `futures-util` | For end-to-end tests. |

Do not add: web frameworks on the frontend, ORMs, a database (settings are one small JSON file),
logging frameworks (print only what helps the user, add `-v` for verbose).

### 3.2 Windows toolchain note

The reference setup used `stable-x86_64-pc-windows-gnu`. If the installed MinGW lacks `libgcc_eh`,
add a `.cargo/config.toml` with `rustflags = ["-C", "link-self-contained=yes"]` for that target.
Keep it, and note in CLAUDE.md why it exists so nobody removes it.

The release binary uses the GUI subsystem (`#![cfg_attr(all(windows, not(debug_assertions)),
windows_subsystem = "windows")]`) so no console window appears. A small `attach_console()` at startup
restores output when started from a terminal.

### 3.3 Frontend

- Plain HTML, CSS and JavaScript. No framework, no bundler, no npm, no TypeScript, no CDN.
- One page (a single-page app) with a few "pages" shown and hidden, plus one reusable bottom sheet.
- Installable as a PWA (manifest, icons, service worker).
- Theme: Catppuccin, with the full palette and role rules in Part 7.4.
- Icons: Lucide (ISC license) as an inline SVG sprite, generated once by a script and committed.

### 3.4 Tooling

- `cargo test` for all Rust tests.
- `node --check assets/ui/app.js` to syntax-check the script (Node is used only for this).
- Python only for small helper scripts (`tools/`): icon sprite generation, app icon generation
  (Pillow). Scripts are committed, outputs are committed, so normal builds need no network.
- A browser (Chrome) driven by the agent for visual checks, with a mock connection (Part 8).

---

## Part 4. Repository layout

```
<app>/
  Cargo.toml
  Cargo.lock
  build.rs                    assembles assets/ui/* into one index.html in $OUT_DIR
  .cargo/config.toml          toolchain flags, with a comment saying why
  README.md                   user-facing: what, how to run, protocol, security, roadmap
  DESIGN.md                   decisions, architecture, milestones
  CLAUDE.md                   instructions for the AI agent (template in Part 14)
  THIRD_PARTY.md              licenses of bundled assets (icons, palette)
  assets/
    sw.js                     service worker
    icon-180.png icon-192.png icon-512.png    PWA icons
    ui/
      head.html               meta tags + tiny early theme script
      palette.css             Catppuccin variables (copied from the palette skill)
      app.css                 tokens, layout, components, motion
      icons.html              generated SVG sprite (Lucide)
      body.html               markup
      app.js                  all behavior
  src/
    main.rs                   CLI flags, settings, runtime thread, tray on the main thread
    lib.rs                    module list (so tests can use the crate)
    command.rs                message enum, platform trait, dispatcher (platform independent)
    web.rs                    axum routes, socket loop, admin page, manifest
    settings.rs               small JSON settings file
    <platform modules>.rs     input.rs, media.rs, winapps.rs, ... (platform specific)
    shell.rs                  tray icon, console attach, error box
    image.rs                  validation and conversion helpers (if the app handles images)
  tests/
    ws.rs                     end-to-end tests: real server, mock platform layer
  tools/
    fetch_lucide.py           regenerates assets/ui/icons.html
    gen_icons.py              regenerates PWA and tray icons
  docs/
    PLAYBOOK.md               this file
    screenshots/              screenshots made with mock data only
```

Rules:

- Edit the parts in `assets/ui/`. Never edit generated output.
- Anything platform specific lives in its own module behind `#[cfg(windows)]`, with a logging stub
  for other platforms so the crate still compiles and tests run anywhere.
- `command.rs` contains no OS calls. It is pure logic and fully unit-tested.

---

## Part 5. Architecture patterns

### 5.1 One typed message enum

All client requests are one `serde` enum tagged by a short field `t`:

```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Msg {
    Move { dx: i32, dy: i32 },
    Text { v: String },
    #[serde(rename = "clip.get")] ClipGet,
    #[serde(rename = "clip.set")] ClipSet { text: String },
    Ping,
    // one variant per feature
}
```

Replies are small JSON objects with a `t` field (`{"t":"clip","text":"..."}`). Document every
message in a table in the README.

Naming: short lowercase names, dot for namespaces (`clip.get`, `win.list`, `media.get`).
Requests that need an answer get an answer with a matching reply type. Requests that are fire and
forget get no reply.

### 5.2 Platform trait with no-op defaults

```rust
pub trait Injector: Send + Sync {
    fn move_rel(&self, dx: i32, dy: i32);
    // ...required core methods...
    fn clip_get(&self) -> Option<String> { None }          // optional features default to "nothing"
    fn media(&self) -> Option<MediaInfo> { None }
}
```

- Required methods for the core of the app, default methods (returning `None`, `false`, empty) for
  everything optional. A new platform backend then compiles with only the core implemented.
- The Windows implementation lives in its own module. A logging stub implements the trait on other
  platforms.

### 5.3 Dispatcher

`Dispatcher<I: Injector>` owns the backend, validates and clamps every input, calls the trait, and
returns an optional reply:

```rust
pub fn handle(&self, msg: &Msg) -> Option<serde_json::Value> { ... }
```

All validation lives here, not in the platform layer and not in the web layer. It is unit-tested with
a recording mock (a struct that pushes strings like `"move 4 -1"` into a vector).

### 5.4 Web layer

- One `AppState<I>` holding the dispatcher, host name and a verbose flag.
- Routes: `/` (the page), `/ws` (the socket), `/admin` (loopback only), `/manifest.webmanifest`,
  `/sw.js`, icons, and any small binary routes (for example `/media/art`, `/clip/image.png`).
- The socket loop: send a `hello` message (host name, version), then loop receiving text frames,
  parse into `Msg`, dispatch, send the optional reply. Ignore unparseable messages (log only with `-v`).
- Slow or blocking platform work (anything that talks to the OS and may take more than a few
  milliseconds) runs in `tokio::task::spawn_blocking`, not on async workers.
- Set a max WebSocket message size. Set body limits on upload routes.

### 5.5 Runtime and threads

- The tokio runtime runs on a worker thread.
- The main thread owns the tray icon and its Win32 message loop (required by the OS).
- Startup order: parse flags, load settings, bind the listener (fail with a clear message box if the
  port is taken), print the addresses, spawn the server thread, run the tray loop.

### 5.5.1 CLI flags

Keep flags few: `--port`, `--hostname`, `--no-tray`, `-v/--verbose`, `-h/--help`. Settings that
change are saved to the settings file. Unknown flags exit with the usage text.

### 5.6 Settings

One tiny JSON file under the user's config dir (`%APPDATA%\<app>\settings.json`). Every field has a
serde default so old files keep loading and unknown old fields are ignored. Create it on first run.

### 5.7 Platform layer rules

- Every `unsafe` block has a `// SAFETY:` comment saying why it is sound.
- Windows calls that need COM or serialization (shell, icon extraction) run on one serialized path and
  initialize COM per call or per thread. Do not cache failures.
- Anything that can be briefly locked by another program (the clipboard) goes through a helper that
  retries a few times with short sleeps before giving up.
- Hand out opaque ids (random 16 hex characters) for things the client may refer to (windows, apps,
  icons). The client never sends paths or handles it chose.
- Window titles, app names, and any text from the OS are untrusted. Send them as data, render as text.

---

## Part 6. Security rules

The app controls a real machine, so these are not optional.

1. **Never trust client input.** Validate, clamp and bound everything: movement size, scroll size,
   text length, message size, upload size, image dimensions.
2. **Ids, not paths.** Clients refer to server-issued ids only.
3. **URLs**: accept only `http` and `https`, no whitespace, passed to the OS opener as one argument
   (never through a shell).
4. **Admin page**: answer only loopback connections and also check the `Host` header is loopback
   (defends against DNS rebinding). Do not widen it.
5. **Uploads**: accept only the exact content type you expect (for example `image/png`). A
   non-simple content type cannot be sent cross-site without a CORS preflight, which the server never
   grants. Check signature and dimensions before decoding. Enforce byte limits, dimension limits and
   a pixel-count limit.
6. **Untrusted text**: render with `textContent`, never `innerHTML`.
7. **Be honest in the docs.** State plainly what is and is not protected. If there is no
   authentication yet, say so in the README security section and the admin page, and say who can
   control the machine.
8. **Authentication is designed, not bolted on.** Do not add quick token schemes. If it is not
   ready, leave it out and put it on the roadmap (Part 10 has the lesson learned).
9. **Known gap to plan for:** with no authentication, any web page open in a browser on the same
   network can try to open the WebSocket. Checking the `Origin` header against the served page's own
   origin closes this cheaply. Do it early.
10. **No telemetry, no phoning home, no external requests** from the app or its UI.

---

## Part 7. Frontend rules

### 7.1 Structure

- The page is assembled at build time from `assets/ui/*` by `build.rs` into
  `$OUT_DIR/index.html`, embedded in the binary with `include_str!`.
- Skeleton produced by `build.rs`:

```html
<!doctype html>
<html lang="en">
<head>{head}<style>{palette}{css}</style></head>
<body>{icons}{body}<script>{js}</script></body>
</html>
```

`build.rs` reads each file, replaces placeholders, writes the output, and prints
`cargo:rerun-if-changed=assets/ui/<file>` for each input. A test asserts the page contains required
markers and no unreplaced placeholder (`{head}`, `{css}`).

### 7.2 Layout and navigation

- Mobile first, portrait first, and a landscape layout (side rail) for small heights.
- Top bar: connection status chip (dot + host name + "Connected 12 ms"), help button.
- Bottom navigation with labeled icons (4 pages plus "More"). A sliding indicator under the active
  item. Labels are always visible (icon-only tabs were judged unintuitive).
- A reusable bottom sheet for secondary things (More, Clipboard, Power, Settings, Browser). Back
  button, close button, drag handle, scrim, drag to dismiss.
- Pages crossfade with a small slide. First-run hints are a dismissible card, stored once.
- Touch targets at least 44 px. Respect safe-area insets (`env(safe-area-inset-*)`).

### 7.3 Components and tokens

- CSS variables for spacing (4/8/12/16/24), radii (12/18/24), shadows, durations and easing.
- Press feedback (scale about .96) on every control. Buttons: primary (accent), ghost (card).
- Segmented control with a sliding thumb, toggle switches, sliders with value labels, chips, cards.
- Toasts for transient confirmations (connected, copied, launched).
- Skeleton shimmer while lists load. Empty and error states with an icon and one sentence.

### 7.4 Theming (Catppuccin)

Use the real palette (v1.8.0). Never invent hex values. Flavors: Latte (light), Frappe, Macchiato,
Mocha (dark, getting darker). Default: follow the OS (Latte in light mode, Mocha in dark mode), with
the user able to choose any flavor in Settings.

Palette values:

| Color | Latte | Frappe | Macchiato | Mocha |
|---|---|---|---|---|
| `rosewater` | `#dc8a78` | `#f2d5cf` | `#f4dbd6` | `#f5e0dc` |
| `flamingo` | `#dd7878` | `#eebebe` | `#f0c6c6` | `#f2cdcd` |
| `pink` | `#ea76cb` | `#f4b8e4` | `#f5bde6` | `#f5c2e7` |
| `mauve` | `#8839ef` | `#ca9ee6` | `#c6a0f6` | `#cba6f7` |
| `red` | `#d20f39` | `#e78284` | `#ed8796` | `#f38ba8` |
| `maroon` | `#e64553` | `#ea999c` | `#ee99a0` | `#eba0ac` |
| `peach` | `#fe640b` | `#ef9f76` | `#f5a97f` | `#fab387` |
| `yellow` | `#df8e1d` | `#e5c890` | `#eed49f` | `#f9e2af` |
| `green` | `#40a02b` | `#a6d189` | `#a6da95` | `#a6e3a1` |
| `teal` | `#179299` | `#81c8be` | `#8bd5ca` | `#94e2d5` |
| `sky` | `#04a5e5` | `#99d1db` | `#91d7e3` | `#89dceb` |
| `sapphire` | `#209fb5` | `#85c1dc` | `#7dc4e4` | `#74c7ec` |
| `blue` | `#1e66f5` | `#8caaee` | `#8aadf4` | `#89b4fa` |
| `lavender` | `#7287fd` | `#babbf1` | `#b7bdf8` | `#b4befe` |
| `text` | `#4c4f69` | `#c6d0f5` | `#cad3f5` | `#cdd6f4` |
| `subtext1` | `#5c5f77` | `#b5bfe2` | `#b8c0e0` | `#bac2de` |
| `subtext0` | `#6c6f85` | `#a5adce` | `#a5adcb` | `#a6adc8` |
| `overlay2` | `#7c7f93` | `#949cbb` | `#939ab7` | `#9399b2` |
| `overlay1` | `#8c8fa1` | `#838ba7` | `#8087a2` | `#7f849c` |
| `overlay0` | `#9ca0b0` | `#737994` | `#6e738d` | `#6c7086` |
| `surface2` | `#acb0be` | `#626880` | `#5b6078` | `#585b70` |
| `surface1` | `#bcc0cc` | `#51576d` | `#494d64` | `#45475a` |
| `surface0` | `#ccd0da` | `#414559` | `#363a4f` | `#313244` |
| `base` | `#eff1f5` | `#303446` | `#24273a` | `#1e1e2e` |
| `mantle` | `#e6e9ef` | `#292c3c` | `#1e2030` | `#181825` |
| `crust` | `#dce0e8` | `#232634` | `#181926` | `#11111b` |

Implementation:

1. `palette.css` defines `--ctp-<color>` for every color in four classes: `.latte`, `.frappe`,
   `.macchiato`, `.mocha`. The flavor class goes on `<html>`. Latte sets `color-scheme: light`, the
   others `color-scheme: dark`.
2. `head.html` has a tiny script that runs before first paint: read the saved flavor (or follow the
   OS) and set the class on `<html>`, so there is no flash. Set `<meta name="theme-color">` to the
   flavor's `base`.
3. `app.css` maps the app's own tokens onto the palette, once:

```css
:root {
  --bg: var(--ctp-base);          --surface: var(--ctp-mantle);
  --card: var(--ctp-surface0);    --card-hi: var(--ctp-surface1);
  --line: var(--ctp-surface1);    --kt: var(--ctp-text);
  --dim: var(--ctp-subtext0);     --icon: var(--ctp-overlay1);
  --ac: var(--ctp-blue);          --on-ac: var(--ctp-base);
  --danger: var(--ctp-red);       --ok: var(--ctp-green);       --warn: var(--ctp-yellow);
}
html[data-accent=mauve] { --ac: var(--ctp-mauve); }   /* accent chips: blue, mauve, pink, peach, green, teal */
```

Role rules:

- Surfaces from deepest to most raised: `crust`, `mantle`, `base`, `surface0/1/2`, `overlay0/1/2`.
  Page background `base`. Sunken panels (sidebars, popups, nav bar) `mantle`. Raised cards
  `surface0`, hover/pressed `surface1`.
- Text: `text` for body and headings, `subtext1/0` for secondary and captions. Never use `subtext0`
  or `overlay*` for body text.
- Text on a solid accent background (buttons, badges, the active nav pill) is `base`, not `text`.
- Accents: `blue` primary, links, focus, active item. `lavender` secondary accent. `green` success,
  `yellow` warning, `red` error or danger, `peach` attention, `mauve` important, `teal/sky/sapphire`
  info.
- Selection and subtle tints: accent mixed with transparent via `color-mix(in srgb, var(--ac) 18%, transparent)`.
- Charts (if any) use, in order: blue, green, peach, mauve, teal, red, yellow, pink. Gridlines
  `surface0/1`, axis labels `subtext0`.
- Check contrast on both Latte and Mocha before finishing.

### 7.5 Icons

- Lucide icons as an inline SVG sprite: `<symbol id="i-name" viewBox="0 0 24 24">`, used with
  `<svg class="i"><use href="#i-name"/></svg>`.
- `tools/fetch_lucide.py` holds a dictionary `symbol id -> Lucide name`, downloads each SVG from the
  Lucide repo, strips the outer `<svg>`, and writes `assets/ui/icons.html`. The output is committed.
  To add an icon: add one line to the dictionary, run the script.
- One stroke width (1.75), 24 px grid, `currentColor`.
- Add the Lucide ISC notice to `THIRD_PARTY.md`. Add the Catppuccin MIT notice too.
- Note: a global icon color rule can override a button's color. Set icon color explicitly on
  components (a solid accent button needs `color: var(--on-ac)` on its `svg.i`).

### 7.6 Motion

- Animate only `transform` and `opacity`. Durations 120-320 ms. Spring-like easing for sheets and
  indicators, plain ease for fades.
- Effects used: press scale, sliding nav indicator, page crossfade with 8-28 px slide, sheet slide
  with scrim fade, segmented thumb slide, toggle knob, staggered list entrance (first render only),
  skeleton shimmer, pulsing "connecting" dot, toast in and out.
- A `prefers-reduced-motion: reduce` block that sets durations to near zero. Keep it working.
- Keep `backdrop-filter` to one or two elements at most (it is costly on old phones).

### 7.7 Behavior rules in `app.js`

- One IIFE, no globals. Helpers `$`, `$$`, a small `store` wrapper for `localStorage` (always in
  try/catch, keys prefixed with a short app prefix, for example `<app>_`).
- WebSocket: connect to the page's own origin, reconnect with backoff (max 3 s), a status state
  machine (`wait`, `on`, `off`), ping for latency, toasts for lost and restored connection. Warn once
  if the very first connection fails ("Can't reach the PC. Is it running, on the same Wi-Fi?").
- Batch high-rate input (pointer moves) and flush on an interval or animation frame.
- Hold-to-repeat helper for buttons like volume and backspace.
- Act on release for tap targets inside scrollable areas, so scrolling never fires actions.
- Destructive actions need two taps ("Tap again to close"), with the armed state visible and timing out.
- Polling only while a page is visible (for example, now-playing every 2 s only on the media page),
  with local interpolation between polls (a progress bar advancing locally).
- Request lists lazily (when a page is opened), show skeletons, then content.
- Class names must not collide. Before adding a component class, search the stylesheet for the name.
  (A reused `.mbtn` class once turned the main click buttons into circles.)
- CSS ordering matters: a later rule with the same specificity wins. Put overrides after the base rule.
- Keep a single script syntax check in the loop: `node --check assets/ui/app.js`.

### 7.8 PWA

- `/manifest.webmanifest`: `id`, `name`, `short_name`, `description`, `start_url: "/"`, `scope`,
  `display: standalone`, `orientation: any`, `background_color` and `theme_color` set to Mocha base,
  icons 192 and 512 (`any maskable`).
- `/sw.js`: install caches `/` and one icon; activate deletes old caches and claims clients;
  fetch is network first with the cache as a fallback only for `/` and icons; never cache `/ws`,
  `/admin` or the manifest. The service worker only registers in secure contexts, so plain-HTTP LAN
  pages skip it.
- Bump the cache name in `sw.js` after every UI change (a simple counter, `shell-v12`).
- Install help text per platform in Settings (Share > Add to Home Screen on iOS; install button on
  Android over HTTPS; note that full install over plain HTTP is limited).
- iOS notes: `viewport-fit=cover`, `apple-mobile-web-app-capable`, status bar style
  `black-translucent`. iOS betas can report a viewport shorter than the screen in installed apps and
  paint a strip at the bottom; that was an OS issue. A Diagnostics overlay (viewport sizes and safe
  insets) is a good way to gather evidence, but remove it once the investigation is over. Do not
  stack speculative layout hacks. Do not toggle the viewport meta at runtime.

### 7.9 Writing UI text

- Short, plain, concrete. "Send to PC", "Get what the PC copied", "Nothing playing".
- Status lines say what happened: "Sent. The text is on the PC clipboard." / "The PC clipboard is
  empty." / "Not connected to the PC."
- Never blame the user. Give one next step.

---

## Part 8. Testing rules

### 8.1 Layers

1. **Unit tests** in the platform-independent code: message parsing, validation and clamping, key
   name table, URL checks, image validation, settings parsing, small pure helpers (for example
   "tidy an app id into a display name").
2. **End-to-end tests** in `tests/ws.rs`: start the real server on an ephemeral port
   (`TcpListener::bind("127.0.0.1:0")`), connect with `tokio-tungstenite` and a raw TCP client, use a
   mock platform backend that records calls, and assert on replies and recorded calls.
3. **Page checks**: the served `/` contains required markers (key ids, `Lucide`,
   `prefers-reduced-motion`, a few message names) and no unreplaced build placeholders.
4. **Syntax check**: `node --check` on the script.
5. **Real run**: build release, restart the server, drive the real page in a browser.

### 8.2 What each feature needs

- Message enum variant, dispatcher branch, trait method with a default, mock implementation, tests for
  success and for failure or invalid input, a protocol table row in the README.
- HTTP routes: test the happy path, the wrong content type, garbage bodies, oversized bodies.
- Security rules get a test each (admin rejects a foreign Host header, uploads reject bad input).

### 8.3 Rules for testing on the real machine

- **Never trigger real power actions, closing, launching, or clipboard writes** on the user's
  machine. Use the mock backend, a `WebSocket.prototype.send` spy in the page, or read-only calls.
- If a real clipboard test is truly needed: only proceed when the clipboard holds plain text, back it
  up first, restore it in a `finally`, and verify the restore. Delete any scratch files.
- Screenshots for docs use a mock connection with fictional titles and a fictional host name
  (`Desktop-PC`). Never capture real window titles, email subjects, hostnames, app lists or any
  personal data.
- A phone-sized browser check: an iframe of 390x844 created from a blob URL keeps the real origin.
  Use both a dark and the light flavor.
- Keep browser checks short. One screenshot of the finished state beats a long click-through.

### 8.4 Flaky tests

If a test fails only sometimes, find out why before changing it. Example: when a server rejects a
huge upload early and closes the connection, the OS can reset the connection and drop the reply. The
fix was to read the reply while still writing, and to accept either "413" or "connection closed with
no reply" for that one case, while still asserting that nothing reached the platform layer. Run the
suite many times (a loop of 10 to 15 full runs) after fixing.

---

## Part 9. The build order (the exact sequence that worked)

Do these in order. Each phase ends with tests green and a short summary to the user. Do not skip the
planning step.

### Phase 0. Decisions and plan

- Read the request. Explore any existing code or files. Write a plan (context, approach, files,
  order, verification, risks).
- Settle the open decisions with a few concrete questions (target OS, UI direction, which extras).
  Typical ones: navigation style (labeled bottom bar plus a More sheet), icon set (Lucide), motion level
  (subtle and fast), theme (Catppuccin).
- Name the project. Pick a neutral, descriptive name. Do not reuse the name of anything it resembles.

### Phase 1. Core server and protocol

- `cargo new`, add the dependencies in Part 3.
- `command.rs`: `Msg` enum with the core messages, `Injector` trait with the core methods, the
  `Dispatcher` with validation and clamping, key-name table if the app types keys.
- `web.rs`: router with `/` and `/ws`, hello message, socket loop, max message size.
- `main.rs`: flags, settings, listener, print the LAN addresses.
- Mock injector and the first end-to-end tests. Unit tests for validation.
- Result: a server a test client can drive.

### Phase 2. Platform backend

- Implement the Windows `Injector` (input injection, power, URL opening) in `input.rs`.
- Non-Windows stub that logs.
- Safety review of every `unsafe` block.

### Phase 3. First frontend (minimal but real)

- A single page that connects, shows status, and exercises the core features.
- This is only a baseline. The real UI comes in Phase 6.

### Phase 4. Desktop shell

- Tray icon and menu (Show phone link, Quit), the Win32 message loop on the main thread, the server
  on a worker thread, console attach, an error message box for startup failures (port in use),
  GUI subsystem in release.
- Loopback-only admin page listing the addresses to open on the phone.
- PWA basics: manifest, icons (generated by `tools/gen_icons.py`), service worker.

### Phase 5. Docs and repo setup (early, not at the end)

- README, DESIGN, CLAUDE.md, THIRD_PARTY.md, `.gitignore` (target, editor files).
- `git init`, first commit when the user asks. Add the remote and push only when the user asks.
- Keep local-only ignore rules (anything private) in `.git/info/exclude`, never in `.gitignore`.

### Phase 6. Frontend rebuild (the design pass)

Do this as its own planned phase:

1. **Split** the single file into `assets/ui/*` parts, assembled by `build.rs`. Add the test for the
   assembled page.
2. **Icons**: write `tools/fetch_lucide.py`, generate the sprite, add THIRD_PARTY.
3. **Tokens and motion**: spacing, radii, shadows, durations, easing, reduced-motion block.
4. **Shell**: top bar with status chip, labeled bottom nav with sliding indicator, page container
   with transitions, the bottom sheet component, toast.
5. **Pages**, one at a time: main interaction page (touchpad or equivalent), typing page, lists page,
   media page, then the More sheet and its subpages, then Settings.
6. **Polish**: landscape layout, empty and loading states, haptics (`navigator.vibrate`) with a
   Settings toggle, first-run hint card.
7. Update the service worker cache name, the README and the tests.

### Phase 7. OS integration features, one at a time

For each feature (window switcher, app launcher with icons, clipboard text and images,
now-playing media):

1. Add the message(s) and reply to `Msg` and the dispatcher.
2. Add the trait method with a default, then the Windows implementation in its own module.
3. Extend the mocks, write the end-to-end test.
4. Add the UI in the right page or sheet.
5. Verify with the real server (read-only where possible), then a short browser check.
6. Update the protocol table, security notes and roadmap in the README, the row in DESIGN, the code
   map in CLAUDE.md.

Details worth copying:

- **Window list**: enumerate top-level windows filtered like the taskbar (visible, unowned, not
  cloaked, not a tool window). Report `minimized` and `maximized`, so one button can toggle
  maximize and restore. Refresh the list shortly after each action (about 450 ms).
- **App launcher**: scan Start Menu shortcuts, dedupe, hand out opaque ids, extract icons to PNG on
  demand (serialized, COM initialized), cache successes only, serve at `/icon/<key>.png`.
- **Clipboard**: text through `arboard`. Images over HTTP as PNG (`POST /clip/image` with
  `Content-Type: image/png`, `GET /clip/image.png`), validated before decoding, with the phone
  converting any photo to a downscaled PNG first. Replies include an `ok` flag so the UI reports real
  results.
- **Now playing**: read the system media session through the WinRT API (title, artist, app, state,
  position, duration, cover). Expose it as one `media.get` request plus a cover route. The page polls
  every 2 seconds only while the page is visible and interpolates progress locally. The play button
  icon switches between play and pause based on the reported state.

### Phase 8. Screenshots and docs

- Make screenshots only with the mock connection and fictional data. Store in `docs/screenshots/`.
- README: what it is, features, screenshots, quick start, options table, install-as-app notes, the
  architecture diagram, protocol, HTTP routes, security, development, roadmap with checkboxes.
- DESIGN: numbered decision table, architecture, security model, crates, milestones.

### Phase 9. Simplify

After the features exist, review each screen with the three-second test. Merge or remove controls.
Examples that were done: one clipboard sheet instead of tabs; one page per computer instead of a
computer-switcher; a media page of three cards (now playing with transport, volume, fullscreen) with
the presentation card removed. Remove dead code, dead CSS, unused icons and unused dependencies when
a feature goes away.

### Phase 10. Hardening and release readiness (next)

- Origin check on the WebSocket.
- Start at login (per-user registry entry, no admin rights, tray toggle).
- Pairing and sign-in designed properly.
- HTTPS with a self-signed certificate (unlocks the full Android install and sensors).
- Installer and update check.

---

## Part 10. Lessons learned and pitfalls

### 10.1 Process

- **Authentication built in a hurry was thrown away.** A token in a QR link looked fine but was not
  good enough. It was removed completely and the README now says there is no pairing yet. Design
  pairing as its own project: how a device is authorized, how it is revoked, what is shown on the
  PC, rate limits.
- **Multi-device support was cut for now** because it adds UI and state before it is needed. The page
  connects back to the machine that served it. It is on the roadmap.
- **A "complete" UI can still be too complex.** When told "too complex", the right response is fewer
  controls with the same functions, not different styling.
- **Check names before adding CSS classes.** One class name collision broke the main interaction
  buttons after an unrelated redesign.
- **When editing by script, verify the edit.** A script that cut a CSS block left a stray closing
  brace, which silently dropped every rule after it and made the whole UI look broken. After any
  scripted edit: re-read the diff, run the page checks, load the page.
- **A stale copy can overwrite a newer edit.** Keep edits small and re-read the file before
  re-applying a change. Tests that assert specific routing code exists caught this once.
- **Do not claim a fix you could not test.** Say "I could not test this on a real device".
- **Hard OS bugs on betas**: gather evidence with a diagnostic overlay, try the documented fix once,
  and stop. Remove the overlay when done.

### 10.2 Tooling gotchas (Windows)

- Some files are CRLF (for example `Cargo.toml`, many sources). Match the file's line endings when
  editing programmatically (read, normalize to LF, edit, write back with the original style).
- Inline backslash escapes in shell or Python one-liners get mangled. Put non-trivial scripts in
  files and run them. Use the edit tool for small changes.
- A stray NUL byte once got into a Rust test string. Keep escapes explicit (`\u{0}`).
- Redirecting cargo's stderr in PowerShell prints a harmless `NativeCommandError`. Read the real output.
- Stop the running `<app>.exe` before rebuilding release (the file is locked). Restart it detached
  afterwards.
- A `PATH` entry for the cargo bin directory may be needed in each fresh shell.
- A command named like an alias (for example `R` in PowerShell) can resolve to the wrong thing.
  Name helper functions clearly.

### 10.3 Behavior gotchas

- iOS cannot read the phone clipboard programmatically over plain HTTP. Use the paste action in the
  text box (which also catches pasted images) and the photo picker. Writing to the phone clipboard
  must happen inside the tap handler, not after a network reply, and the modern API can stall, so
  time-box it (about 1.5 s) and fall back to `execCommand('copy')`.
- Plain HTTP means the service worker and full PWA install are limited. Document it.
- Poll only while visible. Interpolate between polls.
- A COM or WinRT call on a tokio worker needs the thread initialized first.
- The OS reports "no session" for a missing media session as an error with a success code. Treat any
  failure in the chain as "nothing playing".

---

## Part 11. Documentation rules

### 11.1 README.md (for users)

Sections in order: one-line description, features (grouped), screenshots, quick start (numbered),
options table, install-as-app notes, architecture diagram (ASCII), module table, protocol (messages
table with request and reply examples), HTTP routes, security (honest), development commands,
roadmap (checkboxes grouped Next / Planned / Not planned).

Rules: keep it in sync with behavior in the same change that alters behavior. The protocol table and
roadmap are the parts that drift most; update them with every feature.

### 11.2 DESIGN.md (for maintainers)

A numbered decision table (decision, choice, reason), architecture sketch, security model, crates
list, milestones. When a decision is reversed, keep the row and mark it "removed, to be redesigned"
with the reason.

### 11.3 CLAUDE.md (for the agent)

Short and operational (template in Part 14): commands, code map, how to add a feature, rules that
matter, frontend conventions, testing rules, repo hygiene, editing gotchas.

### 11.4 THIRD_PARTY.md

Name each bundled third-party asset, its license, and where it is used.

### 11.5 Writing style

- Plain hyphen only. Short sentences. Concrete verbs. No marketing words, no filler.
- Do not describe the project in terms of other products. Describe it as its own idea.

---

## Part 12. Repo hygiene and privacy

- **Never reference other products** the project resembles: not in code, UI text, docs, screenshots,
  commit messages or file names. Describe the idea in general terms.
- **Reference material the user supplies** (screenshots of other apps, install files, notes) stays
  out of the repository. Exclude it locally through `.git/info/exclude`. Never name that folder in any
  tracked file. Never copy its contents into the project.
- **No personal data** in tracked files: no real window titles, email subjects, host names, app lists,
  paths under the user's profile, addresses, or tokens. Screenshots and tests use fictional data.
- **Local-only ignore rules** go in `.git/info/exclude`. `.gitignore` only has generic entries.
- **History check before the first push**: scan old commits for anything private (for example a
  header line naming a private repository). If history contains something, tell the user and let them
  choose (push as is, or rewrite).
- Keep third-party licenses in order.

---

## Part 13. Git rules

- Branch `main`. One remote `origin`.
- Commit and push only when asked. When asked to commit: review `git status` and the diff, group the
  change sensibly, write a clear message.
- Message style: short imperative subject (for example "Added Clipboard", "Removed unused auth
  code"), optional body that says why. Plain hyphens only.
- Add the attribution trailer the agent's environment requires, as the last lines of the message.
- Never skip hooks, never force-push unless explicitly told, never rewrite published history without
  an explicit request.
- Do not commit generated build output (`target/`), private reference material, or scratch files.
- Do not leave debugging scaffolding in commits (diagnostic overlays, probe examples). Delete
  temporary files created for experiments (for example an `examples/` probe).

---

## Part 14. Templates

### 14.1 CLAUDE.md template

```markdown
# CLAUDE.md

Guidance for working on this repository.

## What this is

<App>: <one sentence>. Read README.md for features, architecture and protocol; DESIGN.md for decisions
and the roadmap.

## Commands

(PowerShell)
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test                        # unit + end-to-end tests (keep green)
cargo build --release             # stop a running <app>.exe first
node --check assets/ui/app.js     # syntax check of the web app script
python tools/fetch_lucide.py      # regenerate assets/ui/icons.html (network)
python tools/gen_icons.py         # regenerate app icons (Pillow)
Get-Process <app> | Stop-Process -Force
Start-Process .\target\release\<app>.exe    # detached; release build has no console window

- Toolchain and flags: <note about the target and .cargo/config.toml>.
- Default port <N>. Settings: %APPDATA%\<app>\settings.json.

## Code map

- src/command.rs: Msg enum, Injector trait (no-op defaults), Dispatcher (validation, replies). No OS calls.
- src/web.rs: routes, socket loop, admin page (loopback only), manifest.
- src/<platform>.rs: Windows backend modules.
- src/shell.rs: tray, console attach, error box.
- src/main.rs: flags, settings, runtime thread.
- build.rs: assembles assets/ui/* into $OUT_DIR/index.html.
- tests/ws.rs: real server + mock backend.

## Adding a feature

1. Variant in Msg, branch in Dispatcher::handle (return Some(json) for replies).
2. Default method in Injector, Windows implementation in its module.
3. Extend the mocks (command.rs testing Rec, tests/ws.rs Handle), add tests.
4. UI in assets/ui/, protocol table in README.md, row in DESIGN.md.

## Rules that matter

- Never trust client input: validate and clamp. Clients use server-issued ids, never paths.
- Titles and OS text are untrusted: textContent, never innerHTML.
- Every unsafe block has a SAFETY comment. Serialize and COM-initialize shell/icon calls. Do not cache failures.
- Admin page is loopback-only and checks Host. Do not widen it.
- <current auth status in one line>.

## Frontend conventions

- One self-contained page, no CDN. Edit the parts, not generated output.
- Colors are Catppuccin roles (--ctp-*), mapped once in app.css. Text on solid accent uses base. No invented hex.
- Icons are Lucide symbols listed in tools/fetch_lucide.py.
- Motion: only transform and opacity, 120-320 ms, keep the reduced-motion block.
- Storage keys use the <app>_ prefix. Bump the cache name in assets/sw.js after UI changes.
- Touch targets at least 44 px, respect safe-area insets.
- Search the stylesheet before adding a class name (collisions break unrelated screens).

## Testing a UI change

cargo test, node --check, rebuild release, restart, check in a browser at phone size in a dark and the
light flavor. Drive the page with synthetic events and a WebSocket send spy. Never trigger power,
close, launch or clipboard writes on the user's machine. Keep browser checks short.

## Repo hygiene

- Do not mention other products this resembles.
- No real titles, emails, hostnames or app lists in screenshots, docs or tests.
- Local-only ignore rules go in .git/info/exclude.
- Commit only when asked. Keep README.md in sync with behavior.
- Prose and commit messages use the plain hyphen.

## Editing gotchas

- Some files are CRLF: match them when editing programmatically.
- Backslash escapes in inline snippets get mangled: use script files or the edit tool.
- Keep NUL out of strings (\u{0}).
```

### 14.2 build.rs sketch

```rust
use std::{env, fs, path::Path};

fn main() {
    let ui = Path::new("assets/ui");
    let read = |f: &str| {
        println!("cargo:rerun-if-changed=assets/ui/{f}");
        fs::read_to_string(ui.join(f)).unwrap_or_else(|e| panic!("cannot read {f}: {e}"))
    };
    let page = "<!doctype html>\n<html lang=\"en\">\n<head>{head}<style>{css}</style></head>\n<body>{icons}{body}<script>{js}</script></body>\n</html>\n"
        .replace("{head}", &read("head.html"))
        .replace("{css}", &format!("{}{}", read("palette.css"), read("app.css")))
        .replace("{icons}", &read("icons.html"))
        .replace("{body}", &read("body.html"))
        .replace("{js}", &read("app.js"));
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("index.html");
    fs::write(out, page).unwrap();
}
```

(Replace the placeholders one at a time and in an order that cannot re-introduce a placeholder from
inserted content, or build the string with `format!`.)

### 14.3 Message and reply pattern (README table row format)

```
{"t":"media.get"}   -> {"t":"media","state":"playing|paused|stopped|none","title":"..","artist":"..",
                        "app":"..","pos":s,"dur":s,"art":bool}
```

### 14.4 Service worker (network first)

```js
const CACHE = 'shell-v1';   // bump after UI changes
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon-192.png'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/ws' || url.pathname === '/admin' || url.pathname.startsWith('/manifest')) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.pathname === '/' || url.pathname.startsWith('/icon-'))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname === '/' ? '/' : req, copy)); }
    return res;
  }).catch(() => caches.match(url.pathname === '/' ? '/' : req, { ignoreSearch: true })));
});
```

### 14.5 End-to-end test skeleton

```rust
async fn start() -> (u16, Arc<Rec>) {
    let rec = Arc::new(Rec::default());
    let state = Arc::new(AppState { dispatcher: Dispatcher::new(Handle(rec.clone())), hostname: "TEST-PC".into(), verbose: true });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(web::serve(listener, state));
    (port, rec)
}
```

Use `tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))`, read the hello, send
messages, assert on replies and on what `rec` recorded. For HTTP, write a small raw TCP helper that
sends a request and reads to the end.

---

## Part 15. Definition of done (per change)

- [ ] `cargo test` is green (run the full suite more than once if a test was flaky).
- [ ] `node --check assets/ui/app.js` passes.
- [ ] No compiler warnings.
- [ ] New behavior has a unit or end-to-end test, including a failure or invalid input case.
- [ ] The release build was rebuilt and the server restarted from the new binary.
- [ ] The real page was loaded, there are no console errors, and the changed screen was looked at.
- [ ] No class name collisions, no stray braces, no dead CSS or JS left behind.
- [ ] Service worker cache name bumped if the UI changed.
- [ ] README (features, protocol, routes, security, roadmap), DESIGN and CLAUDE.md match the code.
- [ ] No personal data or references to other products in any tracked file.
- [ ] The summary to the user says what was verified and what was not (anything needing a real device).
- [ ] No commit or push unless the user asked.

---

## Part 16. Starter prompts

First message to the agent:

```
Build <App>: <what it does in 2-4 sentences>. Platform: <OS>.
Follow docs/PLAYBOOK.md. Start with Phase 0 (plan), then Phase 1 and so on in order.
Ask me only about decisions that block you; recommend a default for everything else.
Do not commit or push until I ask. Never trigger real power, close, launch or clipboard actions on my machine while testing.
```

Adding a feature:

```
Add <feature>. Follow Phase 7 of the playbook: message, trait method with default, platform
implementation, mocks and tests, UI, docs. Keep the UI to the simplest screen that works.
```

Redesigning a screen:

```
The <screen> is too complex. Keep every function but make it simple and intuitive: apply the
three-second test, prefer one clear primary action, and remove controls that are not needed.
```

Removing something:

```
Remove <feature> completely for now: code, UI, tests, docs, dependencies. Add a line to the README
roadmap saying it will come back in a better form.
```

Before finishing a long session:

```
Run the definition of done from the playbook and summarize: what changed, what was verified, what
was not, and what you suggest next.
```

---

## Part 17. Suggested roadmap after the first release

In this order:

1. Commit the current work.
2. Reject cross-site WebSocket connections (Origin check).
3. Start at login with a tray toggle.
4. Design and build pairing and sign-in (QR or short code, per-device access, revocation, rate
   limits), then bring back the phone link and QR code.
5. Settings page on the admin site (host name, connected devices).
6. Foreground-app push so the UI can adapt to the active program.
7. Window thumbnails, pinned and recent apps.
8. HTTPS with a self-signed certificate, then the full Android install and sensor features.
9. Input on elevated prompts and the lock screen (a small service plus a per-session helper).
10. Installer and update check. Macros. Other operating systems behind the same trait.

Things that stay out of scope: screen mirroring, file transfer, telemetry, accounts.
