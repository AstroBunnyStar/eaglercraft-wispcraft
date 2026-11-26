/**
 * Builds the one-file client: play.html plus wispcraft.js plus both EPK payloads, with
 * nothing left to fetch from the folder it sits in.
 *
 *   node tools/build-single-file.mjs               # rebuild play.html from main's sources
 *   node tools/build-single-file.mjs --check       # exit 1 if play.html is not that build
 *   node tools/build-single-file.mjs --base HEAD   # build from another revision
 *   node tools/build-single-file.mjs --dir ..      # read the sources from a checkout instead
 *
 * Inputs default to the `main` revision, because on this branch the shipped play.html is the
 * *output*: reading it back as a template would wrap the page in itself. `main` stays the
 * multi-file build, so this stays reproducible after the .epk files are gone from here.
 *
 * What it does, all of it by exact marker so a moved page fails loudly instead of half-patching:
 *
 *   1. `<script src="./wispcraft.js">` becomes the same script inline (the bundle holds no
 *      `</script` sequence, which is asserted before the swap).
 *   2. the `inline sounds payload removed` comment becomes the real payload node, in the same
 *      `<script type="application/octet-stream" id="..." data-size="...">` shape the assets
 *      payload already uses.
 *   3. a small shim is added after the page's payload module: the client asks for both EPKs
 *      through XMLHttpRequest (not fetch), so the shim turns those two names into blob: URLs
 *      over the inline bytes and lets the browser do the transfer. The requested URL text never
 *      changes shape, so nothing else in the client has to know.
 *
 * Exit codes: 0 built (or --check matched), 1 --check found a missing/stale play.html, 2 an
 * input is unusable.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const WISP_TAG = '<script src="./wispcraft.js"></script>';
const SOUNDS_MARKER = "<!-- inline sounds payload removed: sounds.epk is served as a file -->";
/* End of the page's inline-payload module. The shim goes after that script element closes, never
   inside it: a <script> tag inside a script is just text, and the first </script> there ends the
   module early - which silently costs the whole file its inline-wasm fetch scheme. */
const SHIM_ANCHOR = '  ], { type: "text/javascript" }));\n})();\n</script>\n';
const ASSETS_NODE = '<script type="application/octet-stream" id="eag-inline-assets"';
const PAYLOAD_LINE = 262144;

const SHIM = `<script type="text/javascript">
/* Single-file build: assets.epk and sounds.epk are in this document as base64 payloads, so the
   folder next to it needs no .epk files at all. The client loads both through XMLHttpRequest, not
   fetch - that is why the payload module above cannot cover them - so this turns the two names it
   asks for into blob: URLs over the inline bytes. Everything else (status, Content-Length,
   progress events, responseType) is then the browser's own work, and the URL the client passes
   keeps its shape, so no other part of it has to know the files are gone. */
(function () {
  "use strict";
  var ids = { "assets.epk": "eag-inline-assets", "sounds.epk": "eag-inline-sounds" };
  var urls = Object.create(null);

  function decode(id) {
    var node = document.getElementById(id);
    if (!node) throw new Error("single-file payload missing: " + id);
    var size = Number(node.getAttribute("data-size")) || 0;
    var encoded = node.textContent;
    node.textContent = ""; /* drop the base64 before the bytes double it */
    node.remove();
    var out = new Uint8Array(size);
    var offset = 0;
    var start = 0;
    while (start < encoded.length) {
      while (start < encoded.length && encoded.charCodeAt(start) <= 32) ++start;
      if (start >= encoded.length) break;
      var end = encoded.indexOf("\\n", start);
      if (end < 0) end = encoded.length;
      while (end > start && encoded.charCodeAt(end - 1) <= 32) --end;
      var binary = atob(encoded.slice(start, end));
      for (var i = 0; i < binary.length; ++i) out[offset + i] = binary.charCodeAt(i);
      offset += binary.length;
      binary = "";
      start = end + 1;
    }
    encoded = "";
    if (offset !== size) throw new Error("single-file payload size mismatch: " + id + " (" + offset + " != " + size + ")");
    var blob = new Blob([out], { type: "application/octet-stream" });
    out = null;
    return URL.createObjectURL(blob);
  }

  window.__eaglerSingleFileURL = function (url) {
    var name = String(url).split("?")[0].split("#")[0].split("/").pop();
    if (!ids[name]) return null;
    if (!urls[name]) urls[name] = decode(ids[name]);
    return urls[name];
  };

  var XHR = window.XMLHttpRequest;
  if (!XHR || !XHR.prototype || !XHR.prototype.open) return;
  var open = XHR.prototype.open;
  XHR.prototype.open = function (method, url) {
    var inline = null;
    try { inline = window.__eaglerSingleFileURL(url); } catch (e) { inline = null; }
    var args = Array.prototype.slice.call(arguments);
    if (inline) args[1] = inline;
    return open.apply(this, args);
  };
})();
</script>
`;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: node tools/build-single-file.mjs [--out play.html] [--base main] [--dir <checkout>] [--check]",
  );
  process.exit(2);
}

const options = { out: path.join(ROOT, "play.html"), base: "main", dir: null, check: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; ++i) {
  const arg = argv[i];
  if (arg === "--check") options.check = true;
  else if (arg === "--out") options.out = path.resolve(ROOT, argv[++i] || usage("--out needs a path"));
  else if (arg === "--base") options.base = argv[++i] || usage("--base needs a revision");
  else if (arg === "--dir") options.dir = path.resolve(ROOT, argv[++i] || usage("--dir needs a path"));
  else usage(`unknown argument: ${arg}`);
}

const fail = (message) => {
  console.error(`[fail] ${message}`);
  process.exit(2);
};

function readSource(name) {
  if (options.dir) {
    const file = path.join(options.dir, name);
    if (!fs.existsSync(file)) fail(`${file} is missing`);
    return fs.readFileSync(file);
  }
  try {
    return execFileSync("git", ["show", `${options.base}:${name}`], {
      cwd: ROOT,
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return fail(`cannot read ${options.base}:${name} (run this inside the repository, or pass --dir)`);
  }
}

function count(haystack, needle) {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) ++n;
  return n;
}

function payloadNode(id, bytes) {
  const base64 = bytes.toString("base64");
  const lines = [];
  for (let i = 0; i < base64.length; i += PAYLOAD_LINE) lines.push(base64.slice(i, i + PAYLOAD_LINE));
  return `<script type="application/octet-stream" id="${id}" data-size="${bytes.length}">\n${lines.join("\n")}\n</script>`;
}

const page = readSource("play.html").toString("utf8");
const bundle = readSource("wispcraft.js").toString("utf8");
const sounds = readSource("sounds.epk");

if (count(page, WISP_TAG) !== 1) fail(`expected exactly one ${WISP_TAG} in ${options.base}:play.html`);
if (count(page, SOUNDS_MARKER) !== 1) fail(`expected exactly one sounds-payload marker in ${options.base}:play.html`);
if (count(page, SHIM_ANCHOR) !== 1) fail("expected exactly one payload-module tail to anchor the shim");
if (!page.includes(ASSETS_NODE)) fail("the source page carries no inline assets payload - is this the right build?");
if (/<\/script/i.test(bundle)) fail("wispcraft.js holds a </script sequence, so it cannot be inlined as-is");
if (count(bundle, "<!--") !== 0) fail("wispcraft.js holds an HTML comment opener, which ends an inline script early");

try {
  new vm.Script(bundle, { filename: "wispcraft.js" });
} catch (error) {
  fail(`wispcraft.js does not parse: ${error.message}`);
}

const shimBody = SHIM.replace(/^<script type="text\/javascript">\n/, "").replace(/<\/script>\n$/, "");
try {
  new vm.Script(shimBody, { filename: "single-file-shim.js" });
} catch (error) {
  fail(`the shim does not parse: ${error.message}`);
}

let out = page.replace(WISP_TAG, `<script type="text/javascript">\n${bundle}\n</script>`);
out = out.replace(SOUNDS_MARKER, payloadNode("eag-inline-sounds", sounds));
out = out.replace(SHIM_ANCHOR, SHIM_ANCHOR + SHIM);

/* Every inline classic script must still parse. This is the check that catches an insertion
   landing inside another script element: the module then dies at parse time and the page quietly
   starts fetching classes.wasm off the disk instead of decoding it from the document. */
{
  const blocks = out.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/g) || [];
  if (blocks.length < 2) fail(`expected the page's inline scripts, found ${blocks.length}`);
  for (const block of blocks) {
    const body = block.replace(/^<script type="text\/javascript">/, "").replace(/<\/script>$/, "");
    try {
      new vm.Script(body, { filename: "inline-script.js" });
    } catch (error) {
      fail(`an inline script in the built page does not parse: ${error.message}`);
    }
  }
}

if (out.includes(WISP_TAG)) fail("the bundle tag survived the swap");
if (count(out, 'id="eag-inline-sounds"') !== 1) fail("the sounds payload did not land exactly once");
if (!out.includes(`data-size="${sounds.length}"`)) fail("the sounds payload size does not match sounds.epk");
if (count(out, "window.__eaglerSingleFileURL = function") !== 1) fail("the shim did not land exactly once");
/* The client still asks for assets.epk and sounds.epk by name; the shim answers both. */
if (!out.includes('{ url: "assets.epk?v=') || !out.includes('{ url: "sounds.epk?v=')) {
  fail("the client no longer asks for assets.epk/sounds.epk, so the shim has nothing to answer");
}

const bytes = Buffer.from(out, "utf8");
const size = (n) => n.toLocaleString("en-US");

if (options.check) {
  let shipped = null;
  try {
    shipped = fs.readFileSync(options.out);
  } catch {
    console.log(`[miss] ${path.relative(ROOT, options.out)} does not exist`);
    process.exit(1);
  }
  if (shipped.equals(bytes)) {
    console.log(`[ok]   ${path.relative(ROOT, options.out)} is this build (${size(bytes.length)} B)`);
    process.exit(0);
  }
  const at = shipped.findIndex((byte, i) => byte !== bytes[i]);
  console.log(
    `[stale] ${path.relative(ROOT, options.out)} is not this build ` +
      `(shipped ${size(shipped.length)} B, built ${size(bytes.length)} B, first difference at ${at < 0 ? "end" : at})`,
  );
  process.exit(1);
}

fs.writeFileSync(options.out, bytes);
console.log(`[bundle] wispcraft.js inlined (${size(bundle.length)} B)`);
console.log(`[payload] sounds.epk inlined (${size(sounds.length)} B)`);
console.log(
  `[done] wrote ${path.relative(ROOT, options.out)} (${size(bytes.length)} B) - ` +
    `no wispcraft.js, no assets.epk and no sounds.epk needed next to it`,
);
