<h1 align="center">Mail To Gmail</h1>

<p align="center">
  <img src="docs/assets/banner.png" alt="mail-to-gmail" width="500" />
</p>

![Node](https://img.shields.io/badge/node-%3E%3D24-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Docker](https://img.shields.io/badge/Dockerfile.dev-ready-blue)

_Self-hosted replacement for Google's retiring [Gmailify](https://support.google.com/mail/answer/16604719). Sync Zoho, Yahoo, and Outlook mailboxes into Gmail over IMAP — no Google Cloud project, no OAuth screens._

---

`mail-to-gmail` syncs **Zoho**, **Yahoo**, **Outlook.com / Hotmail**, and generic **IMAP** mailboxes into one or more **Gmail** accounts. It runs as a small daemon, reads from sources, and appends matching messages into Gmail over IMAP using app passwords. No Google Cloud project, no OAuth consent screen.

## Why

- **Multi-source, multi-destination.** One `config.yaml` lists every mailbox. Each source picks a Gmail destination by name; multiple sources can share a destination.
- **Archive semantics.** Source messages are never deleted. Gmail becomes the read / search hub; originals stay in place.
- **Gmail-backed deduplication.** SQLite stores checkpoints and a seen-message cache, but Gmail is the authority before every APPEND. Losing the SQLite file never produces duplicates.
- **Push where available.** Yahoo and Outlook.com wake the daemon via IMAP IDLE. Zoho polls on its own schedule.
- **Small footprint.** Designed for a 1×CPU / 256 MB host (~180 MB resident steady state).

## Supported providers

| Provider                 | Role        | Type        | Auth                 | IDLE     |
| ------------------------ | ----------- | ----------- | -------------------- | -------- |
| Zoho Mail (Free or paid) | Source      | HTTP API    | OAuth2 refresh token | —        |
| Yahoo Mail               | Source      | IMAP        | App password         | ✓        |
| Outlook.com / Hotmail    | Source      | IMAP        | App password         | ✓        |
| Generic IMAP             | Source      | IMAP        | App password         | Optional |
| Gmail                    | Destination | IMAP APPEND | App password         | —        |

Microsoft 365 / work accounts require XOAUTH2 and are not supported yet.

## Quick start

```bash
nvm use && npm install
cp config.example.yaml config.yaml    # edit source/destination names
cp .env.example .env                  # fill in the credentialsPrefix secrets
set -a && source .env && set +a       # bash/zsh: auto-export vars for child processes

npm run setup:zoho                    # optional — OAuth wizard that prints a .env block
npm run setup:imap-source             # optional — interactive Yahoo/Outlook source wizard
npm run setup:gmail-destination       # optional — interactive Gmail destination wizard

npm run build
npm start                             # starts the daemon
```

The daemon reads credentials from `process.env` directly — it does **not** import `dotenv`. In production, Docker / systemd inject the vars natively. Locally, either prefix every line in `.env` with `export` and `source` it, or run `set -a && source .env && set +a` once per shell session.

First pass: walks back `lookbackDays` (default 1 day) per source and imports everything new. After that the checkpoint advances; only fresh mail moves.

## Configuration files

| File                    | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `config.yaml`           | Destinations, sources, folders, schedules, filters. Not a secret. |
| `.env` / exported shell | Credentials keyed by `<credentialsPrefix>_<SUFFIX>`. Secret.      |

Each destination and source has a `credentialsPrefix`. For `credentialsPrefix: YAHOO_MAIN`, the loader reads `YAHOO_MAIN_EMAIL` and `YAHOO_MAIN_APP_PASSWORD` from `process.env`.

## Configuration examples

### Simple

Minimal single-source Yahoo → Gmail setup:

```yaml
destinations:
  - name: gmail-main
    credentialsPrefix: GMAIL_MAIN

sources:
  - name: yahoo-main
    type: imap
    preset: yahoo
    credentialsPrefix: YAHOO_MAIN
    destination: gmail-main
    idle: true
    schedule:
      intervalMinutes: 10
      lookbackDays: 1
      maxMessagesPerRun: 100
```

Required environment:

```bash
GMAIL_MAIN_EMAIL=you@gmail.com
GMAIL_MAIN_APP_PASSWORD=your-gmail-app-password
YAHOO_MAIN_EMAIL=you@yahoo.com
YAHOO_MAIN_APP_PASSWORD=your-yahoo-app-password
```

### Advanced

Every field with defaults shown inline. Omit any field to accept its default.

```yaml
destinations:
  - name: gmail-main
    credentialsPrefix: GMAIL_MAIN
    mailbox: INBOX # default: INBOX

  - name: gmail-archive
    credentialsPrefix: GMAIL_ARCHIVE

sources:
  # --- Generic IMAP source (Yahoo / Outlook / custom host) ---
  - name: yahoo-main
    enabled: true # default: true
    type: imap
    credentialsPrefix: YAHOO_MAIN
    destination: gmail-main

    # Connection — use a preset OR provide host/port/tls explicitly.
    preset: yahoo # one of: yahoo, outlook
    host: imap.mail.yahoo.com # required if no preset
    port: 993 # default: 993
    tls: true # default: true

    folders: ['*'] # default: ["*"]
    excludeFolders: ['Spam', 'Trash'] # default: ["Spam", "Trash"]

    idle: true # default: false
    idleFolder: INBOX # default: INBOX

    schedule:
      intervalMinutes: 10 # how often to poll; IDLE can wake sooner
      lookbackDays: 1 # first-run reach-back; 0 disables default
      maxMessagesPerRun: 100 # processing cap per iteration

    filter:
      subjectContains: ['Invoice', 'Receipt']
      fromContains: ['@mybank.com']
      toContains: []
      listIdContains: []

  # --- Zoho Mail source (HTTP API, no IDLE) ---
  - name: zoho-main
    enabled: true
    type: zoho-api
    credentialsPrefix: ZOHO_MAIN
    destination: gmail-archive
    folders: ['*']
    excludeFolders: ['Spam', 'Trash']
    idle: false # must be false for zoho-api
    schedule:
      intervalMinutes: 5
      lookbackDays: 1
      maxMessagesPerRun: 100
    filter: {}

    # Optional: mirror Gmail-side deletions back to the source. See "Delete sync"
    # below for the full behavior and safety rails.
    deleteSync:
      enabled: false # default: false — opt-in
      maxPropagationsPerRun: 10 # default: 10 — safety cap per reconciliation pass
```

## Environment variables

### App-level

| Name            | Required | Default              | Description                                                    |
| --------------- | -------- | -------------------- | -------------------------------------------------------------- |
| `APP_LOG_LEVEL` | Optional | `info`               | `debug` \| `info` \| `warn` \| `error`.                        |
| `STATE_DB_PATH` | Optional | `./mail-to-gmail.db` | SQLite state database path (checkpoints + seen-message cache). |
| `CONFIG_PATH`   | Optional | `./config.yaml`      | Path to the YAML config file.                                  |
| `DRY_RUN`       | Optional | `false`              | When truthy, skip APPEND + state writes; log intended actions. |

### Per-credentialsPrefix (replace `FOO` with the prefix from `config.yaml`)

| Name                | Required when                    | Default         | Description                                                          |
| ------------------- | -------------------------------- | --------------- | -------------------------------------------------------------------- |
| `FOO_EMAIL`         | IMAP source or Gmail destination | —               | Login email address.                                                 |
| `FOO_APP_PASSWORD`  | IMAP source or Gmail destination | —               | App password (not your account password).                            |
| `FOO_DC`            | Optional for Zoho sources        | `com`           | Zoho data center: `com`, `eu`, `in`, `com.au`, `com.cn`.             |
| `FOO_CLIENT_ID`     | Zoho sources                     | —               | Zoho OAuth2 client ID (Self Client).                                 |
| `FOO_CLIENT_SECRET` | Zoho sources                     | —               | Zoho OAuth2 client secret.                                           |
| `FOO_REFRESH_TOKEN` | Zoho sources                     | —               | Zoho OAuth2 refresh token.                                           |
| `FOO_ACCOUNT_ID`    | Optional for Zoho sources        | Auto-discovered | Set only if the OAuth token grants access to multiple Zoho accounts. |

## Filters

Each source carries its own filter. Matching is case-insensitive, **AND** across fields, **OR** within each array:

```yaml
filter:
  subjectContains: ['Invoice', 'Receipt']
  fromContains: ['@mybank.com']
  toContains: []
  listIdContains: []
```

`listIdContains` fetches the `List-Id` header on demand — free for IMAP, one extra HTTP call per message for Zoho.

## Schedules

```yaml
schedule:
  intervalMinutes: 10 # how often to poll (IDLE bypasses this when available)
  lookbackDays: 1 # first-run reach-back; 0 disables the default
  maxMessagesPerRun: 100 # processing cap per iteration
```

## Delete sync (optional, off by default)

When enabled per source, deletions in Gmail are mirrored back to the source's own Trash. Restoring a Gmail-side message back to your inbox triggers a matching restore on the source.

```yaml
sources:
  - name: yahoo-main
    # ... rest of the source config
    deleteSync:
      enabled: false # default: false — opt-in
      maxPropagationsPerRun: 10 # default: 10 — per-pass safety cap
```

| Field                   | Default | Behavior                                                                                                                                  |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | `false` | Master switch. When false, the source is never touched.                                                                                   |
| `maxPropagationsPerRun` | `10`    | Hard cap on how many source-side moves a single reconcile pass will perform. Anything beyond is deferred to the next run with a warn log. |

**Dry-run** is controlled by the daemon-level `DRY_RUN=true` env var (the same switch the forward sync uses). Recommended for the first pass after enabling — logs intended moves, no source-side writes.

**What it does:**

- Scans `[Gmail]/Trash` and `[Gmail]/Spam` for messages we previously imported (identified by their `X-M2G-Source` / `X-M2G-Source-ID` / `X-M2G-Content-Hash` headers).
- For each match: moves the corresponding source message to the source's own `\Trash` (IMAP) or via the provider's move-to-trash API (Zoho).
- Marks the Gmail copy with the `mail-to-gmail-propagated` label so subsequent passes skip it.
- Tracks every propagation in a small SQLite table; on the next pass, checks whether the user restored the Gmail message — if so, moves the source copy back to source `INBOX`.

**Safety properties:**

- **Off by default** — shipping does not change behavior for existing setups.
- **Soft-delete only** — the source move is to Trash, never EXPUNGE. Recoverable for ~30 days on the source side too.
- **Fail-safe** — if Gmail Trash is emptied or the account is wiped, there's nothing for the pass to find, so source copies are preserved.
- **Per-run cap** — `maxPropagationsPerRun` bounds the damage of any single anomalous run.
- **Only acts on messages imported by mail-to-gmail post-upgrade.** Pre-existing imports (POP3, manual, Gmailify) lack the M2G headers and are invisible to delete-sync forever — see DESIGN.md §10 for why.

See [`DESIGN.md`](./DESIGN.md) §10 "Delete sync" for the full decision table, restoration logic, and known sharp edges.

## CLI

```bash
mail-to-gmail sync                         # daemon, all enabled sources
mail-to-gmail sync --source yahoo-main
mail-to-gmail sync --once                  # single pass, then exit
mail-to-gmail sync --dry-run               # no APPEND, no state writes
mail-to-gmail test-source zoho-main        # connect source + its destination, no writes
mail-to-gmail reset yahoo-main             # clear checkpoint + seen_messages for one source
mail-to-gmail list                         # print destinations and sources
```

## Docker (dev)

Build a dev image directly from GitHub — no local clone needed:

```bash
docker build -f Dockerfile.dev \
  --build-arg REF=main \
  -t mail-to-gmail:dev .

docker run --rm \
  --env-file .env \
  -v "$PWD/config.yaml":/app/config.yaml \
  mail-to-gmail:dev
```

The Dockerfile streams the GitHub tarball through `tar` (no `git` binary installed → ~30 MB smaller image). Override `REPO_OWNER`, `REPO_NAME`, or `REF` via `--build-arg` for forks or tagged releases.

## Deduplication and database loss

Before every APPEND, the daemon injects three headers into the raw MIME:

```
X-M2G-Content-Hash: <sha256-of-raw-mime>
X-M2G-Source:       <source-name>            e.g. yahoo-main
X-M2G-Source-ID:    <percent-encoded-id>     e.g. INBOX%00307180
```

The daemon then asks Gmail via `X-GM-RAW` whether a message with the same `Message-ID` **or** content hash already exists. If Gmail finds a match, the append is skipped.

The two `X-M2G-Source*` headers are not used for dedup itself — they tag every imported message so the optional Delete sync feature can later identify "messages we own" inside Gmail Trash / Spam. They're harmless if you never enable delete-sync.

SQLite is a **cache**, not the deduplication authority. Wipe `mail-to-gmail.db` and the daemon re-walks `lookbackDays` of source mail; Gmail search answers "already have this" for every previously-imported message, so nothing is duplicated.

## Memory footprint

Designed for a 1×CPU / 256 MB host: ≤180 MB resident with five long-lived IMAP IDLE connections, two Gmail IMAP connections (shared across sources), and SQLite.

- Compiled JS only (`npm run build` → `dist/`); no `tsx` at runtime.
- Provider instances reused across iterations, keyed by name.
- Per-destination LRU (5,000 entries, ~400 KB) eliminates redundant Gmail searches when a mailing list hits multiple source inboxes.
- Raw MIME is fetched → APPENDed → dropped. One message in flight at a time; never batched in memory.

Node runtime tuning (heap caps, GC flags) is left to the deployment. On a tight 256 MB box, start with `node --max-old-space-size=192 dist/index.js`.

## Architecture

| Path                         | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `src/core/`                  | `SyncEngine`, `SyncScheduler`, `StateStore` (SQLite), types, MIME.        |
| `src/config/`                | YAML config loader (zod-validated) and credential resolvers.              |
| `src/providers/source/`      | `ZohoMailApiSource` (HTTP API) and `ImapSource` (IMAP + IDLE).            |
| `src/providers/destination/` | `GmailImapDestination` (IMAP APPEND + Gmail-side dedup).                  |
| `tools/`                     | Setup wizards that test credentials and append to `config.yaml` / `.env`. |

See [`DESIGN.md`](./DESIGN.md) for details on the dedup strategy and how to add a new source type.

## Credits

Inspired by [turbogmailify](https://github.com/YoRyan/turbogmailify)'s IDLE-driven design. Archive semantics (no source expunge) and IMAP APPEND instead of the Gmail API.
