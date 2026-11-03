# juggle-mcp

MCP server for [Juggle](https://whyjuggle.com) — the babysitting and
petsitting marketplace — for a **family** account: your sits and the sitters
who applied, sitter profiles and reviews, and your messages, plus
confirmation-gated booking changes.

> Developed and maintained by AI (Claude Code). Not affiliated with Juggle.
> The site has no public API; this server signs in with your email and
> password and uses the same routes the website does. Those routes were mapped
> from the site's JavaScript. Every read tool and the favorite / unfavorite
> writes have been **verified against a signed-in family account** (2026-11-03);
> the other writes (post a sit, accept / decline a sitter, cancel, message,
> review) reach other people and are **not yet verified live** — see
> [`docs/JUGGLE-API.md`](docs/JUGGLE-API.md).

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

### Reads

| Tool | What it does |
|---|---|
| `juggle_healthcheck` | Check the Juggle sign-in is configured and accepted, and that an authenticated page read works |
| `juggle_get_profile` | Your family profile: account, city, membership, job stats, saved addresses (ids for posting a sit), pets; kids only on request |
| `juggle_get_payments_summary` | Your city rates, saved cards (brand/last 4), membership, promo credits and recent transactions, in dollars |
| `juggle_list_bookings` | List your sits/jobs: status, service, start time, booked sitter, pending applications; active, past or by status |
| `juggle_get_booking` | One booking in detail: times, kids/pets, notes, applicants and booked sitters, payment total, what you can do |
| `juggle_list_sitters` | Search sitters in your city by availability window, services, keywords or name |
| `juggle_list_favorites` | List the sitters you have marked as favorites. Reports `returned` (the favorites count) and, if Juggle's 200-sitter cap may have cut the list short, a `note`; since 0.1.1 it no longer reports `totalNumSitters`, which was the city-wide sitter count, not your favorites |
| `juggle_get_sitter` | A sitter public profile: rating, experience, school, certifications, bio — never private details |
| `juggle_get_reviews` | Reviews other families left for a sitter, with total count and average rating |
| `juggle_list_conversations` | Your message conversations with sitters: last message, time, unread count |
| `juggle_get_conversation` | Read the messages in one conversation, newest page first |
| `juggle_list_locations` | Cities Juggle serves and their published babysitting/petsitting rates (no sign-in needed) |

Reads take `view`: `compact` (default) is a small projection, while `full` and
`raw` return more upstream fields. On the profile, sitter and payments tools,
even `raw` stays inside the privacy allowlists. The private fields on a
sitter's profile row (phone, birthdate, emergency contacts, background-check
answers, social handles), the family's phone numbers and house instructions,
and the Stripe secrets on the payments page are never returned. The one
exception is a booking, which shows the phone number of the sitter booked for
that sit, the same as the site does. Kids' details come back only with
`include_kids`. Tools that return other people's text (messages,
reviews, sitter bios, booking notes) frame it as untrusted.

### Writes (confirm-gated)

| Tool | What it does |
|---|---|
| `juggle_post_job` | Post a one-time babysitting/petsitting/homeschool-help job (sit), optionally inviting a sitter |
| `juggle_accept_sitter` | Accept (book) a sitter who applied to one of your jobs |
| `juggle_decline_sitter` | Decline a sitter's application to one of your jobs |
| `juggle_cancel_booking` | Cancel a booking; late cancels only via the one-star-review penalty, never the fee |
| `juggle_send_message` | Send a text message in one of your sitter conversations |
| `juggle_favorite_sitter` | Add a sitter to your favorites |
| `juggle_unfavorite_sitter` | Remove a sitter from your favorites |
| `juggle_leave_review` | Leave a 0-5 star (half-star) review of a sitter for a finished booking |

Each write's first call sends nothing. It does a fresh read and returns a
preview plus a `confirmToken`. Repeating the call with that token sends the
request exactly once (see `MCP_CONFIRM_MODE` above). A 5xx or a dropped
connection after the send is reported as `status: "unknown"` and is never
retried. Nothing that moves money (tips, payments, cancellation fees,
subscriptions, gift cards) is in scope, and a late cancel never pays the fee.

## Skill (no server needed)

[`skills/juggle`](skills/juggle/SKILL.md) is a curl + jq helper
(`skills/juggle/scripts/juggle`) for the same reads from a shell. It runs
under bash or zsh, keeps its own 0600 session file at
`~/.config/juggle/session`, and applies the same privacy allowlists. It is
read-only; writes stay in the MCP. Claude Code discovers it automatically
when this repo is installed as a plugin.

## Hosting

Hostable on mcp-host (claude.ai remote MCP) as a per-user connector, with no
browser bridge, because sign-in is a plain server-side email and password
POST. `mint.yaml` declares `identity.perUserChild` and asks each person for
their own `JUGGLE_EMAIL` / `JUGGLE_PASSWORD` on the authorize page, so no
shared secret is involved. Egress is `whyjuggle.com` only. The skill is
local-only: it runs wherever `curl` and `jq` are installed.

## Development

```sh
npm install
npm run build
npm test        # both typechecks + vitest (no network)
```

## License

MIT
