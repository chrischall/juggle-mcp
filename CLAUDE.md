# CLAUDE.md

Guidance for Claude Code working in this repository.

## TL;DR

MCP server for **Juggle** (whyjuggle.com — a babysitting/petsitting
marketplace: families post sits, college-student sitters apply, families
accept). **Family side only.** Cookie-session archetype: the server signs in
with the family's email + password and drives the site's own Laravel routes.
No browser bridge.

**Everything about the upstream is derived from the shipped JS bundle and is
UNVERIFIED against a signed-in account** — see `docs/JUGGLE-API.md` and its
"Live verification checklist". When a live pass confirms or corrects a row,
flip the claim tree-wide (`grep -rniE "unverified|verified" README.md docs/ skills/ src/ tests/`).

## How the site works (and why the client looks like this)

- Laravel + Vue 2, **full page loads**: each page is `<App :server-data="{meta,user,data}">`.
  Asked as XHR (`X-Requested-With: XMLHttpRequest`, `Accept: application/json`),
  a page route answers that same `{meta, user, data}` as JSON. That is the
  read transport: `client.getPage(path, query?)`.
- JSON-only routes (e.g. `/web-api/conversations`) → `client.getJson(path)`.
- Writes → `client.send(method, path, body)`: JSON body plus the headers the
  site's axios sends — `X-CSRF-TOKEN` (latest `meta.csrfToken`) and
  `X-XSRF-TOKEN` (URL-decoded `XSRF-TOKEN` cookie). Juggle reports business
  failures as **HTTP 200 `{error: true, msg}`** — `send` turns those into
  `JuggleApiError`; a 200 is not success until `error` is checked.
- Three ids per person (`accountId`, `profileId`, `userId`) — see the API doc.

## Auth / session (`src/client.ts`)

- Login: `GET /log-in` (CSRF token from the XHR envelope or the HTML meta
  tag, plus `whyjuggle_session` + `XSRF-TOKEN` cookies) → `POST /log-in`
  `{email, password}` → `GET /` to confirm `user` is set and pick up the
  rotated CSRF token (Laravel regenerates it on login).
- `CookieSessionManager` (mcp-utils `/session`): single-flight login, and on an
  expiry signal **exactly one** re-login + replay. Expiry (`looksExpired`) =
  401, 419, a redirect to `/log-in`, or the login page served in place
  (`meta.page === "LogIn"` in JSON or in an HTML page's server-data) — page
  identity, never prose: message bodies are user text.
- A rejected password (`{error:true}` or 422 on `POST /log-in`) and a missing
  config are cached as **permanent** errors — never re-POSTed, so tool calls
  cannot lock the account.
- Deferred config: the client is built once in `index.ts` without throwing;
  missing `JUGGLE_EMAIL`/`JUGGLE_PASSWORD` surfaces on the first tool call, so
  the server still answers `tools/list` with no credentials.
- The password is read with `readEnvVar(..., { trim: false })` and scrubbed
  by value from every error built from an upstream body.
- `JUGGLE_BASE_URL` exists for tests / a local stub only; it must be https
  (loopback http allowed) because the password is sent there.
- Writes: a 5xx or a transport failure after the request went out is
  `WriteOutcomeUnknownError` — never retried; tools should report
  `status: "unknown"` via `writeOrUnknown`.

## Layout

```
src/
  index.ts          # runMcp bootstrap; builds the ONE JuggleClient, loads .env
  client.ts         # JuggleClient: getPage / getJson / send, login, looksExpired
  config.ts         # env → config (deferred error), base-URL validation
  errors.ts         # JuggleCredentialRejectedError / JuggleSessionError / JuggleApiError
  http.ts           # one bounded, no-redirect hop with cookie jar; XHR headers
  page.ts           # {meta,user,data} envelope parsing (JSON or HTML server-data)
  version.ts        # VERSION (release-please marker)
  tools/index.ts    # toolRegistrars — the list index.ts serves and the tests drive
  tools/*.ts        # register<Area>Tools(server, client)
  tools/writes.ts   # the confirm-gated writes (defineWrite + registerWrite)
  tools/write-kit.ts # write annotations, injection rule, sendOnce (writeOrUnknown)
tests/              # vitest; FakeSite in helpers.ts is an in-memory whyjuggle.com
docs/JUGGLE-API.md  # the bundle-derived API map + live verification checklist
```

## Scope (owner decision)

In: family-side reads; confirm-gated writes for post a sit, accept / decline
a sitter, cancel a booking, send a message, favorite / unfavorite, leave a
review. **Out:** anything that moves money (tips, confirm-payment, cancellation
fees, gift cards, subscriptions, payment methods, Stripe), sitter-side and
admin routes. Cancel must never send `cancellationPenalty: "cancellationFee"`.

## Conventions specific to this repo

- Every new tool module goes in `src/tools/index.ts` and its tools in
  `manifest.json` `tools[]` — `tests/index.test.ts` checks the roster both ways
  and that every write states a boolean `destructiveHint` and takes `confirmToken`.
- Fixtures are synthetic (`Test Sitter`, ids like 1001, `@example.com`) —
  never paste real account data, cookies or tokens.
- `npm test` runs both typechecks (`tsconfig.json` + `tsconfig.test.json`)
  and vitest; `tests/server-boot.test.ts` spawns the built `dist/` artifacts.
