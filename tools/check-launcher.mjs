#!/usr/bin/env node
/**
 * Parses the launcher's inline script so a syntax error in index.html fails CI
 * instead of shipping. The page has no build step, so nothing else checks it.
 *
 * Usage: node tools/check-launcher.mjs [file]
 * Exit codes: 0 parses, 1 no inline script or a parse error.
 */
import fs from "node:fs";
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

console.log(`[ok]   ${file}: ${blocks.length} inline script(s) parse`);
