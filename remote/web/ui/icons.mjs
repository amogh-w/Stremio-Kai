// Builds an SVG sprite of the Lucide icons an app uses.
//   node icons.mjs [--list icons.txt] [--out icons.svg]
// icons.txt: one Lucide icon name per line (# comments allowed). Unknown names fail the build.
// Needs the dev dependency "lucide-static". Use in markup: <svg class="size-5"><use href="/icons.svg#house"/></svg>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const list = resolve(arg("--list", "icons.txt"));
const out = resolve(arg("--out", "icons.svg"));

const require = createRequire(join(process.cwd(), "package.json"));
const iconsDir = join(dirname(require.resolve("lucide-static/package.json")), "icons");

const names = readFileSync(list, "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*/, "").trim())
  .filter(Boolean);

// Stroke width and fill are NOT set here: they inherit from the outer <svg> (see --icon-sw and the base
// "fill: none" rule in kit.css), because a presentation attribute inside the sprite cannot be overridden
// from outside. That is what lets a utility like `fill-current` turn an outline icon into a solid one.
const symbols = names.map((name) => {
  const svg = readFileSync(join(iconsDir, `${name}.svg`), "utf8");
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();
  return `<symbol id="${name}" viewBox="0 0 24 24"><g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${inner}</g></symbol>`;
});
writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>\n`);
console.log(`${out}: ${names.length} icons`);
