# zoho-to-gmail

**Zoho Mail → Gmail, on autopilot. Works on the Zoho Free plan — no IMAP, no POP, no paid upgrade required.**

On Zoho's Forever Free plan, IMAP and POP are disabled, so every "just forward everything to Gmail" tutorial dies on page one. Upgrading just to unlock mail forwarding costs real money per mailbox. `zoho-to-gmail` sidesteps the whole trap: it pulls from Zoho's official REST API (OAuth 2.0 — which **is** available on the free plan) and appends straight into your Gmail mailbox over IMAP with an App Password. Point it at a spare mini-PC, a Raspberry Pi, or a free-tier VPS and your Zoho inbox lands in Gmail every few minutes — forever, at zero Zoho cost.

## Why you want this

- **Works on Zoho Free — no paid plan, no IMAP, no POP.** Uses only REST + OAuth, which free-plan accounts already have.
- **Unifies your inboxes.** Read, search, and reply from a single Gmail account while Zoho keeps receiving.
- **Idempotent and crash-safe.** Source message IDs plus SHA-256 content hashes mean you can stop, restart, or reconfigure anytime — Gmail never sees a duplicate.
- **Preserves the full message.** Headers, threading, attachments, and encoding pass through untouched.
- **All folders out of the box.** Archive, custom labels, server-side-filtered folders — everything except Spam and Trash, fully configurable.
- **Extensible.** Provider interfaces are cleanly isolated. Swapping Zoho for Outlook or Gmail for generic IMAP is a one-file change.

## Ready to use today

- Long-running daemon by default: sync, sleep, repeat. `SIGTERM`-aware so it plays nicely with Docker.
- Single env flag flips it to one-shot mode for cron or CI.
- Optional subject filter for "only sync tickets matching X" workflows.
- One SQLite file for checkpoints and dedup history. No Redis, no queue, no external infra.
- Typical footprint: under 100 MB RAM and near-zero CPU while idle.

## Quick start

```bash
nvm use && npm install
npm run setup:zoho            # interactive OAuth wizard: client ID, secret, auth code
cp .env.example .env          # fill in Gmail App Password and confirm defaults
npm start sync                # starts the daemon
```

First run pulls messages from the last `SYNC_LOOKBACK_DAYS` (default 1). From then on, the checkpoint advances after every successful iteration — only new mail is touched.

## Configuration

Every knob is an environment variable; see `.env.example` for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `SYNC_INTERVAL_SECONDS` | `300` | Wait between iterations. `0` = run once and exit. |
| `SYNC_LOOKBACK_DAYS` | `1` | On the very first run, how far back to reach. |
| `MAX_MESSAGES_PER_RUN` | `100` | Per-iteration processing cap. Remainder is picked up next run. |
| `FILTER_CONFIG_PATH` | — | Optional JSON file for subject filtering. |
| `DRY_RUN` | `false` | Fetch and filter, but don't append to Gmail. |

## Operations

```bash
npm start sync               # long-running daemon (default)
npm start sync --once        # single run, exit
npm start sync --dry-run     # preview without writing to Gmail
npm run reset                # clear checkpoints (dedup history stays intact)
npm start test-source        # verify Zoho credentials
npm start test-destination   # verify Gmail IMAP credentials
```

## Deployment

Put it in a Docker container with `restart: unless-stopped`. That's the whole recipe. Logs stream to stdout, so `docker logs` just works. `docker stop` sends `SIGTERM`, the current iteration finishes cleanly, resources close, exit 0.

For cron or systemd timers, set `SYNC_INTERVAL_SECONDS=0` (or pass `--once`) and schedule `npm start sync` however you prefer.

## Architecture

- `src/core/` — interfaces, sync engine, checkpoints, dedup.
- `src/providers/source/` — Zoho Mail REST API client.
- `src/providers/destination/` — Gmail IMAP appender.
- `src/utils/` — config, logger.

See [`DESIGN.md`](./DESIGN.md) for the dedup strategy and extensibility notes.
