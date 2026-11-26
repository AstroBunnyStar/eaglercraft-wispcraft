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
 *   4. the launcher is folded in: the picker, its styles and both launcher scripts are lifted out
 *      of index.html between their markers, and the client's shell module is held as text until the
 *      picker hands over - so play.html?servers=1 picks a server and then boots the client in the
 *      same document, and a plain play.html boots straight into the game.
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

/* The picker normally owns a black page of its own; in the single file it floats over the client,
   so only the panel's own rules are reused (lifted from index.html) and this adds a modal layer,
   a backdrop and the hint. It is a <dialog> rather than a z-index because the client's own splash
   and account panels already sit at 2147483646/7 - the top layer is the only thing above that. */
const OVERLAY_CSS = `  #eagler-launcher{position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;
    max-width:none;max-height:none;background:transparent;overflow:visible;pointer-events:none;
    font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace}
  #eagler-launcher[open]{display:flex;align-items:center;justify-content:center}
  #eagler-launcher::backdrop{background:rgba(0,0,0,.9)}
  #eagler-launcher .hint{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);
    max-width:min(94vw,560px);font-size:.76rem;color:#8a9c82;background:rgba(0,0,0,.6);
    padding:3px 9px;border-radius:4px;text-align:center}
  #eagler-launcher .hint:empty{display:none}
  #eagler-launcher .servers{pointer-events:auto}
  #eagler-launcher .servers.on{display:flex;flex-direction:column;gap:10px;
    width:min(94vw,560px);color:#9fb596;background:#0a0f08;border:1px solid #22301c;
    border-radius:8px;padding:14px 16px;box-shadow:0 18px 50px rgba(0,0,0,.6)}
`;

/* The client is in this same document but must not start until the launcher has decided: the picked
   server has to be in servers.dat before the client reads that list, and the client's splash and
   first-run panels outrank the picker - so holding the start settles both. The shell's module is
   carried here as text and inserted on hand-off, which is the order the two-page build gets by
   loading play.html only after the row is written. */
const BOOT_GATE = `<script type="text/javascript">
(function () {
  "use strict";
  var started = false;
  var dialog = document.getElementById("eagler-launcher");
  var panel = document.getElementById("servers");

  /* the launcher opens and closes the picker by its class, so follow that class */
  function sync() {
    if (!dialog || !panel) return;
    var open = (" " + panel.className + " ").indexOf(" on ") >= 0;
    if (open && !dialog.open) {
      try { dialog.showModal(); } catch (e) {}
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }
  if (panel && window.MutationObserver) {
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
  sync();

  window.__eaglerSingleFileHandoff = function () {
    if (started) return;
    started = true;
    /* the picker's last note belongs on the splash, where it is still readable: the panel is gone
       by now and the note is the only thing the player needs from it */
    var note = document.getElementById("picksay");
    var status = document.getElementById("boot_status");
    if (note && status && note.textContent) status.textContent = note.textContent;
    if (dialog && dialog.open) dialog.close();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    var held = document.getElementById("eagler-single-file-start");
    if (!held) return;
    var shell = document.createElement("script");
    shell.type = "module";
    shell.textContent = held.textContent;
    if (held.parentNode) held.parentNode.removeChild(held);
    document.body.appendChild(shell);
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

/* ---------------------------------------------------------------- the launcher, in the same file */
/* index.html is maintained in this checkout rather than generated, so the picker comes from the
   working tree and not from --base: a launcher fix must not need a rebuild of main. The markers are
   what both builds share; tools/walk-picker.mjs still drives the two-page flow. */
const launcher = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const between = (start, end) => {
  const at = launcher.indexOf(start);
  if (at < 0) fail(`index.html has no ${start}`);
  const to = launcher.indexOf(end, at + start.length);
  if (to < 0) fail(`index.html's ${start} is never closed`);
  return launcher.slice(at + start.length, to).trim();
};
const pickerStyle = between("/* <picker-style> */", "/* </picker-style> */");
const pickerMarkup = between("<!-- <picker> -->", "<!-- </picker> -->");
const launcherScripts = [...launcher.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (launcherScripts.length !== 2) {
  fail(`index.html should hold the relay probe and the launch controller, found ${launcherScripts.length} inline script(s)`);
}
for (const script of launcherScripts) {
  if (/<\/script/i.test(script)) fail("a launcher script holds a </script sequence, so it cannot be inlined");
}

/* The shell's only entry point is its module: hold it instead of letting it run at parse time. Both
   of the shell's compile paths and its single main() call stay untouched inside that text. */
const SHELL_OPEN = '<script type="module">';
if (count(out, SHELL_OPEN) !== 1) fail("expected exactly one <script type=\"module\"> shell to hold");
const shellAt = out.indexOf(SHELL_OPEN);
const shellBodyAt = shellAt + SHELL_OPEN.length;
const shellEnd = out.indexOf("</script>", shellBodyAt);
if (shellEnd < 0) fail("the shell module is never closed");
const shell = out.slice(shellBodyAt, shellEnd);
if (/<\/script/i.test(shell)) fail("the shell module holds a </script sequence, so it cannot be held as text");
out = out.slice(0, shellAt) +
  `<script type="text/plain" id="eagler-single-file-start">${shell}</script>` +
  out.slice(shellEnd + "</script>".length);

const bodyEnd = "\n</body>";
if (count(out, bodyEnd) !== 1) fail("expected exactly one </body> to anchor the picker");
out = out.replace(bodyEnd,
  `\n<style>\n${OVERLAY_CSS}${pickerStyle}\n</style>\n` +
  `<dialog id="eagler-launcher">\n${pickerMarkup}\n</dialog>\n` +
  BOOT_GATE +
  launcherScripts.map((script) => `<script type="text/javascript">\n${script}\n</script>\n`).join("") +
  bodyEnd);

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
/* The launcher: the shell is held as text, there is one picker, and both launcher scripts are in. */
if (count(out, '<script type="text/plain" id="eagler-single-file-start">') !== 1) fail("the client shell was not held for the hand-off");
if (count(out, 'id="eagler-launcher"') !== 1) fail("the picker did not land exactly once");
if (count(out, 'id="picksay"') !== 1) fail("the picker's own markup did not come through");
if (count(out, "window.__eaglerSingleFileHandoff = function") !== 1) fail("the hand-off gate did not land exactly once");
if (!out.includes("window.WispRelays") || !out.includes("installRow(host)")) {
  fail("the launcher scripts did not land in the page");
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
console.log(`[launcher] picker, relay probe and launch controller inlined from index.html`);
console.log(
  `[done] wrote ${path.relative(ROOT, options.out)} (${size(bytes.length)} B) - ` +
    `no wispcraft.js, no assets.epk and no sounds.epk needed next to it`,
);
