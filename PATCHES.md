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

The bundle reads `localStorage.wispcraft_wispurl || <CONST>`. The patch pins `<CONST>` to
`wss://anura.pro/`, the same default that `relays.js` exposes as `DEFAULT`, so a replaced bundle
cannot quietly fall back to a different relay than the launcher shows. The constant's identifier is
discovered from that expression, because minifiers rename it between builds.

Note this is only the last-resort fallback: in normal use the launcher's **Play** pre-flight writes
the chosen relay into `localStorage`, and the in-game override is **Wisp Settings → Wisp Server**.
If you change the default here, change `DEFAULT` in `relays.js` too.

## What is *not* in the bundle

These survive a `wispcraft.js` swap and need no re-patching:

- relay list, probing and pre-flight (`relays.js` + `index.html`);
- auto sign-in overlay: raises the Wispcraft panel above the loader, opens Settings, clicks
  *Add an account*, and reloads once when an account appears (`play.html`, head script);
- EPK extraction, the disabled inline-asset path and the removed sounds payload (`play.html`).

A swapped bundle still has to be wired the same way in `play.html`: `./wispcraft.js` as a head
script **before** the inline payload scripts, with the auto sign-in script after it.
