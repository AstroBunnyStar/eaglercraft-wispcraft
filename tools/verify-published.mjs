/**
 * Compares the files GitHub Pages is actually serving against this working tree.
 * A deploy that silently lagged behind the commit is otherwise invisible: the site
 * answers 200 either way, and play.html is too large to eyeball.
 *
 *   node tools/verify-published.mjs                     # the live site
 *   node tools/verify-published.mjs https://host/path/  # somewhere else
 *
 * Exit 0 = every served file is byte-identical to the local copy, 1 = drift.
 * GitHub's CDN can serve a stale copy for a few minutes after a deploy; rerun then.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ORIGIN = "https://astrobunnystar.github.io/eaglercraft-wispcraft/";
const FILES = ["index.html", "play.html", "relays.js", "wispcraft.js"];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const size = (n) => n.toLocaleString("en-US");

const origin = (() => {
  try {
    return new URL(process.argv[2] || DEFAULT_ORIGIN);
  } catch {
    console.error(`not a URL: ${process.argv[2]}\nusage: node tools/verify-published.mjs [https://host/path/]`);
    process.exit(2);
  }
})();
if (!origin.pathname.endsWith("/")) origin.pathname += "/";

let failures = 0;
for (const file of FILES) {
  const local = fs.readFileSync(path.join(ROOT, file));
  const url = new URL(file, origin);
  let served;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    served = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    failures++;
    console.log(`MISSING  ${file.padEnd(13)} local ${size(local.length)} B  ${error.message}`);
    continue;
  }

  if (served.equals(local)) {
    console.log(`ok       ${file.padEnd(13)} ${size(local.length).padStart(13)} B  ${sha256(local).slice(0, 12)}`);
    continue;
  }

  failures++;
  console.log(`DIFFERS  ${file.padEnd(13)} local ${size(local.length)} B ${sha256(local).slice(0, 12)}`);
  console.log(`         ${"".padEnd(13)} served ${size(served.length)} B ${sha256(served).slice(0, 12)}`);
}

console.log(
  failures === 0
    ? `\n${origin.href} matches this tree.`
    : `\n${failures} file(s) differ from ${origin.href} - redeploy, or wait out the CDN.`,
);
process.exit(failures === 0 ? 0 : 1);
