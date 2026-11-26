# Local patches to the vendored Wispcraft bundle

`wispcraft.js` is a **third-party minified bundle**, not our code. Everything we changed inside
it is recorded here and re-applied by `tools/patch-wispcraft.mjs`, because a bundle update
replaces the whole file and would silently drop these fixes.

Bundle identity: Wispcraft `1.0.0`, `COMMITHASH 404f79c`, injected into `play.html` from the
`DhyeyBG/wispcraft-injector` community fork.

## Apply / verify

```bash
# after dropping in a new wispcraft.js
node tools/patch-wispcraft.mjs --check     # 1 = patch missing, 0 = good, 2 = bundle shape changed
node tools/patch-wispcraft.mjs             # applies whatever is missing (idempotent)
node tools/patch-wispcraft.mjs --file path/to/other-copy.js
node tools/patch-wispcraft.mjs --default-relay wss://relay.example/

# after rebuilding play.html (the page-level SRV hook is a local edit, not part of the payload)
node tools/patch-play-srv-hook.mjs --check    # 1 = hook missing or stale, 0 = good, 2 = anchor gone
node tools/patch-play-srv-hook.mjs            # inserts it, or replaces an older copy (idempotent)
node tools/patch-play-srv-hook.mjs --file path/to/other-play.html
```

Then re-check the client still boots (launcher → Play, sign-in code appears). The script refuses
to write a file that fails `node --check`, and it exits `2` with the missing anchor named if a
future minifier reshapes the function.

## Patch 1 — `getProfile()` error diagnostics

Upstream turns every failure of `https://api.minecraftservices.com/minecraft/profile` into one
opaque message, so a 404 (account has no Java Edition profile) looks identical to a 403 (relay or
token rejected):

```js
// before
throw new Error("mc did not return a profile")
```

After the patch, the function throws

```js
throw new Error(await __wispProfileError(<response>))
```

with a helper injected into the bundle scope that produces, for example:

```
Minecraft profile fetch failed (HTTP 404). This Microsoft account has no Minecraft: Java Edition
profile. Sign in with the account that owns Java Edition (and has launched it once). [NOT_FOUND]
```

- 404 → no Java profile on that Microsoft account.
- 401/403 → token rejected, or the relay's egress is blocked; re-add the account or switch relays.
- The trailing `[CODE]` comes from the response body when it is still readable (the helper
  `clone()`s before reading, and gives up quietly if the body was already consumed).

The bundle currently shipped in this folder carries an equivalent *inline* version of this fix rather
than the helper (grep `Minecraft profile fetch failed (HTTP ` in `wispcraft.js`). The script treats
either form as applied and emits the helper form when patching a fresh bundle, so the two never
fight each other.

Anchors the script relies on: the string `https://api.minecraftservices.com/minecraft/profile`,
the original throw text `mc did not return a profile`, and the binding pattern
`<name> = await LA("…/minecraft/profile"`. If a rebuild changes the throw text, update
`ORIGINAL_THROW` at the top of the script.

## Patch 2 — pinned relay default

The bundle reads `localStorage.wispcraft_wispurl || <CONST>`. The patch pins `<CONST>` to the
value `index.html` ships as `DEFAULT`, which the tool now reads out of that page — so a replaced
bundle cannot quietly fall back to a different relay than the launcher shows, and `--check` works
without passing the value again. `--default-relay` still overrides it when patching a copy that
belongs to some other launcher. The constant's identifier is discovered from the expression, because
minifiers rename it between builds.

## Relay default

`index.html` ships a fixed `DEFAULT` (`wss://linuxontab-net.fly.dev/wisp/`) instead of probing on
every launch, because the probe is the wrong tool for choosing the first relay:

- a fixed default starts the game immediately on a first visit, with no 22-relay sweep first;
- the page already tests the saved relay with a real proxied request and, only when that fails,
  asks the list for a relay that carries traffic — so a bad default costs one failed test, not a
  stuck page;
- a sweep measures one round-trip to a fixed host, not throughput or stability for the server the
  player will actually join, so "always take the fastest" would still re-rank on noise and throw
  away a relay the player chose on purpose.

**Moved off `us-east.wisp.q13x.com` on 2026-11-18.** That relay stopped carrying traffic for
everyone at once, not just for one network: the scheduled `relay.yml` run failed with
`DOWN 922 ms  wss://us-east.wisp.q13x.com/` on GitHub's westus2 runner while 18 of 22 relays
passed, and the same run had passed nine hours earlier. It is also the only relay seen to refuse a
TLS stream to `login.microsoftonline.com` outright: the client's sign-in through it dies with
`hyper ... tls handshake eof` and never issues a device code, while the same client, freshly loaded
with the account store emptied, shows a code within 12-18 s through `linuxontab-net`, `truffled.lol`
and `anura.pro`. `linuxontab-net.fly.dev` was the fastest survivor of that sweep (336 ms proxied on
the runner) and completes the Microsoft handshake, so it is the new default.

An earlier version of the TLS probe described below claimed that *only* `linuxontab-net` could
handshake, which was wrong. It built the ClientHello by hand and waited for a CONTINUE on the new
stream: Microsoft rejects the hand-built hello (the direct control died with `ECONNRESET`), and
several relays never send that CONTINUE, so healthy relays looked dead and the one that sends it did
not. The probe now replays a ClientHello captured from a real TLS stack and queues it immediately
after CONNECT. That reproduces the client exactly: ServerHello through every relay that can sign in,
`closed` through `us-east`.

The table below is the original 2026-11-17 measurement that made `us-east` the default in the first
place; five handshake probes each, then a real HTTP request through `@mercuryworkshop/wisp-js`, then
a Minecraft status ping to Hypixel over the same stream.

| relay | handshake | proxied HTTP | Hypixel ping |
| --- | --- | --- | --- |
| us-east.wisp.q13x.com | 5/5, 91-475 ms | 218 ms | 172 ms |
| bare-server.fly.dev | 3/5, 1398-2657 ms | 220 ms | 200 ms |
| truffled.lol | 5/5, 149-906 ms | 309 ms | — |
| fern.best | 2/5, 1295-1745 ms | 312 ms | — |
| anura.pro | 5/5, 323-1878 ms | 564 ms | 704 ms |
| wisp.mercurywork.shop | 3/5, 1689-2655 ms | 858 ms | — |

The upstream default was `anura.pro`, a shared general-purpose proxy: it answered the handshake every
time but was 3-4× slower end to end, with handshakes swinging from 0.3 s to 1.9 s. That is the
"sometimes does not work" report. The pre-flight used to stop at the WebSocket handshake, so it passed
on exactly that relay; it now requires a reply from a proxied stream, which is the difference between
"accepts connections" and "carries traffic".

### How the pre-flight works

`WispRelays.probe()` opens the relay with no subprotocol and waits for the greeting — a CONTINUE
for stream 0, which the spec requires before the client may send anything. Both protocol versions use
the same `[type][streamID u32 LE][payload]` layout (little-endian) and differ only in the INFO
handshake, so there is no version branch: a missing greeting is a failure, not something to guess
around. The probe then CONNECTs stream 1 to `example.com:80`, sends
`GET / HTTP/1.1 … Connection: close`, and reports success only when the first DATA packet starts with
`HTTP/`. A relay that accepts the socket and then stalls fails within the probe timeout instead of
after launch.

**The page** tests the saved relay once, then hands the tab to `play.html`; only when that test
fails does it ask the list for one relay that can carry the session and save it. There is no launcher
screen and no relay list in front of the game: `index.html` is one self-contained file (relay module
inlined between the `<relay-probe>` markers) that shows a black boot screen while it probes and then
`location.replace()`s into the game, so the pre-flight costs a few hundred milliseconds on a healthy
relay. Choosing a different relay by hand is **Wisp Settings → Wisp Server** in game, and the list
below is the fallback when the saved one stops working.

That fallback does not wait for all 22 relays. `probeBest()` returns as soon as a relay that can
carry the session has answered and a 500 ms grace for a faster neighbour has passed, so a dead saved
relay costs ~1.4 s measured instead of the ~6.7 s the full sweep took. A pass is remembered for 10
minutes (`localStorage.wispcraft_relay_check`, keyed to the relay in use), so a relaunch goes
straight through; a fresh browser, a relay the player just changed, or a verdict older than 10
minutes gets the full test, and a failed test clears the verdict instead of leaving a stale pass
behind. `test/launch.test.mjs` runs the page's controller in a vm and pins that down, and
`test/relays-signin.test.mjs` covers `probeBest()` itself.

**The game page is not fetched while the relay is tested.** That was tried and measured, and it
cannot work on this host: Chrome does not keep a 43.5 MB document - two `fetch()`es of `play.html`
both crossed the wire in full, and a `<link rel=prefetch>` was not adopted by the following
navigation - while `sounds.epk` (25.9 MB) and `wispcraft.js` came from the disk cache on their
second request. A parallel fetch of `play.html` is therefore discarded when the tab navigates, which
doubles the first load (86.99 MB instead of 43.49 MB) and does not move the moment the game starts
downloading. Cutting the wait itself is what works: the early-resolving search above.
The traffic target is deliberately a plain HTTP host: Wisp is protocol-agnostic, so a reply proves the
whole path (socket → stream → relay egress → data back) without TLS or a Minecraft handshake.

That test alone cannot see the failure that hurts most, because it says nothing about whether the
relay can reach Microsoft. Every probe therefore also opens a second stream, `probeSignIn()`: CONNECT
to `login.microsoftonline.com:443`, queue a fixed 269-byte TLS 1.2 ClientHello straight away, and pass
only when the reply starts with a **ServerHello** record (content type 22, handshake type 2). Any
bytes are not enough: a TLS alert also proves a record crossed in both directions, but it means
Microsoft refused the connection, so counting it would paint a relay green that cannot sign anyone
in. An alert, plain text or a malformed record header fails the test as soon as it arrives, and a
record split across DATA packets is accumulated until it can be classified. The hello is a captured
constant, not something built in JS (a hand-built one is rejected), and it carries the SNI, so the
same bytes work through every relay; `test/relays-signin.test.mjs` parses it and asserts the record
lengths and the `login.microsoftonline.com` server name, so the constant cannot rot unnoticed.

A failed handshake is retried once (with a shorter 3 s budget) before the relay is labelled
*sign-in fails*: a single reset mid-handshake is not evidence that the relay cannot sign anyone in,
and a wrong demotion hides a working relay from every signed-out player. The retry only runs when
the relay carried the traffic test, so a relay that cannot proxy at all is still tested once, and
`probeAll()`'s fallback deadline is long enough to wait for it instead of dropping the relay. `probe()` reports `ok`
(carried the test request) and `signin` (completed the sign-in handshake) separately: a relay that
fails `signin` can still play, but it strands anyone who is not signed in yet. The page therefore
prefers `signin` relays while the browser has no saved account, and the sweep labels them; the relay
picked is what the game boots with. `us-east.wisp.q13x.com` is the case this exists for: its sign-in
stream closed while its plain-HTTP test still answered on some sweeps.

That handshake retry has not been observed rescuing anything yet, and the sweeps say why: across
three consecutive relay sweeps and 88 direct probes, every relay that carried traffic also
completed the sign-in handshake on its first attempt, so the second handshake never ran at all. A
*sign-in fails* label is therefore rare in practice; when it appeared earlier it came from a moment
when the relay was failing everything, not from a repeatable handshake failure.

A failed traffic test is retried once too (3 s), for the same reason in the other direction. Those
three sweeps returned 15, 13 and 16 of 22 relays carrying traffic, and the failing set changed every
time: `zodiac.icu`, `api.hfhj.links.gointospace.app`, `orbitweb.org`, `motor-cycle-part.org`,
`dkwmkvruzebnqlmvwzhy.supabase.co`, `civil.quartinal.me`, `studyworkandmore.uk`,
`xh4r26…ddnsfree.com` and `invisiproxy.com` each failed one sweep and passed another. Repeating the
probe four times per relay in one process showed the difference between noise and death: only
`us-east.wisp.q13x.com`, `speedster.heavengtwashere.workers.dev` and `wisp.anjomous.workers.dev`
opened two traffic CONNECTs every time and still failed, while every other relay answered on the
first. One timeout is therefore noise, and `probeAll()`'s fallback deadline (11 s) clears both
retries. `test/relays-signin.test.mjs` covers the retry: a silent first attempt that answers on the
retry carries traffic, two silent attempts still grow the label *cannot proxy*, and a first-attempt
success is never retried.

To refresh: probe from a browser (the page runs both tests on every launch), update `DEFAULT` in
`index.html`, then run `node tools/patch-wispcraft.mjs` so the bundle follows.

Note this is only the last-resort fallback: in normal use the page's pre-flight writes the chosen
relay into `localStorage`, and the in-game override is **Wisp Settings → Wisp Server**.
The launcher default and the bundle fallback both come from `DEFAULT` in `index.html`, which is the one
place to change.

## Server directory (`index.html`, `?servers=1`)

The one thing the HBW / Lunamix launcher (`skiingbeast2025/lunamix-eaglercraft`) had that this page
did not is a list of servers in front of the game: theirs shows cards with the address on screen and
a **Copy IP** button, and launches a client from them. `index.html?servers=1` is the same idea for
our launcher, aimed at Java servers and the relay:

- a picker with a custom address field, five known Java networks, **Copy IP** per entry and a
  **Play without a server** escape hatch;
- picking one resolves the SRV record over DNS-over-HTTPS and writes the row into the client's own
  `servers.dat`, then hands the tab to a plain `play.html`. The row names the host the relay can
  actually dial (`blocksmc.com` → `ccc.blocksmc.com`): a bare SRV-only domain otherwise times out at
  the relay with code 1006;
- the pick is remembered in `localStorage.wispcraft_pinned_java`, so later launches write the same
  row without asking again.

A pick now lands in Multiplayer **and joins from there**. The client's own `servers.dat` still wins
over anything the page passes in `eaglercraftXOpts.servers`, so `index.html` writes the row into
that file before handing the tab over — as the **Wisp** entry the client's own Add Server dialog writes, which
is the only row shape that reaches a Java server (see *The picked server as a row* below). Verified
end to end: `index.html?servers=1` → **Play** on BlocksMC → `[wispcraft] blocksmc.com added to your
server list as a Wisp entry for ccc.blocksmc.com:25565` → Multiplayer lists `blocksmc.com` with a
live BlocksMC status (236/10000 and its MOTD) → **Join Server** → in world.

The launcher hand-off stays instant when there is nothing to report: only `?servers=1` holds the
tab, and a launch with a row to add holds it for about a second and a half so the note can be read.
That is why the picker is a URL and not the default screen — the page has no game to show while a
player picks.

## The picked server as a row (`index.html`, `servers.dat`)

Three ways to hand the client a Java server were measured on a local build, and only the third joins:

- `connectionMode: eaglerx` with `ip: wss://<host>` **shows** in Multiplayer, but the client dials it
  as a direct EaglerX WebSocket (*Could not connect to direct EaglerX WebSocket*) and the page's
  socket proxy never sees the dial, so no `wss://` row can be routed through the relay;
- `ip: java://<host>:<port>` is dialled as `ws://java//<host>:<port>` by the same connector, again
  without the proxy (`net::ERR_NAME_NOT_RESOLVED` for host `java`) — a java address in this file
  does not mean what it means in `eaglercraftXOpts.servers`;
- `connectionMode: wisp` with `ip: eagler-wisp:<percent-encoded wisp relay>?target=<host>:<port>` is
  what the client's own **Add Server → Wisp** writes. The client dials the relay itself, the relay
  opens the Java connection, and that row pings and joins with nothing from the page at all.

The row is written in that third shape. The target is the host the SRV record points at: with the
typed `blocksmc.com` the relay answers *Wisp destination host could not be reached (code 1006)*,
which is the same failure the launcher's pre-boot SRV lookup exists to avoid. The relay comes from
`WispRelays.current()`, so a player who switched relays keeps their row on the relay they chose.

Writing the file is guarded rather than trusted. `servers.dat` is parsed into NBT tags and
serialized again, and the result must equal the file byte for byte before anything is appended: a
file this reader does not reproduce exactly (a future format, a damaged file, a different storage
shape) is left untouched, and the note says the row was not added and gives the `host:port` to paste
into **Direct Connection → Wisp**. The reader carries only the four tags such a list is made of -
compound, list, string and byte - so a file holding anything else takes the same *not added* path
instead of being rewritten by a reader that has not proved it understands it. A server the list already has is never duplicated: an entry that
names it in an older mode (`wss://`, `java://`, or the typed name before the SRV target was known) is
switched to the Wisp shape, keeping the player's name, hidden flag and icon; an entry that is
already that Wisp row just reports itself.

The writer lives in `index.html`, between the `<server-list>` markers, and runs before
`location.replace("play.html")`. That is the whole point of the move: this branch ships `play.html`
as the *output* of a build, so a writer edited into it is dropped by the next rebuild — it used to be
six anchored patches in `tools/build-single-file.mjs`, and both are gone, so the generated page needs
no patch at all. The launcher reuses the client page's SRV cache (`wispcraft_srv_cache`, same shape
and six-hour TTL) and the same database guards, so the answer and the file it writes are the ones the
client is about to read. `test/servers-dat.test.mjs` cuts the block out of the launcher and drives it
against files shaped like the client's own: exact round trip, one row added with the client's rows
byte-identical beside it, an older row switched instead of duplicated, and a file that does not round
trip left alone. `tools/walk-picker.mjs` is the browser half of that proof: on a fresh profile it
boots the client until its filesystem exists, clicks **Play** on BlocksMC, checks the note and the row
it finds by reading `servers.dat` back out of the client's database, then drives Multiplayer -> row ->
Join and saves a frame for each step (the canvas menus cannot be asserted, so those frames are for
eyes). Its `--check` mode is what CI runs: the picker's elements, the four notes, the Wisp row shape
and the one database both pages use, so a launcher edit that would strand the walk fails a push
instead of being noticed months later.

## The launcher inside `play.html` (`?servers=1`)

`play.html` is the whole client: the built bundle, both payloads, and the launcher above. Opened
with no query it boots straight into the game; `play.html?servers=1` shows the same picker as
`index.html`, writes the picked row, and then starts the client **in that document** instead of
loading a second page.

The launcher is still authored in `index.html` - between the `<picker>`, `<picker-style>`, `<relay-probe>`
and `<server-list>` markers - and `tools/build-single-file.mjs` lifts it into the page, so there is
one copy of the picker, its styles and the writer, and a launcher fix needs no second edit. The build
also holds the client's shell module as text (`<script type="text/plain" id="eagler-single-file-start">`)
and inserts it only when the launcher hands over, which `handoff()` does through
`window.__eaglerSingleFileHandoff` when that exists. The order matters twice over: the row has to be
in `servers.dat` before the client reads that list, and the client's own splash and Wispcraft panels
already sit at `z-index` 2147483646/7, so a picker pinned under them would be unclickable. Holding
the start settles both, and costs what the two-page build already pays by loading `play.html` after
the write.

The picker is a `<dialog>` opened with `showModal()` - and closed when the launcher clears its `on`
class, or on hand-off - because the top layer is the only place above those client panels. Its last
note is copied onto the splash, since the panel is gone by then. Verified in Chrome from a fresh
profile: `play.html?servers=1` -> picker over the splash -> **Play** on BlocksMC -> note -> client
boots -> Multiplayer lists `ccc.blocksmc.com` (475/10000, live BlocksMC MOTD) -> **Join Server** ->
in world; a plain `play.html` still boots directly.

## What is *not* in the bundle

These survive a `wispcraft.js` swap and need no re-patching:

- relay list, probing and pre-flight (`index.html`, one self-contained file — the module sits
  between the `<relay-probe>` markers so `tools/relay-source.mjs` can hand it to the tests);
- auto sign-in overlay: raises the Wispcraft panel above the loader, opens Settings, clicks
  *Add an account*, and reloads once when an account appears (`play.html`, head script);
- signed-in identity pinning (`play.html`, head script) - see below;
- EPK extraction, the disabled inline-asset path and the removed sounds payload (`play.html`).

A swapped bundle still has to be wired the same way in `play.html`: `./wispcraft.js` as a head
script **before** the inline payload scripts, with the auto sign-in script after it.

## Expired tokens (`play.html` head script)

The Minecraft access token this bundle obtains lives **24 hours**, and the bundle stores no refresh
token and never renews one. Nothing in the client notices, so a browser stays "signed in" for days
while every online-mode server rejects it - Hypixel answers *"you need a Microsoft authenticated
account"*, which reads like the Microsoft account is missing even though the name and skin are the
player's own.

`tokenFresh()` decodes the stored token's `exp` and the head script treats an expired one (or one
expiring within a minute) as **not signed in**: `signedIn()` now requires a usable token, so the boot
branch falls through to the sign-in panel, which opens itself and requests a device code exactly as
it does for a browser with no account. A token without an `exp` claim is trusted. `lastAccount()`
also prefers a valid entry for the same username, because signing in again adds a second entry for
the name and the expired one can still be last-used.

`index.html`'s relay pre-flight uses the same rule: an expired token does not count as an account,
so a signed-out-but-stale browser is given a relay that can complete the Microsoft handshake.
Verified on a local build: expired token → panel opens with a code, fresh token → no panel, no
account → panel opens; the client still boots to its menu behind the panel in every case.

## Java servers without the `java://` prefix (`play.html` head script)

Direct Connection offers only `wss://` and `ws://`; `java://` hides behind its **Wisp** mode button.
A real Java server typed in the other modes is therefore dialled as `wss://minemen.club`, which no
Minecraft server answers - the socket drops, and the client reports it in the same words a stale
token produces, which is why it reads as an auth problem.

`javaAddress()` recognises a known Java host (`hypixel.net`, `minemen.club`, `cubecraft.net`,
`2b2t.org`, subdomains included) with no path and no query, and `play.html?server=minemen.club`
turns it into `java://minemen.club` and says so: the player is told that entering the host and
picking **Wisp** is what routes it through the wisp relay.

The entry itself cannot be created for them. The client keeps its server list in its own filesystem
database (not localStorage, and not in the IndexedDB stores this page can see), and once it starts
its networking runs in a blob worker - the initiator stack of a connection attempt is an inline
script plus wasm frames, and the page's WebSocket proxy never sees it, so neither the launcher nor
the bundled `wispcraft.js` can rewrite the address as it is dialled. What the launcher *can* do is
state the one step that works, and for a shared link to open on it.

Verified: `_minecraft._tcp.minemen.club` is `geo.minemen.club:25565`, and a Minecraft status ping
through `wss://truffled.lol/wisp/` answers as Minemen Club (1200+ players), so the relay path itself
is sound; in Wisp mode the client opens the relay socket and no `wss://minemen.club` attempt at all.

## Signed-in identity pinning (`play.html` head script)

The client keeps the launch identity in two places, and both have to agree before it boots or a
generated `Guest_xxxxxx` shows up on screen:

- `_eaglercraftX.username` - base64 display name;
- `_eaglercraftX.p` - the client's serialized profile blob. Its `username` field is the bytes
  `08 00 08 "username" <u16 length> <text>`; the profile editor renders that field, and if the
  blob is missing the client invents a guest profile **in memory** (nothing is stored, so a
  storage-level pin cannot intercept it).

`installPin()` wraps `Storage.prototype.setItem` so no write can store a `Guest_` name into
`_eaglercraftX.username`, and `fixProfileBlob()` rewrites the `username` field of every stored
profile blob with a corrected length prefix. `seedAuthstore()` also lays down a complete profile
with `buildProfile()` when none exists, using the same bytes the client writes itself, so the
first boot of a signed-in account goes straight to the real name. `buildProfile()` is verified
byte-for-byte against a blob produced by the client.

Do not hand-write extra fields into the blob: the client silently **replaces** a profile it cannot
parse with a fresh guest profile, which is exactly the state this pinning exists to prevent.

### The Player Skin picker (`play.html` head script)

The picker lists the client's local presets (Developer Steve, Mooshroom, Tennis Alex, ...) plus the
custom skins stored in the profile blob. It is never fed from the Mojang profile, so a signed-in
player used to open the editor on a stock preset even though the client draws their real skin in
the world.

`seedAccountSkin()` puts the account's own skin into that picker. The blob's `skins` field is a
standard NBT list of compounds:

```
skins     09 "skins" <elemType 0a> <int32 count> <compound>...
compound  08 "name"  <u16 len> <text>
          07 "data"  <int32 16384> <16384 bytes: A,R,G,B - alpha first>
          01 "model" <0 classic | 1 slim>
```

written in that field order (the order the client itself writes), with `presetSkin` = -1 and
`customSkin` = the index of the entry. The pixels come from `skins[0].url` in the profile API and
are decoded through a canvas; canvas hands back R,G,B,A, so the channels are reordered to the ARGB
the client expects (a straight copy renders a blue skin red). The texture keeps its own scheme when
the page is http (a local server) and is forced to https on the https site, because the API hands
out http texture URLs and those would be mixed content there. A legacy 64x32 skin is completed to
64x64 first, using the same region copies and mirrored limbs as the client's own
`SkinConverter.convert64x32to64x64`, so old skins are not left out. The texture is fetched once and written straight into the blob; nothing else is kept. The client
also keeps the list when it saves the profile itself: a save through its own editor round-trips the
skin (its `model` byte followed the editor's choice) and re-serialises to the same bytes, so seeding
finds a profile that already has a skin, writes nothing, fetches nothing and does not reload. If the
client ever dropped the list, every boot would fetch and reload again, which is why that round-trip
is part of what the seeding depends on. `profileHasSkin()` reads the skins list's element type
(`0` = empty); testing the following count byte instead is a trap, because its high byte is `0` for
any count below 256, which makes a skinned profile look empty.

Tradeoffs, in order of importance:

- the profile now holds a **snapshot** of the pixels, so a skin changed on Mojang's side appears on
  a later boot (once the profile cache refreshes), not immediately;
- the first boot for a new skin reloads once, because the client reads the profile before the
  texture download can finish; the client keeps the list when it saves, so it does not repeat;
- legacy 64x32 skins are converted rather than skipped: the missing second half is built from the
  same region copies the client performs, so those accounts get their skin and the same limbs the
  client would have drawn;
- if the texture cannot be fetched (offline, blocked) nothing is written and the editor opens on a
  preset, exactly as before;
- seeding only runs while the profile has no skin entries at all, so any skin the player picks in
  the editor stays picked;
- it also changes what servers receive: the player now wears the custom skin instead of a preset,
  which is the intent for an account that owns that skin.

## Session join through the relay

`sessionserver.mojang.com/session/minecraft/join` sends no CORS headers, so a page cannot POST to it
and every online-mode join died with *"Failed to log in: Could not reach Minecraft session
authentication."* Faking the 204 locally is not an option - the server calls `hasJoined` and would
answer "Failed to verify username" - so the request has to leave the page.

The bundle already ships an epoxy client (`class NA`, wasm) that speaks HTTPS **through the wisp
relay**: `epoxyclient_fetch`, reached by every `LA(...)` call, which is how the Microsoft device-code
endpoint works from a page at all. `tools/patch-wispcraft.mjs` patch 3 publishes that client on the
launcher namespace:

```js
A.wispUrl = void 0;
A.fetchViaRelay = function (u, i) { return LA(u, i); };
```

and the head script's `window.fetch` shim hands `sessionserver.mojang.com/session/minecraft/*` to it.
The access token therefore travels browser -> wisp relay -> Mojang: no third-party proxy, no token in
a URL, nothing hosted for this.

That export is **self-healing**: the epoxy client builds its wisp multiplexor once at boot, and when
the relay drops it every later request fails in about a millisecond with
`hyper_util::client::legacy::Error(Connect, Wisp(MuxTaskEnded))`. That is what turned a join which
had already reached Minemen's encryption request into "Could not reach Minecraft session
authentication". Patch 7 rebuilds the client exactly the way the settings UI does
(`<ready> = new Promise(...)`, `JA(wispUrl)`, `replace_stream_provider()`) and retries once:

```js
A.fetchViaRelay = async function (u, i) {
  try { return await LA(u, i) } catch (e) {
    var m = String((e && e.message) || e);
    if (/MuxTaskEnded|Multiplexor task ended/.test(m)) { await A.repairRelay(); return await LA(u, i) }
    throw e
  }
};
```

Two related facts recorded while chasing the same failure:

- `api.minecraftservices.com/minecraft/profile` is also CORS-blocked; the shim answers it from
  `wispcraft_profile_cache` (written during sign-in) instead of letting the client conclude the
  account is unusable ("Wispcraft account is not ready").
- Java hosts are SRV-only often enough that the bare domain is unusable: `_minecraft._tcp.minemen.club`
  -> `geo.minemen.club:25565`. `resolveSrv()` in the head script asks DNS-over-HTTPS (Cloudflare,
  falling back to Google), caches for six hours, and `addJavaServer`/`?server=` name the SRV target.

## Joining a Java server without touching its entry

Three separate things had to line up, and each one was measured before it was believed:

1. **SRV before the relay dials** (patch 4). The bundle's `forward()` resolved `_minecraft._tcp.<host>`
   with a fetch through its own epoxy client, so a dead multiplexor silently downgraded the dial to
   the bare domain and the relay answered `Wisp destination connection timed out (code 1006)`. It now
   asks `window.wispcraftResolveSrv` first and keeps the upstream lookup as a fallback.
   That covers the sockets the bundle creates, but not the one a join actually uses. Measured in
   `play.html`, the client's wisp socket comes from its own reference to the native `WebSocket`:
   replacing `window.WebSocket` saw no socket at all during a join, while every frame still passes
   through `WebSocket.prototype.send`, and the bundle's `java://` stream class was never entered. So
   the page owns the same step for the real path - `send()` recognises the wisp CONNECT a join opens
   with (`01 [stream] [tcp] [port] "host"`), holds that one frame for the `_minecraft._tcp` answer,
   and puts the record's target on the wire before the frames queued behind it; a lookup that has not
   answered in 2.5 s releases the frame unchanged. Measured in the client: joining `minemen.club`
   logs `[wispcraft] srv minemen.club -> geo.minemen.club` and reaches Minemen's login stage, which
   then reports that the server requires a Microsoft-authenticated account. Two more servers confirm
   it is the record and not that one server: `blocksmc.com` -> `ccc.blocksmc.com` joins all the way
   into the world, and `pika-network.net` -> `pika-network_net.pika.host` reaches Pika's own login
   denial (its egress IP rule), both with the same one-line log note.

   Because the hook lives in the page - which is a rebuilt artifact - it is re-applied the same way
   the bundle patches are: `tools/patch-play-srv-hook.mjs` holds the hook text, inserts it after the
   `window.wispcraftNote` line, replaces an older copy, and `--check` fails if a rebuild dropped it
   or left a different version. `test/play-srv-hook.test.mjs` drives the shipped page's hook and also
   runs that `--check`, so a rebuild that loses the hook fails a test instead of a join.
2. **Transport** (patch 5, and the row below). Quick Play hands the host to the client as a plain
   address, and the client dials `wss://<host>` - an EaglerX socket no Java server answers
   ("connection dropped without a WebSocket close frame (code 1006)"). The game's networking runs in
   a wasm worker, so a page-level socket rewrite cannot move it: patch 5 still routes a matching
   `wss://` into the Wisp stream for anything that does go through the page proxy. What actually
   reaches a Java server is the client's own Wisp mode, so the launcher writes that row into
   `servers.dat` before it hands the tab over (see *The picked server as a row*) instead of supplying
   an entry through `eaglercraftXOpts`. Patch 6 is still in the bundle, but nothing publishes
   `window.wispcraftJavaEntry` any more, so it appends nothing and prints nothing - measured, a
   `java://` entry supplied that way was dialled as `ws://java//…` (native
   `ERR_NAME_NOT_RESOLVED`), so the only row it produced could not join.
3. **The parameter itself.** The launcher hands over a plain `play.html`, so a pick never travels in
   the URL and the client's EaglerX quick play is not armed alongside the Wisp row. `?server=<host>`
   still exists on the page (`play.html?server=minemen.club` resolves the record, publishes
   `java://<srv target>:<port>` and drops the query with `history.replaceState`), but nothing in the
   launcher produces one.

What this cannot do: the row has to be in place before the client boots, so a browser that has never
run the client has no filesystem to write into - that visit is told the address to paste into
**Direct Connection → Wisp**, and the pick is remembered so the next launch adds the row. An older
entry for the same server is *rewritten* by the same pass (bare domain, `wss://` or `java://` all
become the Wisp row), so no hand editing is needed.
## Relay failover: switching at run time, checking the join (patches 8 and 9, `play.html`)

`index.html` proves a relay can reach `example.com` and Microsoft, which says nothing about the game
server: a relay that passes its launch test can still answer `Wisp destination host could not be
reached (code 1006)` for the address being joined. The launcher therefore checks the target itself -
a real Wisp stream to the server address plus a status handshake, which every Java server answers.

That check belongs to a **join**, not to a ping. The Multiplayer screen pings every entry in the list
to draw its MOTD, and a ping sweep must not probe relays or move the session: it would test servers
nobody is joining and could switch the relay under a list that is only being drawn. Patch 9 draws
that line (point 2 below), and patch 8 refuses a switch that would rebuild the client while other
connections are still opening (point 1).

Three things had to change for that check to be worth anything:

1. **A switch is not a storage write.** The bundle resolves its relay once
   (`A.wispUrl = ... || localStorage.wispcraft_wispurl || OI`) and builds the epoxy client - and the
   multiplexor the join dials through - from that value, so writing the key afterwards left the live
   client on the old relay. That is how a "switched" relay still failed with 1006. Patch 8 publishes
   the sequence the settings picker already uses (rebuild the client, then
   `replace_stream_provider()`) as `window.wispcraft.switchRelay(url)`. It is serialised, so two
   switches cannot swap clients under each other, and it returns the address the client now dials -
   or `ok:false` with a reason, which the page reports instead of assuming the switch took.
   It also owns a connect gate. A rebuild swaps the stream provider under every socket the client
   has open, and a Multiplayer ping sweep is a burst of them, so `switchRelay` first waits for the
   connections that are still opening and holds new ones back while it rebuilds. If they have not
   finished after 6 s it refuses with `ok:false, why:"other connections are still opening"`
   instead of pulling the provider out from under them; the page reports that and leaves the relay
   alone.
2. **Only the join is checked.** A ping and a join arrive as the same `java://` socket and are
   indistinguishable until the client's first frame: a status ping sends the string `accept: motd`,
   a join sends its binary handshake. Patch 9 therefore dispatches `open` first (in a microtask: the
   bundle's WebSocket proxy calls `start()` inside its constructor, so a synchronous dispatch would
   reach nobody and the client would never send a frame), defers `connect_tcp`
   until that first frame has arrived, and awaits `window.wispcraftEnsureRelayReaches(host, port)`
   only for a join - for the address actually being dialed, after SRV. A ping dials the relay as it
   always did, with no probe and no switch. The deferred dial is what keeps the order right: the
   reach check and any switch complete before the join's TCP stream is opened, and the dial itself is
   bracketed by the gate above, so a switch can neither rebuild mid-connect nor start while the
   join's own connection is being opened.
   Because `open` is dispatched before the dial, a dial that fails would otherwise leave the join
   waiting on a socket that looks connected and never answers. `forward()` now catches the failed
   `connect_tcp`, notes the address and the relay's reason, and calls back into the socket, which
   aborts its outbound stream and dispatches `error` then `close` - the same ending a real socket
   gives for a refused connection.
   Both waits are now bounded. The first-frame wait is 4 s (`window.wispcraftFrameTimeout`) and
   treats a socket that never sends as a join. The dial races a 15 s timer
   (`window.wispcraftDialTimeout`): a relay that accepts the stream and then never answers leaves
   `connect_tcp` pending forever - measured live, a stream to a closed loopback port was still at
   `open` after 25 s - so a timed-out dial takes the same `error` then `close` path. (For the same reason the open callback has to run *before* the
   `try` that resolves SRV: that block declares `const A = await LA(...)`, so calling `A()` inside it
   throws into the SRV catch and the event would never fire at all.)
   A dial that succeeds is still not a connection. `connect_tcp` only says the relay took the
   stream; the target is dialled behind it, so a server that refuses or drops that stream fails
   *after* `open` has been dispatched. The bundle wired the connected stream into two detached
   `for(;;)` loops and dropped both promises, so that failure arrived as an unhandled rejection
   while the socket stayed at `open` - the join waited forever with no error and no close. Patch 10
   routes the failure where the dial failure goes: a stream that rejects *or ends*, the
   connected-stream setup throwing, and the socket's own outbound read loop throwing all note the
   reason and end the socket with `error` then `close` (a close that has already happened is not
   repeated). Both view loops had to be covered, because the relay's side of the stream and the
   client's own side fail independently. `test/java-stream.test.mjs` drives all four paths on the
   shipped classes and also asserts that none of them leaves an unhandled rejection behind.
   Not every ending is a failure, and patch 11 draws that line. A stream that simply **ends** - the
   relay or the server closing its side, which is what the ordinary end of a session and a target the
   relay cannot reach both look like - is no longer reported as an error: it is one `close`, with no
   failure note, exactly as before patch 10 for a socket that had never opened. It still leaves one
   plain note in the launcher log, `java stream ended for <host:port> (closed with no relay error)`,
   so a join that dies this way names the address it was dialling instead of ending in silence; the
   note is skipped when the socket was already closed (the game hung up, or another path has already
   reported), so it is exactly one line for one unexpected end. And the game's own
   `close()` used to send no event at all (it only flipped `readyState`, so a client waiting for the
   close event never got one); it now sends that one `close` too. Both paths mark the socket quiet
   first, so the read loops that are still running wind up without a second event or a note, and a
   socket that is already closed is never closed again. Only a stream that *throws* keeps the
   `error` then `close` ending, which is what patch 10 exists for. Measured on the shipped bundle in
   Chromium through `wss://truffled.lol/wisp/` with `java://127.0.0.1:9` (a target the relay accepts
   the stream for and then cannot reach): `open@3 ms, close@171 ms`, no `error`, no note, readyState
   3 - previously `open, error@175, close@175` plus the failure note. A reachable target closed from
   the page (`java://geo.minemen.club:25565`, `close()` at 5 s) gives `open@3 ms, close@5008 ms`, also
   with no error and no note.
   The page does not probe at boot either: the earlier version probed the first repaired entry on
   every visit (its `pairs` reference was undefined, so it threw into the repair catch) and its
   fallback opened eight sockets at third-party relays in parallel.
3. **Sequential, bounded, ordered.** A failed relay costs one 2.5 s probe; then candidates are tried
   one at a time, at most four, stopping at the first that answers. Relays that answered before go
   first (`wispcraft_relay_good`). Verdicts are cached per target for 10 minutes and keyed to the
   relay, so a second join of the same server on the same relay costs no new socket, and two
   concurrent checks for the same target share one sweep.

Measured live (2026-11-22), with the earlier form of patch 9 that checked at every dial: with
`wispcraft_wispurl` pointed at `wss://us-east.wisp.q13x.com/` (a relay that no longer carries
traffic), the client's own `java://geo.minemen.club:25565` socket switched to
`wss://truffled.lol/wisp/` before connecting - the console printed
`relay us-east.wisp.q13x.com could not reach geo.minemen.club:25565, switched to truffled.lol - the
client dials truffled.lol`, `window.wispcraft.wispUrl` changed with it, and the relay socket opened on the
replacement. That run exercised the switch and the wiring, not the new split: patch 9 now asks for the
check only after a join's first frame, which `test/relay-failover.test.mjs` pins without a browser
(one probe at a time, early stop, the switch call, the refused-switch path, the cache, and the bundle
markers for the deferred dial, the join-only guard and the connect gate), and which
`test/java-stream.test.mjs` drives end to end on the patched classes (a ping is never probed, a join
is, and a failed dial ends in `error` then `close`).


One trap found on the way: the bundle replaces `window.WebSocket` with a proxy that hands a
non-current relay address to its EaglerX wrapper, which retries `wss` -> `ws` -> EaglerX and swallows
the first reply, so a probe built on `window.WebSocket` marks every candidate dead - `truffled.lol`
timed out at 4.3 s through the proxy and answered `geo.minemen.club:25565` in 154 ms through a
pristine constructor. `probeTarget()` therefore takes the constructor from a hidden same-origin
iframe, where the page has not replaced it.

While testing this, the boot-time repair turned out to crash a **fresh** profile: opening the client
database with `indexedDB.open(name)` and no version creates it empty, and the client then finds no
`filesystem` object store and dies at *Initializing game* with *One of the specified object stores
was not found*. `repairSavedServers()` now checks `indexedDB.databases()` before opening, and deletes
an empty shell it ever lands on, so a first visit boots.
