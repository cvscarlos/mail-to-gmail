# mail-to-gmail — design

## 1. Shape of the system

```
config.yaml  →  SyncScheduler  →  SyncEngine  →  SourceProvider  +  DestinationProvider
   .env                │                               │                     │
                 StateStore (SQLite)            Zoho HTTP API         Gmail IMAP APPEND
                                                  IMAP (Yahoo,
                                                  Outlook, ...)
```

- **`SyncScheduler`** owns the daemon loop, the per-source next-due map, back-off, and lazy provider caches keyed by name. It subscribes to IMAP IDLE events and wakes a source the moment it's due.
- **`SyncEngine`** is the per-source sync orchestrator: load checkpoint → list candidates → filter → fetch raw MIME → dedup check (SQLite + Gmail) → APPEND → mark seen → advance checkpoint.
- **`SourceProvider` / `DestinationProvider`** are the pluggable interfaces. New protocols (POP3, Graph, etc.) slot in as new classes without touching the engine.
- **`StateStore`** is a thin SQLite wrapper. Schema is versioned; a single-shot migration lifted the pre-2.0 two-column `(provider, account)` key to `source_name`.

## 2. Config model

Two sections in `config.yaml`:

```yaml
destinations:
  - name: gmail-1
    type: gmail-imap
    credentialsRef: GMAIL_1      # reads GMAIL_1_EMAIL, GMAIL_1_APP_PASSWORD from .env
    mailbox: INBOX

sources:
  - name: zoho-main
    enabled: true
    type: zoho-api
    credentialsRef: ZOHO_MAIN
    destination: gmail-1         # must match a destination above
    …
```

The loader runs a zod-validated parse plus a cross-reference check — every `source.destination` must name a defined destination, source/destination names are unique, and missing `_EMAIL` / `_APP_PASSWORD` / Zoho OAuth secrets fail fast with a message naming the offending entry.

## 3. Deduplication

Two layers, in order:

### Layer 1 — local cache (SQLite)

`seen_messages(source_name, message_id)` is the fast path. If we've previously processed this source's message ID, skip without reading any bytes. A separate `content_hash` column lets us also catch duplicates with a changed source-side ID.

### Layer 2 — Gmail as source of truth

Before every APPEND, the engine injects `X-M2G-Content-Hash: <sha256-of-raw-mime>` into the message's header block. Then it asks Gmail:

```
X-GM-RAW rfc822msgid:<parsed Message-ID>
X-GM-RAW "X-M2G-Content-Hash:<hash>"   (fallback)
```

If either search hits, we skip the APPEND and record a `seen_messages` row for the local cache. Every `GmailImapDestination` carries a per-instance LRU (5k entries, ~400 KB) so two sources delivering the same mailing-list email into the same Gmail account only pay one Gmail search.

**Why this matters:** SQLite on a cheap VM is disposable. If the volume is wiped, the daemon rewinds to `lookbackDays` and walks every source again — but Gmail's `X-GM-RAW` search catches the re-imports, so nothing duplicates. The only cost of DB loss is one search per message in the lookback window.

## 4. Scheduler and IDLE

Each enabled source has a `nextDueAt` timestamp. The scheduler:

1. Collects due sources, runs them sequentially through `SyncEngine` (one message in flight across all sources — keeps memory predictable).
2. After a successful run, sets `nextDueAt = now + intervalSeconds`.
3. On failure, doubles a per-source back-off (cap 30 min).
4. Sleeps until the soonest `nextDueAt`, racing the timer against an `AbortSignal` and an internal "wake" promise.

For IMAP sources with `idle: true`, the `ImapSource` holds the idle folder selected after each sync. ImapFlow transparently maintains the IDLE command in the background and fires `exists` when new mail lands; the handler sets `nextDueAt = now` and wakes the sleep — the source runs within seconds of a push.

## 5. MIME handling

Parsing email headers is a minefield (folding, MIME-encoded words, case variants). `src/core/mimeUtils.ts` stays deliberately minimal:

- Header block ends at the first blank line.
- Unfold continuation lines (leading space/tab).
- Case-insensitive name match.
- `Message-ID` and `List-Id` extract the first `<…>`.

Headers are parsed from raw bytes using Latin-1 (1-to-1 byte mapping) to avoid UTF-8 corruption on attachments. The injected hash header is prepended to the buffer — Gmail IMAP APPEND takes the raw bytes verbatim, so the custom header is preserved and indexed.

## 6. Memory budget (Fly.io shared-cpu-1x, 256 MB)

Sized conservatively:

| Component | Estimate |
|---|---|
| Node 20 baseline | ~35 MB |
| V8 heap cap (`--max-old-space-size=192`) | ≤192 MB |
| `@libsql/client` + DB | ~6 MB |
| 4× ImapFlow IDLE connections (Yahoo×2, Outlook×2) | ~32–48 MB |
| 2× ImapFlow destinations (shared across sources) | ~15–25 MB |
| Axios + Zoho client state | ~5 MB |
| Misc (yaml, zod, logger, lru-cache) | ~10 MB |
| **Steady state** | **~150–180 MB** |

Guard-rails:

- Production runs compiled JS (`dist/`), not `tsx` — saves the transformer overhead.
- One message in flight: fetch → APPEND → drop reference. No batched MIME in memory.
- Folder listings cached for 5 min per source.
- Winston writes to `console` only; no file rotation.
- Sequential source execution; IDLE wakes don't multiplex concurrent syncs.

## 7. State schema

```
schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)

checkpoints(source_name PRIMARY KEY, last_received_at, last_message_id)

seen_messages(source_name, message_id, content_hash, received_at,
              import_timestamp, dest_name, dest_mailbox,
              PRIMARY KEY (source_name, message_id))
INDEX idx_seen_messages_hash ON (content_hash)
```

The v1 → v2 migration runs once on startup. It copies the old single-flow rows under a configurable `source_name` (defaults to `zoho-main`), drops the old tables, and records `(2, now)` in `schema_migrations`.

## 8. Adding a new source type

1. Add the type name to `SourceKind` and a new `XxxSourceConfig` interface in `src/core/types.ts`.
2. Extend the discriminated union in `src/config/appConfig.ts` with a zod schema.
3. Implement `SourceProvider` in `src/providers/source/XxxSource.ts`. For push support, expose `setIdleHandler` + `startIdleWatch` / `stopIdleWatch` like `ImapSource`.
4. Add a branch in `src/providers/factories.ts#createSource`.
5. (Optional) Add a setup wizard under `tools/`.

The engine and scheduler are provider-agnostic — no changes needed there.

## 9. Locking

A single `proper-lockfile` guard around the SQLite DB path prevents two daemons, a daemon + a `reset`, or two `reset` calls from racing. `test-source` and `list` are read-only and don't take the lock.
