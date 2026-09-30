# Working in this repo

## Release discipline — read the exit code, not the output

On 2026-09-30 production was down for hours. A syntax error in an inline `<script>` in
`public/index.html` meant the SPA rendered nothing: no nav, no pages, no data. `/health` returned 200
with `db: connected` the whole time and the container logs were **empty**, because a client-side parse
error leaves no server trace. Every monitor was green.

The checker that catches it already existed. It was run as `node spa-check.js | tail -1` — block 1 said
`Unexpected identifier 'outreachPage'`, block 6 said `OK`, and `tail -1` showed the `OK`. Later the same
day a commit went out with nine failing tests, because the suite and `git push` were one `&&` chain and
again only the last line was read.

**The rule, in order:**

1. **A checker's verdict is its exit status.** Every script under `scripts/` that verifies something exits
   non-zero on failure. Read `$?`. A multi-line report is diagnostics; the exit code is the answer.
2. **Never pipe a verification through `head`, `tail`, or `grep` and treat what you see as the result.**
   If you must filter output, run the command again bare, or check `${PIPESTATUS[0]}`.
3. **Never chain a verification and a push in one command.** No `test && push`, no `preflight && push`.
   The push is a separate decision, made after reading the result.

```sh
scripts/preflight.sh          # suite + SPA parse + nav parity. exit 0 = safe to push
echo $?                       # read it
git push                      # separate command, separate decision
scripts/smoke-deployed.sh     # separate command: is the APPLICATION alive, not just the server
echo $?
```

## The two checks that exist because of that outage

- **`scripts/check-spa-parse.js`** — parses every inline script in `public/index.html` and asserts the
  app's entry points are present (`API`, the load listener, `checkAuth`, `buildNav`, `pages`). Takes
  `--url` to check the **deployed** page, which a unit test cannot reach. Exit 1 on any failure.
  Mirrored as `src/lib/spa-parses.test.js` so it also runs on every commit.
- **`scripts/smoke-deployed.sh`** — waits for the expected commit (`wait-for-deploy.sh`), then checks
  `/health`, then parses the deployed page, then confirms `/api/auth/me` 401s anonymously. **`/health`
  proves the server is alive; this proves the application is.**

## Deploys

Push to `main` auto-deploys on Railway. `/health` returns the deployed commit
(`RAILWAY_GIT_COMMIT_SHA`), so `scripts/wait-for-deploy.sh [sha]` is exact — do not use uptime as a
readiness signal, because the container from the *previous* deploy also has a low uptime.

## public/index.html

One file, several inline `<script>` blocks, no build step. It is the whole front end.

- **Never** do a multi-occurrence `str.replace` on it. Anchor every edit uniquely.
- A function used by an inline `onclick` must be reachable from the global scope. Annex B hoists a plain
  `function` out of a block but **not** an `async function` — assign those as `window.name = async
  function name(...)`. A block-scoped async handler throws `ReferenceError` on click and does nothing
  visible.
- `const pages = { ... }` is an object literal. Declare page functions **before** it and attach with
  `pages['x'] = fn`. A `function` declaration inside the literal is a syntax error that kills the app.

## Verifying against production

`railway ssh 'node scripts/<name>.js'`. The live `verify-*.js` scripts are self-cleaning: they create
fixtures, assert, delete in a `finally`, and report leaks. They all exit non-zero on failure.
