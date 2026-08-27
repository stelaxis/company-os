# Book Gatekeeper

Read-only access to a directory of a Git repository, mirrored on a schedule and served to agents as
a searchable document set. Built from `packages/custom-gatekeeper`, which remains the minimal
example to copy.

## What it does

A cron trigger fires every five minutes and asks GitHub for the branch head. When the sha is
unchanged — the common case — that one request is the whole tick. When it moves, the gatekeeper
walks the tree, re-reads only the blobs whose sha changed, drops documents that disappeared, and
records the new commit.

Agents see `BookSession`: `listDocuments`, `readDocument`, `search`, and `getStatus`. Every call
that returns document content records an observation first. There is no write path — the session
holds a reader over the mirror, and the only code that writes is reached from the scheduled handler.

## Why the GitHub API instead of a clone

`gatekeeper-context` mirrors Git with `isomorphic-git`, which suits the small purpose-built
Artifacts repositories it creates. A large monorepo is a different problem: the repository this was
built for carries 1,196 commits and an 86 MB `.git`, past the 64 MB packed ceiling upstream's clone
path works under, and even `depth: 1` would transfer a 21.7 MB tree to reach roughly 250 KB of
markdown.

The Trees API returns a sha per blob, which is what makes both the cheap poll and the incremental
re-read possible.

## Two Durable Objects, and why

`BookMirrorStore` holds the mirror. `BookGatekeeper` holds nothing and reads through it.

They are separate because their lifetimes are. The Workshop instantiates a gatekeeper as a **facet
of each workspace's Overseer Durable Object** (`overseer.ts` `getGatekeeperFacet`) — one per
workspace — while the scheduled handler syncs exactly one store, reached by name. Folding both into
a single class gives every workspace its own empty SQLite storage, so `env.BOOK.getStatus()`
answers nulls from a chat while the management app, which reads the named instance, shows a full
mirror. That was a real bug, not a hypothetical.

Everything that touches the mirror goes through `mirrorStore(exports)`; nothing else reads
`ctx.storage`.

## Configure

Repository coordinates come from `deployment.jsonc` and are written into the Worker's vars by
`scripts/deploy.ts`:

```jsonc
"book": {
  "displayName": "Stelaxis Book",
  "repo": { "owner": "stelaxis", "name": "stelaxis", "branch": "main", "path": "docs/book" }
}
```

The credential is a secret, never a tracked value:

```sh
pnpm exec wrangler secret put GITHUB_TOKEN --name <book worker name>
```

Use a fine-grained token limited to **Contents: Read** on that one repository. A public repository
needs no token for reads, but the secret is declared `required` either way so a Worker whose first
tick would fail on a missing credential is refused at deploy time rather than discovered later.

The five-minute cadence lives in `wrangler.jsonc` under `triggers.crons`, not in `deployment.jsonc`:
it is a property of the mirror rather than of the deployment.

## What gets mirrored

Text files only, by extension allowlist — `md`, `markdown`, `txt`, `toml`, `yaml`, `yml`, `json`,
`csv`. Everything else is skipped and logged, which is how the 2.6 MB `mermaid.min.js` beside the
book source stays out. Individual files above `MAX_DOCUMENT_BODY_BYTES` (1.4 MB, upstream's own
ceiling) are skipped without failing the sync.

Document paths are relative to the mirrored directory, so `docs/book/src/edge.md` is addressed as
`src/edge.md`.

## Management UI

The account exposes a full-page app (`providesUi` + `startAppUi`), reachable from the Workshop nav.
It shows the mirrored commit, the document count, when the last sync succeeded, any error from the
last attempt, and the document list. Administrators also get a **Refresh now** button.

`refresh()` lives on `BookAdminApi`, not on `BookSession`. That separation is the read-only
guarantee: an agent holds a session and cannot name `refresh()`; a signed-in user reaching the app
can. The admin check is enforced in `BookAdminApiImpl.refresh()` rather than only by hiding the
button — the capability is reachable from the iframe, so a UI that merely omits a control is not an
authorization boundary.

The app is built by `build:app` into `src/generated/app.txt` and imported as a string. Single-file
is required, not preferred: the Workshop hosts it in a `sandbox="allow-scripts"` opaque-origin
iframe with nothing but the HTML, so there is no origin to fetch a second asset from. It is plain
DOM rather than React — unlike the Context Library and Scheduler apps, which render file managers
and schedule editors — which keeps the inlined bundle around 59 KiB.

```sh
# `build:app` is a Vite+ task, not a package.json script: vp forbids a task and a script
# sharing a name, and `deploy.ts` drives the task.
pnpm exec vp run build:app
```

## Observer policy

`BookVerifier.verify()` accepts every observer. That is defensible only while the mirrored directory
is uniform in sensitivity and the deployment is gated — under Cloudflare Access an observer is
already someone entitled to read the book.

Widening the mirrored path changes that calculation. Third-party material under redistribution
terms, customer data, or anything not safe for every signed-in user needs a real check at this
boundary **before** it is mirrored, not after.

## Operate

`getStatus()` reports the mirrored commit, the document count, the last successful sync, and the
last error. A failed attempt leaves the previous documents readable and records the error; it does
not empty the mirror.

Sync events are structured logs on the Worker: `book.sync.updated`, `book.sync.unchanged`,
`book.sync.skipped`, `book.sync.failed`.

## Run it locally

The unit tests need no network and no credentials — the GitHub endpoints are stubbed:

```sh
pnpm run test:run
```

To exercise the real sync, put a token in `.dev.vars` (gitignored — it is a real credential) and
start the Worker with the scheduled endpoint enabled:

```sh
printf 'GITHUB_TOKEN=%s\n' "$(gh auth token)" > .dev.vars
pnpm exec wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Each tick logs one structured line. The first reads every blob; later ticks on an unchanged head
read none:

```json
{"event":"book.sync.updated","commitSha":"91684b87...","documentCount":39,"fetched":39,"skipped":3}
{"event":"book.sync.unchanged","commitSha":"91684b87...","documentCount":39,"fetched":0,"skipped":0}
```

The mirror is a SQLite-backed Durable Object, so its contents can be read straight off disk:

```sh
sqlite3 .wrangler/state/v3/do/gatekeeper-book-BookGatekeeper/*.sqlite \
  "select key from _cf_KV where key like 'doc:%' order by key;"
```

Values are V8-serialized, so they do not read as plain text there; the keys are enough to confirm
what was mirrored and at what paths.

Note that `index.ts` re-exports `book.ts` wholesale, and workerd requires every named export of the
entry module to be a function or an ExportedHandler. Adding a constant to `book.ts` breaks startup
with a type error that neither the unit tests nor `wrangler deploy --dry-run` catch — only
`wrangler dev` or a real deploy does. Constants belong in `constants.ts`.

## Check

```sh
pnpm run test:run
pnpm run types:check
pnpm exec wrangler deploy --dry-run
```
