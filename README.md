# mail-to-gmail

**Self-hosted replacement for Gmailify.** Sync Zoho, Yahoo, and Outlook mailboxes into one or more Gmail accounts over IMAP, using app passwords — no Google Cloud project, no OAuth screens.

Google is retiring [Gmailify](https://support.google.com/mail/answer/16604719). `mail-to-gmail` takes over: runs as a small daemon, listens for new mail via IMAP IDLE where supported (Yahoo, Outlook.com), and appends messages into your Gmail mailbox exactly once. It's designed to fit on a Fly.io free-tier machine (1 shared CPU, 256 MB RAM) and stay there.

## What it does

- **Multi-source, multi-destination.** One `config.yaml` lists your mailboxes. Each source picks a Gmail destination by name; multiple sources can share a destination.
- **Archive semantics.** Source messages are never deleted. Gmail is your read/search hub; the originals stay where they are.
- **No database-as-authority.** SQLite caches checkpoints and seen messages, but Gmail itself is the source of truth for dedup. Losing the SQLite file never produces duplicates in Gmail.
- **Push detection.** For Yahoo and Outlook, IMAP IDLE wakes the daemon the moment new mail arrives. Zoho (HTTP API, no IDLE) polls on its own schedule.
- **App-password-only.** Zoho uses an OAuth2 refresh token (supported on the free plan). Every other account uses an IMAP app password. No Google Cloud project, no OAuth flow for Gmail.

## Sources and destinations

| Provider | Type | Auth | IDLE |
|---|---|---|---|
| Zoho Mail (Free or paid) | HTTP API | OAuth2 refresh token | — |
| Yahoo Mail | IMAP | App password | ✓ |
| Outlook.com / Hotmail | IMAP | App password | ✓ |
| Gmail (destination) | IMAP APPEND | App password | — |

Microsoft 365 / work accounts require XOAUTH2 and are not supported yet. Generic IMAP sources can be configured with a custom `host` / `port` / `tls` block.

## Quick start

```bash
nvm use && npm install
cp config.example.yaml config.yaml    # edit source/destination names
cp .env.example .env                  # fill in the credentialsRef secrets

npm run setup:zoho                    # optional — OAuth wizard that prints a .env block
npm run setup:imap-source             # optional — interactive Yahoo/Outlook source wizard
npm run setup:gmail-destination       # optional — interactive Gmail destination wizard

npm run build
npm start                             # starts the daemon
```

First pass: walks back `lookbackDays` (default 1 day) per source and imports everything new. After that the checkpoint advances; only fresh mail moves.

## Configuration

Two files:

- **`config.yaml`** — named destinations + sources, per-source schedule and filter. Committed-free: reference template is `config.example.yaml`. Not a secret.
- **`.env`** — every credential, keyed by `<credentialsRef>_<SUFFIX>`. For `credentialsRef: GMAIL_1`, the loader reads `GMAIL_1_EMAIL` and `GMAIL_1_APP_PASSWORD`. Never commit this.

### Filters

Each source carries its own filter. Fields match case-insensitively, AND across fields, OR within each array:

```yaml
filter:
  subjectContains: ["Invoice", "Receipt"]
  fromContains: ["@mybank.com"]
  toContains: []
  listIdContains: []
```

`listIdContains` causes the source to fetch the `List-Id` header on-demand (free for IMAP, one extra HTTP call per message for Zoho).

### Schedules

```yaml
schedule:
  intervalSeconds: 600       # how often to poll (IDLE bypasses this when available)
  lookbackDays: 1            # first-run reach-back; 0 disables the default
  maxMessagesPerRun: 100     # processing cap per iteration
```

## CLI

```
mail-to-gmail sync                         # daemon, all enabled sources
mail-to-gmail sync --source yahoo-personal
mail-to-gmail sync --once                  # single pass, exit
mail-to-gmail sync --dry-run               # no APPEND, no state writes
mail-to-gmail test-source zoho-main        # connect source + its destination, no writes
mail-to-gmail reset yahoo-personal         # clear checkpoint + seen_messages for one source
mail-to-gmail list                         # print destinations and sources
```

## DB loss and deduplication

Before every APPEND, the daemon injects a `X-M2G-Content-Hash: <sha256>` header into the raw MIME. Then it asks Gmail: does a message with this `Message-ID` exist, or with this content hash? If yes, skip. Gmail's own `X-GM-RAW` search is the authority.

This means the SQLite file (`/data/mail-to-gmail.db` on Fly) is a **cache**, not the source of truth. Wipe it and the daemon re-walks `lookbackDays` of mail from each source; Gmail's search answers "already have this" for every already-imported message, so nothing is duplicated.

## Memory footprint

Target: ≤180 MB resident on a Fly.io `shared-cpu-1x` / 256 MB machine with five long-lived IMAP IDLE connections, two Gmail IMAP connections (shared across sources), and SQLite.

- Compiled JS only (`npm run build` → `dist/`); no `tsx` at runtime.
- Node run with `--max-old-space-size=192`.
- Provider instances reused across iterations, keyed by name.
- Per-destination LRU (5,000 entries, ~400 KB) eliminates redundant Gmail searches when a mailing list hits multiple source inboxes.
- Raw MIME is fetched → APPENDed → dropped. One message in flight at a time; never batched in memory.

## Deploying on Fly.io

```bash
flyctl launch --no-deploy --name mail-to-gmail --copy-config
flyctl volumes create mailstate --size 1 --region iad
flyctl secrets set ZOHO_MAIN_CLIENT_ID=... ZOHO_MAIN_CLIENT_SECRET=... \
                   ZOHO_MAIN_REFRESH_TOKEN=... \
                   YAHOO_PERSONAL_EMAIL=... YAHOO_PERSONAL_APP_PASSWORD=... \
                   GMAIL_1_EMAIL=... GMAIL_1_APP_PASSWORD=...
flyctl deploy
flyctl logs
```

`config.yaml` is baked into the image. Secrets live only in Fly secrets.

## Architecture

- `src/core/` — `SyncEngine` (per-source sync + dedup), `SyncScheduler` (daemon loop + IDLE wake), `StateStore` (SQLite), shared types, MIME helpers.
- `src/config/` — YAML config loader (zod-validated) and credential resolvers.
- `src/providers/source/` — `ZohoMailApiSource` (HTTP API) and `ImapSource` (Yahoo / Outlook / generic IMAP with IDLE).
- `src/providers/destination/` — `GmailImapDestination` (IMAP APPEND + Gmail-side dedup).
- `tools/` — setup wizards that test credentials and append to `config.yaml` / `.env`.

See [`DESIGN.md`](./DESIGN.md) for details on the dedup strategy, migration path, and how to add a new source type.

## Credits

Inspired by [turbogmailify](https://github.com/YoRyan/turbogmailify)'s IDLE-driven design. We keep archive semantics (no source expunge) and use IMAP APPEND instead of the Gmail API.
