/**
 * Drives the servers.dat writer that turns a launcher pick into a Multiplayer row.
 *
 * The client keeps its server list in an NBT file inside its own filesystem database, and that list
 * wins over anything handed to the page - which is why a picked server used to be armed for one visit
 * and never appeared in Multiplayer. `index.html` now writes the row into that file while it still
 * owns the tab, then hands over a plain `play.html`, so the generated page needs no patch at all. The
 * write only happens after the reader reproduces the file byte for byte: a list it cannot rebuild
 * exactly is left untouched rather than rewritten into something the client may reject.
 *
 * These checks drive that contract against files shaped like the one the client writes (measured:
 * a root compound holding a `servers` list of compounds with connectionMode, ip, icon, hidden and
 * name): the round trip is exact, a pick adds exactly one row, a second pick reports the row as
 * present, a row saved under the typed name is recognised too, and a file this reader does not
 * understand comes back unchanged with the "unsupported" answer.
 *
 * The block is cut out of the shipped launcher at run time, between its markers, so this test tracks
 * the real page instead of a copy of it.
 *
 * Run with: node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");

const blockStart = html.indexOf("  /* <server-list> */");
const blockEnd = html.indexOf("  /* </server-list> */");
if (blockStart < 0 || blockEnd < blockStart) throw new Error("the servers.dat writer is missing from index.html");

const page = new Function(
  [
    html.slice(blockStart, blockEnd),
    "return { nbtParse, nbtWrite, addRow, firstList, pickedRow, parseTarget };",
  ].join("\n"),
)();

/* --- a servers.dat shaped like the client's own, built here so the page's writer is not grading
       itself: compound > list "servers" > compounds, in the key order the client writes -------- */
const enc = new TextEncoder();
function nbtFixture(entries) {
  const out = [];
  const push = (...bytes) => out.push(...bytes);
  const u16 = (v) => push((v >> 8) & 255, v & 255);
  const i32 = (v) => push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const str = (text) => {
    const bytes = enc.encode(text);
    u16(bytes.length);
    push(...bytes);
  };
  push(10); /* root compound */
  str("");
  push(9); /* list of compounds */
  str("servers");
  push(10);
  i32(entries.length);
  for (const entry of entries) {
    push(8);
    str("connectionMode");
    str(entry.mode);
    push(8);
    str("ip");
    str(entry.ip);
    if (entry.icon !== undefined) {
      push(8);
      str("icon");
      str(entry.icon);
    }
    push(1); /* hidden */
    str("hidden");
    push(entry.hidden ? 1 : 0);
    push(8);
    str("name");
    str(entry.name);
    push(0);
  }
  push(0); /* end of root compound */
  return new Uint8Array(out);
}

const icon = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAdyklEQVR4nK2by6tt253X515rvh9jzjHnGPO1Hnuffd6P+8y9qdxEY1IxVGlFg9owrWrYtCFpSOwJCmLHkkCloYIUCoJaauqPsDqCIUgFAoG0EqpRpCAYqcCl+Pn5jZN9cu45+3VStWGxz1l7rrHG+D2+3+9vjN+IYrdI1dSSt4X0ZS2F6aR";
const clientFile = nbtFixture([
  { mode: "eaglerx", ip: "wss://arch.mc", icon, hidden: 0, name: "ArchMC" },
  { mode: "eaglerx", ip: "wss://example.org:25566", hidden: 0, name: "Example" },
]);
const minimalFile = nbtFixture([{ mode: "eaglerx", ip: "wss://arch.mc", hidden: 0, name: "ArchMC" }]);

const decode = (bytes) => Buffer.from(bytes).toString("latin1");
const RELAY = "wss://truffled.lol/wisp/";
const WISP_IP = "eagler-wisp:" + encodeURIComponent(RELAY) + "?target=ccc.blocksmc.com:25565";
/* what the launcher builds: the address the player picked, and the SRV target it resolved for it */
const pick = (host = "blocksmc.com", resolved = "ccc.blocksmc.com:25565") => page.pickedRow(host, resolved);

test("the launcher turns a pick and its SRV target into the row the client writes", () => {
  const row = pick();
  assert.equal(row.name, "blocksmc.com", "the player sees the address they picked");
  assert.equal(row.request, "blocksmc.com");
  assert.equal(row.host, "ccc.blocksmc.com", "the relay dials the record's host");
  assert.equal(row.port, 25565);
  /* no record answered: the typed host is used as-is, with the default port */
  const bare = page.pickedRow("minemen.club");
  assert.equal(bare.host, "minemen.club");
  assert.equal(bare.port, 25565);
  assert.equal(page.pickedRow("play.example.net:25566").port, 25566);
});

test("the exact bytes the client writes come back out unchanged", () => {
  const back = page.nbtWrite(page.nbtParse(clientFile));
  assert.deepEqual(Buffer.from(back), Buffer.from(clientFile), "a reader that cannot reproduce the file must not write to it");
});

test("a pick is added as one Wisp row the client can join", () => {
  const added = page.addRow(RELAY, minimalFile, pick());
  assert.equal(added.state, "added");
  assert.equal(added.row.name, "blocksmc.com");
  const text = decode(added.bytes);
  assert.match(text, /connectionMode/);
  assert.match(text, /wisp/);
  assert.ok(text.includes(WISP_IP), "the row is the shape the client's own Add Server writes: " + WISP_IP);
  assert.match(text, /blocksmc\.com/);
  const list = page.nbtParse(added.bytes).tag.value.find((f) => decode(f.name) === "servers").tag;
  assert.equal(list.value.length, 2, "the client's own row is still there");
  assert.equal(decode(list.value[0].value.find((f) => decode(f.name) === "name").tag.value), "ArchMC");
  /* the list header grew from one entry to two, and the row the client already had is byte for byte
     what it was - the append changes nothing above it */
  assert.equal(added.bytes[13], 10, "the list still holds compounds");
  assert.deepEqual([...added.bytes.subarray(14, 18)], [0, 0, 0, 2], "one more entry");
  assert.deepEqual([...minimalFile.subarray(14, 18)], [0, 0, 0, 1]);
  assert.deepEqual(Buffer.from(added.bytes.subarray(18, minimalFile.length - 1)),
    Buffer.from(minimalFile.subarray(18, minimalFile.length - 1)), "the client's own row is untouched");
  assert.equal(added.bytes[added.bytes.length - 1], 0, "the root compound still ends where it did");
  assert.ok(added.bytes.length > minimalFile.length);
});

test("a non-default port is written into the target", () => {
  const added = page.addRow(RELAY, minimalFile, page.pickedRow("play.example.net:25566"));
  assert.equal(added.state, "added");
  assert.ok(decode(added.bytes).includes("?target=play.example.net:25566"));
});

test("picking the same server twice does not add a second row", () => {
  const added = page.addRow(RELAY, minimalFile, pick());
  const again = page.addRow(RELAY, added.bytes, pick());
  assert.equal(again.state, "present");
  assert.deepEqual(Buffer.from(again.bytes), Buffer.from(added.bytes), "the file is not rewritten");
});

test("a saved row for the same server is switched to Wisp instead of duplicated", () => {
  /* an older row: the name the player typed, no relay, which the client dials as an EaglerX socket */
  const byName = nbtFixture([{ mode: "eaglerx", ip: "minemen.club", hidden: 0, name: "Minemen" }]);
  const fixed = page.addRow(RELAY, byName, pick("minemen.club", "geo.minemen.club"));
  assert.equal(fixed.state, "updated");
  const text = decode(fixed.bytes);
  assert.ok(text.includes("eagler-wisp:"), "the row now points at the relay");
  assert.ok(text.includes("?target=geo.minemen.club:25565"));
  assert.match(text, /Minemen/, "the player's name for it survives");
  const list = page.nbtParse(fixed.bytes).tag.value.find((f) => decode(f.name) === "servers").tag;
  assert.equal(list.value.length, 1, "one row, not two");
  const again = page.addRow(RELAY, fixed.bytes, pick("minemen.club", "geo.minemen.club"));
  assert.equal(again.state, "present");
  assert.deepEqual(Buffer.from(again.bytes), Buffer.from(fixed.bytes), "and a second pick does not rewrite it");
});

test("a file this reader cannot reproduce is left exactly as it was", () => {
  for (const [what, bytes] of [
    ["not nbt at all", new Uint8Array([1, 2, 3, 4, 5])],
    ["trailing bytes", new Uint8Array([...clientFile, 0, 0, 0, 7])],
    ["truncated", clientFile.subarray(0, clientFile.length - 9)],
    /* an int tag: one of the types a server list is not made of, so the reader refuses the file
       rather than appending to something it may not reproduce */
    ["a tag this reader does not carry", new Uint8Array([10, 0, 0, 3, 0, 1, 120, 0, 0, 0, 1, 0])],
  ]) {
    const answer = page.addRow(RELAY, bytes, pick());
    assert.equal(answer.state, "unsupported", what);
    assert.equal(answer.bytes, bytes, what + ": nothing was rewritten");
  }
});

test("no java entry means no write", () => {
  const answer = page.addRow(RELAY, minimalFile, null);
  assert.equal(answer.state, "none");
  assert.equal(answer.bytes, minimalFile);
});

test("a profile that never saved a list gets one with just this row", () => {
  const first = page.firstList(RELAY, pick());
  const tree = page.nbtParse(first);
  const list = tree.tag.value.find((f) => decode(f.name) === "servers").tag;
  assert.equal(list.inner, 10);
  assert.equal(list.value.length, 1);
  const row = list.value[0].value.reduce((out, f) => ({ ...out, [decode(f.name)]: f.tag }), {});
  assert.equal(decode(row.connectionMode.value), "wisp");
  assert.equal(decode(row.ip.value), WISP_IP);
  assert.equal(row.hidden.value[0], 0);
  assert.equal(decode(row.name.value), "blocksmc.com");
  assert.equal(page.addRow(RELAY, first, pick()).state, "present");
});
