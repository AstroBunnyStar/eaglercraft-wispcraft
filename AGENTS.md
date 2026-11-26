# Working in this repository

Two branches, one client in two shapes. **Never create a third branch for a fix** — that is how the
tree drifted before: `single` sat unmerged for weeks, and `main` ended up with an older launcher.

## The branches

| branch | what it is | where it is published |
| --- | --- | --- |
| `main` | separate-files client: `index.html` (launcher) hands the tab to `play.html`, which loads `wispcraft.js`, `assets.epk` and `sounds.epk` beside it | GitHub Pages, https://astrobunnystar.github.io/eaglercraft-wispcraft/, on every push to `main` |
| `single-file` | one-file client: `play.html` is a **build output** (79.9 MB) holding the bundle, both payloads and the launcher | the `eaglercraft.html` asset on the rolling `single-file-client` release, re-uploaded by `.github/workflows/single-file-release.yml` on every push to `single-file` |

## Update both branches in the same piece of work (hard rule)

A change a player can feel — a bug fix, a launcher edit, a patch, a new relay, a doc section about
behaviour — lands on **both** branches before the work is called done. Not "port it later": later is
what produced the current gap.

- Make the edit once, on whichever branch is better to test it, then apply the same edit to the
  other branch in the same session, with a commit that says so.
- After touching the shared launcher or a bundle patch on `single-file`, rebuild the page:
  `node tools/build-single-file.mjs`, then `node tools/patch-play-srv-hook.mjs` if the page came from
  `main`, then `--check` both tools and run `node --test`.
- On `main`, a launcher/bundle change is just the file: Pages redeploys on push.
- Do not "sync" by copying `play.html` between branches: each branch's page is a different shape.

### Files that must stay identical on both branches

`index.html`, `wispcraft.js`, `assets.epk`, `sounds.epk`, `PATCHES.md`, `test/**`,
`tools/check-launcher.mjs`, `tools/make-legacy-fixtures.mjs`, `tools/patch-play-srv-hook.mjs`,
`tools/patch-wispcraft.mjs`, `tools/probe-relay.mjs`, `tools/relay-source.mjs`,
`tools/verify-published.mjs`, `tools/walk-picker.mjs`, `.github/workflows/verify.yml`, `AGENTS.md`.

Because `verify.yml` is shared, it may reference **only** files that exist on both branches.

### Files that differ on purpose

- `play.html` — `main`: the separate-files shell (43.5 MB); `single-file`: the build output
  (79.9 MB). Never hand-edit the built one; edit `main:play.html` and rebuild.
- `tools/build-single-file.mjs` and `.github/workflows/single-file-release.yml` — `single-file`
  only. `main` carries no build step.
- Nothing exists on `main` alone.

## Checks before a push

```bash
node --test                                # the suite, both branches
node tools/check-launcher.mjs              # index.html parses, every local reference resolves
node tools/walk-picker.mjs --check         # the picker ids, notes, row shape and shared database
node tools/patch-wispcraft.mjs --check     # bundle default still matches index.html's DEFAULT
node tools/patch-play-srv-hook.mjs --check # the page still carries the join SRV hook
node tools/build-single-file.mjs --check   # `single-file` only: play.html is this exact build
node tools/verify-published.mjs            # `main` only, after a push: Pages serves this tree
```

The browser halves (`node tools/walk-picker.mjs`, `node tools/probe-relay.mjs`) need the local files
and Chrome; they are for a real change to the picker or the relay code, not for every push.

## Constraints that are not negotiable

- Never read, print, log or commit Microsoft account credentials — not in tooling, notes or test
  fixtures. The account store lives in the client's own storage and is never touched by a script.
- Never delete the client's `wispcraft_accounts` store, and never rewrite the client's filesystem
  database beyond the exact `servers.dat` append the launcher performs.
- `index.html` stays the only writer of `servers.dat`; the single-file page gets that writer by
  being built from it, never by a second copy.
- A join must keep working without hand-editing a server entry: the picker writes the Wisp row, the
  page hook rewrites the SRV CONNECT, and both are covered by tests.
- Keep `tools/walk-picker.mjs --check` passing: it is the contract between the launcher and the walk.

## Where the parity came from (2026-11-26)

The `?servers=1` picker grew on `single-file` while `main` kept an older launcher, so for a while
the published site had no server directory and the download did. Both branches now carry the same
`index.html`, the same tests and the same tools; the drift section that tracked it is gone with the
commit that closed it. The lesson stands: a launcher edit is a shared-file edit, and the page that
is built from it on `single-file` has to be rebuilt in the same session.
