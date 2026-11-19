/**
 * The relay pre-flight ships inside index.html - the site has no separate script file any more, so
 * a deploy cannot leave the page and its probe out of step. Tests and tools still need the module
 * on its own: this slices it out of the page between the marker comments, which is exactly the
 * text the browser executes.
 *
 *   import { relaySource } from "./tools/relay-source.mjs";
 *   relaySource()                 # the module from ./index.html
 *   relaySource("other.html")     # from another copy
 *
 * Throws when the markers are missing, so a page rewrite fails loudly instead of silently testing
 * an empty string.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const START = "/* <relay-probe> */";
export const END = "/* </relay-probe> */";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function relaySource(file = path.join(ROOT, "index.html")) {
  const html = fs.readFileSync(file, "utf8");
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < from) {
    throw new Error(
      `${path.basename(file)}: the relay probe markers are missing ` +
        `(expected ${START} ... ${END}); the launcher page must keep both`,
    );
  }
  return html.slice(from + START.length, to);
}
