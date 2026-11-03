# juggle-mcp

MCP server for [Juggle](https://whyjuggle.com) — the babysitting and
petsitting marketplace — for a **family** account: your sits and the sitters
who applied, sitter profiles and reviews, and your messages, plus
confirmation-gated booking changes.

> Developed and maintained by AI (Claude Code). Not affiliated with Juggle.
> The site has no public API; this server signs in with your email and
> password and uses the same routes the website does. Those routes were mapped
> from the site's JavaScript and are **not yet verified against a signed-in
> account** — see [`docs/JUGGLE-API.md`](docs/JUGGLE-API.md).

## Setup

```sh
npx -y @chrischall/juggle-mcp
```

| Variable | Required | Description |
|---|---|---|
| `JUGGLE_EMAIL` | yes | The email you sign in to whyjuggle.com with (a family account). |
| `JUGGLE_PASSWORD` | yes | Your whyjuggle.com password. Google/Facebook-only sign-ins are not supported — set a password on the site first. |
| `JUGGLE_BASE_URL` | no | Site origin override, for tests / a local stub only. Default `https://whyjuggle.com`; must be https (loopback http allowed). |
| `MCP_CONFIRM_MODE` | no | Confirm-gated writes on clients without prompts (claude.ai, Claude Desktop): `ask-user` (default) — the first call sends nothing and returns a preview + `confirmToken`, and the model must get your approval before repeating it with the token; `auto` — the model may use the token after reviewing the preview; `refuse` — writes are refused. |
| `MCP_CONFIRM_ELICITATION` | no | `off` skips the confirmation prompt even on clients that declare elicitation support. |
| `MCP_CONFIRM_TTL_SECONDS` | no | How long a `confirmToken` stays valid (default 600). |

The server starts without credentials (so hosts can list its tools); the
first tool call reports what is missing. A rejected password is never retried
automatically.

## Tools

| Tool | What it does |
|---|---|
| `juggle_healthcheck` | Is a sign-in configured, does Juggle accept it, and does an authenticated page read work? |

Read and write tools land next; the full planned set is in
[`docs/JUGGLE-API.md`](docs/JUGGLE-API.md). Nothing that moves money (tips,
payments, cancellation fees, subscriptions) is in scope.

## Hosting

Hostable on mcp-host as a per-user connector: `mint.yaml` declares
`identity.perUserChild` and asks each person for their own `JUGGLE_EMAIL` /
`JUGGLE_PASSWORD` on the authorize page. Egress is `whyjuggle.com` only.

## Development

```sh
npm install
npm run build
npm test        # both typechecks + vitest (no network)
```

## License

MIT
