#!/usr/bin/env node
/**
 * Parses the launcher page and checks the files it names, so a syntax error or a reference to a
 * file that no longer exists fails CI instead of shipping. The page has no build step, so nothing
 * else checks it: the relay probe used to live in relays.js, and a leftover
 * `<script src="./relays.js">` would now 404 in a browser while every other check stayed green.
 *
 * Usage: node tools/check-launcher.mjs [file]
 * Exit codes: 0 parses and every local reference exists, 1 a parse error or a missing file.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const file = process.argv[2] || "index.html";
const html = fs.readFileSync(file, "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

if (blocks.length === 0) {
  console.error(`[fail] ${file}: no inline <script> found`);
  process.exit(1);
}

for (let i = 0; i < blocks.length; i++) {
  try {
    new vm.Script(blocks[i]);
  } catch (err) {
    console.error(`[fail] ${file}: inline script ${i} does not parse: ${err.message}`);
    process.exit(1);
  }
}

/* Every relative src/href must resolve to a file next to the page: the launcher is deployed by
   copying this folder, so a typo is only ever discovered by a player. */
const dir = path.dirname(path.resolve(file));
const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/gi)].map((m) => m[1]);
const missing = [];
for (const ref of refs) {
  if (!ref || ref.startsWith("#") || ref.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
  if (!fs.existsSync(path.resolve(dir, ref.split(/[?#]/)[0]))) missing.push(ref);
}
if (missing.length) {
  console.error(`[fail] ${file}: local reference(s) missing: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`[ok]   ${file}: ${blocks.length} inline script(s) parse, ${refs.length} reference(s) resolve`);
