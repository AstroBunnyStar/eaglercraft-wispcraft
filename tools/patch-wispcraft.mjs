#!/usr/bin/env node
/**
 * Re-applies the local modifications to the vendored Wispcraft bundle (wispcraft.js).
 *
 * Two patches:
 *   1. getProfile() diagnostics - the upstream bundle throws a bare
 *      `throw new Error("mc did not return a profile")`, which hides whether the
 *      account has no Java profile (404) or the token/relay was rejected (401/403).
 *      This injects a helper that reports the HTTP status plus a cause hint.
 *   2. Built-in relay default - pins the bundle's fallback relay to the same value
 *      the launcher page ships as DEFAULT, which is read out of index.html so a replaced bundle
 *      cannot drift from the launcher (and --check needs no extra flag).
 *
 * Usage:
 *   node tools/patch-wispcraft.mjs                 # patch ./wispcraft.js
 *   node tools/patch-wispcraft.mjs --check         # verify only, no writes
 *   node tools/patch-wispcraft.mjs --file path.js  # patch another copy
 *   node tools/patch-wispcraft.mjs --default-relay wss://relay.example/
 *
 * Exit codes: 0 patched/already-patched, 1 --check found a missing patch, 2 anchors unusable.
 *
 * The script is idempotent and never guesses: if a future bundle minifies the
 * profile function differently, it stops with exit 2 and says which anchor vanished.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HELPER = "__wispProfileError";
const PROFILE_URL = '"https://api.minecraftservices.com/minecraft/profile"';
const ORIGINAL_THROW = 'throw new Error("mc did not return a profile")';
const APPLIED_MARKERS = ['Minecraft profile fetch failed (HTTP ', HELPER + "("];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const file = path.resolve(opt("--file", "wispcraft.js"));
/* index.html is the single source of truth for the default relay; the bundle's pinned fallback
   follows it unless a caller is patching a copy against some other launcher. */
function launcherRelayDefault() {
  const candidates = [path.join(path.dirname(file), "index.html"), path.resolve("index.html")];
  for (const candidate of candidates) {
    try {
      const found = fs.readFileSync(candidate, "utf8").match(/\bvar\s+DEFAULT\s*=\s*"([^"]+)"/);
      if (found) return found[1];
    } catch (err) { /* try the next location */ }
  }
  return null;
}
const relayDefault = opt("--default-relay", launcherRelayDefault() || "wss://anura.pro/");
const checkOnly = flag("--check");

let js;
try {
  js = fs.readFileSync(file, "utf8");
} catch (err) {
  console.error(`[fail] cannot read ${file}: ${err.message}`);
  process.exit(2);
}

const lines = [];
let changed = 0;
let fatal = null;

// ---------------------------------------------------------------- patch 1: relay default
// The bundle resolves its default with `localStorage.wispcraft_wispurl || OI`, so the
// identifier is discovered rather than hard-coded (minifiers rename it between builds).
let defaultId = null;
const refMatch = js.match(/localStorage\.wispcraft_wispurl\s*\|\|\s*([A-Za-z_$][\w$]*)/);
if (!refMatch) {
  lines.push("[skip] relay default: no `localStorage.wispcraft_wispurl||<CONST>` reference found");
} else {
  defaultId = refMatch[1];
  const assign = js.match(new RegExp(`(\\b${defaultId}\\s*=\\s*")(wss?:\\/\\/[^"]*)(")`));
  if (!assign) {
    lines.push(`[skip] relay default: constant ${defaultId} exists but its literal was not found`);
  } else if (assign[2] === relayDefault) {
    lines.push(`[ok]   relay default already ${relayDefault} (${defaultId})`);
  } else {
    js = js.replace(assign[0], `${assign[1]}${relayDefault}${assign[3]}`);
    changed++;
    lines.push(`[fix]  relay default ${assign[2]} -> ${relayDefault} (${defaultId})`);
  }
}

// ---------------------------------------------------------------- patch 2: profile diagnostics
const alreadyApplied = APPLIED_MARKERS.some((m) => js.includes(m));

if (alreadyApplied) {
  lines.push("[ok]   profile error patch already present");
} else {
  const urlAt = js.indexOf(PROFILE_URL);
  const throwAt = js.indexOf(ORIGINAL_THROW);

  if (urlAt < 0) {
    fatal = `profile patch: ${PROFILE_URL} is not in this file - is it the Wispcraft bundle?`;
  } else if (throwAt < 0 || throwAt - urlAt > 900) {
    fatal =
      `profile patch: the throw ${JSON.stringify(ORIGINAL_THROW)} is missing or too far from the profile fetch.\n` +
      "       The bundle was rebuilt with a different shape; open the function around\n" +
      `       ${PROFILE_URL}, check what it throws now, and update ORIGINAL_THROW in this script.`;
  } else {
    // Which variable holds the profile Response? Read it from the fetch binding.
    const window = js.slice(Math.max(0, urlAt - 200), urlAt + 200);
    const binding = window.match(
      /([A-Za-z_$][\w$]*)\s*=\s*await\s+LA\(\s*"https:\/\/api\.minecraftservices\.com\/minecraft\/profile"/
    );

    if (!binding) {
      fatal =
        "profile patch: could not tell which variable holds the profile Response\n" +
        '       (expected `<name> = await LA("https://api.minecraftservices.com/minecraft/profile" ...)`).';
    } else {
      const helperSrc =
        `async function ${HELPER}(r){` +
        'var s=r&&typeof r.status=="number"?r.status:0;' +
        'var h=s===404?"This Microsoft account has no Minecraft: Java Edition profile. Sign in with the account that owns Java Edition (and has launched it once).":' +
        's===401||s===403?"Microsoft/Mojang rejected the session token. Open Wispcraft Settings and add the account again.":' +
        '"The Minecraft profile endpoint returned an unexpected response.";' +
        'var d="";try{var c=r.clone();var x=await c.text();var j=JSON.parse(x);' +
        'd=String(j&&(j.errorMessage||j.error)||"").slice(0,120).replace(/[<>]/g,"")}catch(e){}' +
        'return "Minecraft profile fetch failed (HTTP "+s+"). "+h+(d?" ["+d+"]":"")}';

      // Inject the helper just before the statement that defines the relay default,
      // which sits inside the bundle's own scope; fall back to the file start.
      let injectAt = 0;
      if (defaultId) {
        const declAt = js.search(new RegExp(`(const|let|var)\\s+[^;]{0,120}\\b${defaultId}\\s*=`));
        if (declAt >= 0) injectAt = declAt;
      }
      js = js.slice(0, injectAt) + helperSrc + "\n" + js.slice(injectAt);

      const at = js.indexOf(ORIGINAL_THROW);
      js = js.slice(0, at) + `throw new Error(await ${HELPER}(${binding[1]}))` + js.slice(at + ORIGINAL_THROW.length);
      changed++;
      lines.push(`[fix]  profile error patch applied (response var \`${binding[1]}\`, helper ${HELPER})`);
    }
  }
}

// ---------------------------------------------------------------- patch 3: expose the relay fetch
// The bundle owns an epoxy client (a full HTTP client that speaks HTTPS through the wisp relay), so
// it can reach endpoints a page cannot - sessionserver.mojang.com sends no CORS headers, which is
// what kills an online-mode join. The client itself is module-scoped; this publishes it on the
// launcher namespace so the page's fetch shim can hand those requests to the relay instead of a
// third-party proxy. The identifier is discovered from the `return await <A>,await <B>.fetch(` shape.
const RELAY_MARKER = ".fetchViaRelay=";
const nsId = (js.match(/([A-Za-z_$][\w$]*)\.wispUrl\s*=/) || [])[1];
const fetchFn = (js.match(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]{0,24}\)\s*\{\s*return await [A-Za-z_$][\w$]*,\s*await [A-Za-z_$][\w$]*\.fetch\(/) || [])[1];

const alreadyExported = nsId && new RegExp("\\n" + nsId.replace(/\$/g, "\\$") + "\\.fetchViaRelay=").test(js);
if (alreadyExported) {
  lines.push("[ok]   relay fetch export already present");
} else if (!nsId || !fetchFn) {
  lines.push("[skip] relay fetch export: could not find the namespace or the relay-fetch helper");
} else {
  /* the namespace object owns wispUrl, so this line is module scope: a function declared later is
     hoisted, and the closure only runs when a request is actually made */
  const anchor = new RegExp(`(${nsId.replace(/\$/g, "\\$")}\\.wispUrl\\s*=\\s*void 0;)`);
  if (!anchor.test(js)) {
    lines.push("[skip] relay fetch export: no `<ns>.wispUrl=void 0` anchor at module scope");
  } else {
    js = js.replace(anchor, `$1\n${nsId}.fetchViaRelay=function(u,i){return ${fetchFn}(u,i)};`);
    changed++;
    lines.push(`[fix]  relay fetch exported as ${nsId}.fetchViaRelay (helper ${fetchFn})`);
  }
}

// ---------------------------------------------------------------- validate before writing
if (!fatal && changed) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wispcraft-patch-")), "check.js");
  fs.writeFileSync(tmp, js);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    lines.push("[ok]   patched bundle parses (node --check)");
  } catch (err) {
    fatal = `patched bundle failed to parse, nothing written:\n${err.stderr ? err.stderr.toString() : err.message}`;
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

for (const line of lines) console.log(line);

if (fatal) {
  console.error(`\n[fail] ${fatal}`);
  process.exit(2);
}

if (checkOnly) {
  const missing = !alreadyApplied && changed === 0;
  if (changed > 0) {
    console.log("\n[check] patches are missing; run without --check to apply them.");
    process.exit(1);
  }
  if (missing) process.exit(1);
  console.log(`\n[check] ${path.basename(file)} carries every patch.`);
  process.exit(0);
}

if (changed === 0) {
  console.log(`\n[done] ${path.basename(file)} already up to date, nothing written.`);
} else {
  fs.writeFileSync(file, js);
  console.log(`\n[done] wrote ${file} (${js.length} bytes)`);
}
