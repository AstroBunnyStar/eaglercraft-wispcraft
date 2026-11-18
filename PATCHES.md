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
value `relays.js` exports as `DEFAULT`, which the tool now reads from that file — so a replaced
bundle cannot quietly fall back to a different relay than the launcher shows, and `--check` works
without passing the value again. `--default-relay` still overrides it when patching a copy that
belongs to some other launcher. The constant's identifier is discovered from the expression, because
minifiers rename it between builds.

## Relay default

`relays.js` ships a fixed `DEFAULT` (`wss://linuxontab-net.fly.dev/wisp/`) instead of probing on
every launch, because the probe is the wrong tool for choosing the first relay:

- a fixed default starts the game immediately on a first visit, with no 22-relay sweep first;
- Play already tests the saved relay with a real proxied request and, only when that fails, sweeps
  the list and switches to the fastest relay that carries traffic — so a bad default costs one
  failed test, not a stuck page;
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

**Play** tests the saved relay once; if that fails it sweeps the whole list in parallel and switches
to the fastest relay that carried the test request. **Check relays** runs the same sweep on demand.
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
lengths and the `login.microsoftonline.com` server name, so the constant cannot rot unnoticed. `probe()` reports `ok`
(carried the test request) and `signin` (completed the sign-in handshake) separately: a relay that
fails `signin` can still play, but it strands anyone who is not signed in yet. **Play** therefore
prefers `signin` relays while the browser has no saved account, and the relay list labels the ones
that cannot sign in. `us-east.wisp.q13x.com` is the case this exists for: its sign-in stream closed
while its plain-HTTP test still answered on some sweeps.

To refresh: probe from a browser (the launcher's **Check relays** now runs both tests), update
`DEFAULT` in `relays.js`, then run `node tools/patch-wispcraft.mjs` so the bundle follows.

Note this is only the last-resort fallback: in normal use the launcher's **Play** pre-flight writes
the chosen relay into `localStorage`, and the in-game override is **Wisp Settings → Wisp Server**.
The launcher default and the bundle fallback both come from `DEFAULT` in `relays.js`, which is the one
place to change.

## What is *not* in the bundle

These survive a `wispcraft.js` swap and need no re-patching:

- relay list, probing and pre-flight (`relays.js` + `index.html`);
- auto sign-in overlay: raises the Wispcraft panel above the loader, opens Settings, clicks
  *Add an account*, and reloads once when an account appears (`play.html`, head script);
- signed-in identity pinning (`play.html`, head script) - see below;
- EPK extraction, the disabled inline-asset path and the removed sounds payload (`play.html`).

A swapped bundle still has to be wired the same way in `play.html`: `./wispcraft.js` as a head
script **before** the inline payload scripts, with the auto sign-in script after it.

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
