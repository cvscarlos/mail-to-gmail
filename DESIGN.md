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
- **`StateStore`** is a thin SQLite wrapper. All rows are keyed by `source_name`, and the schema is created on first run.

## 2. Config model

Two sections in `config.yaml`:

```yaml
destinations:
  - name: gmail-1
    credentialsPrefix: GMAIL_1      # reads GMAIL_1_EMAIL, GMAIL_1_APP_PASSWORD from .env
    mailbox: INBOX

sources:
  - name: zoho-main
    enabled: true
    type: zoho-api
    credentialsPrefix: ZOHO_MAIN
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
2. After a successful run, sets `nextDueAt = now + intervalMinutes`.
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

## 6. Memory budget (256 MB target)

Sized conservatively for a 1×CPU / 256 MB host:

| Component                                         | Estimate        |
| ------------------------------------------------- | --------------- |
| Node 20 baseline                                  | ~35 MB          |
| `@libsql/client` + DB                             | ~6 MB           |
| 4× ImapFlow IDLE connections (Yahoo×2, Outlook×2) | ~32–48 MB       |
| 2× ImapFlow destinations (shared across sources)  | ~15–25 MB       |
| Axios + Zoho client state                         | ~5 MB           |
| Misc (yaml, zod, logger, lru-cache)               | ~10 MB          |
| **Steady state**                                  | **~150–180 MB** |

The code is sized to fit the budget. Node runtime tuning (e.g. `--max-old-space-size`) is **not** baked into `npm start` — it's a deployment concern. A tight 256 MB host should launch with `node --max-old-space-size=192 dist/index.js`; a 1 GB dev box just runs `npm start`.

Guard-rails:

- Production runs compiled JS (`dist/`), not `tsx` — saves the transformer overhead.
- One message in flight: fetch → APPEND → drop reference. No batched MIME in memory.
- Winston writes to `console` only; no file rotation.
- Sequential source execution; IDLE wakes don't multiplex concurrent syncs.

## 7. State schema

SQLite is used as a local cache, not a source of truth. Two tables, both keyed by `source_name`:

```
checkpoints(source_name PRIMARY KEY, last_received_at, last_message_id)

seen_messages(source_name, message_id, content_hash, received_at,
              import_timestamp, dest_name, dest_mailbox,
              PRIMARY KEY (source_name, message_id))
INDEX idx_seen_messages_hash ON (content_hash)
```

### No migrations

Tables are created on first run with `CREATE TABLE IF NOT EXISTS`. There's no migration framework. If the schema ever changes in a breaking way, the recovery is: delete the SQLite file and let the daemon re-walk `lookbackDays` of mail. Gmail's `X-GM-RAW` dedup catches the re-imports, so nothing duplicates — the only cost is one Gmail search per message in the lookback window.

This trade-off is deliberate: the code avoids a migration layer (complexity, versioning, testing), and the dedup design makes DB loss harmless.

### Retention and cleanup

Left unchecked, `seen_messages` grows one row per imported message — forever. A single source at 50 messages/day produces roughly 18k rows/year (~5–10 MB). A five-source setup over five years would sit around 150–230 MB. Not catastrophic, but unbounded and eventually noticeable on a 256 MB host.

Cleanup policy:

- On **every daemon startup**, rows in `seen_messages` whose `import_timestamp` is older than **90 days** are deleted. The retention window is defined by `SEEN_MESSAGES_RETENTION_DAYS` in `src/index.ts`.
- `checkpoints` is never pruned — one row per source, already bounded.

**Why 90 days?** The window must comfortably exceed the largest realistic `lookbackDays`. Default `lookbackDays` is 1, occasional users set 7 or 30; 90 gives a 60-day buffer before a prune could ever collide with a reach-back.

**Why is retention safe even if we get the number wrong?** Same reason DB loss is safe: Gmail is the real dedup authority. If prune deletes a row for a message that later re-appears in a lookback window, the `X-GM-RAW` search before APPEND catches it. The local cache is an optimization to skip one Gmail search per message; losing entries makes syncs slightly slower (more Gmail queries) but never produces duplicates.

### Why `import_timestamp` isn't indexed

The prune query is:

```sql
DELETE FROM seen_messages WHERE import_timestamp < datetime('now', '-90 days')
```

Without an index on `import_timestamp`, SQLite does a full table scan on each run. At realistic table sizes this is cheap:

| Table rows                             | Scan time (small box, cold cache) |
| -------------------------------------- | --------------------------------- |
| 18,000 (1 year, 1 source)              | < 10 ms                           |
| 100,000 (multi-year, multiple sources) | ~50–100 ms                        |
| 1,000,000                              | ~0.5–1.5 s                        |

The prune runs **once at startup** — a path where the daemon is already booting, opening connections, and loading config. Even 1.5 s on a million-row table is invisible next to those.

An index on `import_timestamp` would cut the prune from `O(n)` to `O(log n + k)`, but it would cost:

- Roughly 10% more disk (the index is a near-duplicate of the column).
- A small penalty on every `INSERT` into `seen_messages`, because SQLite has to maintain the extra index alongside the primary key. `INSERT` is the hot path — it runs once per synced message during a sync burst.

Optimizing a rare, cold, one-second operation at the cost of a frequent, hot per-message operation is the wrong direction. No index is the intentional default.

**When to revisit this decision:**

- `seen_messages` grows past ~5 M rows and prune starts taking 10+ seconds.
- The daemon restarts often enough (e.g., crash-restart loops) that the "rare" startup path stops being rare.
- Retention gets shortened to days or weeks, so the prune does meaningful deletion work each run.

The migration is one line in `createSchema()`:

```sql
CREATE INDEX IF NOT EXISTS idx_seen_messages_import_timestamp
  ON seen_messages (import_timestamp);
```

SQLite builds the index in place on next startup; no data migration needed.

## 8. Adding a new source type

1. Add the type name to `SourceKind` and a new `XxxSourceConfig` interface in `src/core/types.ts`.
2. Extend the discriminated union in `src/config/appConfig.ts` with a zod schema.
3. Implement `SourceProvider` in `src/providers/source/XxxSource.ts`. For push support, expose `setIdleHandler` + `startIdleWatch` / `stopIdleWatch` like `ImapSource`.
4. Add a branch in `src/providers/factories.ts#createSource`.
5. (Optional) Add a setup wizard under `tools/`.

The engine and scheduler are provider-agnostic — no changes needed there.

## 9. Locking

A single `proper-lockfile` guard around the SQLite DB path prevents two daemons, a daemon + a `reset`, or two `reset` calls from racing. `test-source` and `list` are read-only and don't take the lock.

## 10. Delete sync (optional, off by default)

The forward sync is strictly one-way: source → destination. Archive semantics mean we never touch the source. The delete-sync feature adds a narrow opt-in: **when the user deletes a message in Gmail (it lands in `[Gmail]/Trash` or `[Gmail]/Spam`), propagate that intent to the source's own Trash.**

### Why this is safe without a durable mapping

Every `APPEND` carries three markers in the raw MIME:

```
X-M2G-Content-Hash: <sha256>
X-M2G-Source:       <source-name>             e.g. yahoo-main
X-M2G-Source-ID:    <percent-encoded-id>      e.g. INBOX%0023841
```

These live **in the Gmail message**. They survive a full SQLite wipe, daemon restart, and cache eviction — the only thing that can erase them is the Gmail copy itself being permanently deleted.

The reconciliation pass (`SyncEngine.reconcileDeletions`) does the whole loop against Gmail, with no state from SQLite:

1. `SELECT [Gmail]/Trash`, then `[Gmail]/Spam`.
2. Search each for messages tagged with our source name AND lacking the `mail-to-gmail-propagated` label.
3. For each match, read `X-M2G-Source-ID` out of the stored headers and call `source.deleteMessage()` — which `MOVE`s the corresponding source message to the source's own `\Trash` folder (IMAP) or invokes Zoho's `moveToTrash` API.
4. Apply the `mail-to-gmail-propagated` label to the Gmail message so the next pass skips it.

This design means:

- **SQLite stays disposable.** The pass queries Gmail, not `seen_messages`.
- **"Empty Trash" in Gmail is safe.** If the tombstones vanish before a pass runs, the pass finds nothing to propagate and the source keeps its copy. Fail-safe.
- **Gmail account compromise has a backstop.** `maxPropagationsPerRun` (default 10) caps per-pass damage, and operators are expected to first run with `DRY_RUN=true` until the logs look right. A malicious bulk-wipe in Gmail can only propagate a small fraction per pass.
- **No ambiguity.** Because we iterate _Gmail Trash + Spam_ (not source), every candidate is already known to have been imported by us (the `X-M2G-Source-*` headers say so). There's no "never imported vs deleted" confusion.

### Config

Per source, under `deleteSync`:

```yaml
sources:
  - name: yahoo-main
    ...
    deleteSync:
      enabled: false                # default: false — opt-in
      maxPropagationsPerRun: 10     # default: 10 — safety cap per reconciliation pass
```

Dry-run behaviour is controlled by the daemon-level `DRY_RUN` env var (same switch the forward sync uses). When `DRY_RUN=true`, reconciliation logs what it _would_ do and takes no source-side writes. Once the logs look right, unset `DRY_RUN` and the next pass will actually move messages.

### When the pass runs

Delete reconciliation runs once per scheduler iteration for each enabled source, immediately after the forward sync finishes (`SyncScheduler.runSingleSource`). On runs with nothing to propagate it's cheap — two Gmail SEARCHes returning zero hits.

### Spam vs Trash

Both are scanned, but propagation is uniform: the source message always moves to the source's own `\Trash`. No source-side Spam mirroring — "user moved this out of their inbox" is the unified intent regardless of whether they clicked Delete or Report Spam in Gmail.

### Restoration mirror (undo support)

When the user restores a message from Gmail Trash back to their Inbox (or any other label), we want to un-propagate — move the source copy out of the source's Trash and back to INBOX. This is handled by a second pass, `SyncEngine.reconcileRestorations`, that runs after `reconcileDeletions`.

Core challenge: once the Gmail message leaves Trash, our header-filtered search in Trash/Spam no longer finds it. We need a separate memory of "we propagated this one" so we can later ask about it. That memory is the `propagated_tombstones` SQLite table:

```
propagated_tombstones(gmail_msg_id PRIMARY KEY, source_name, source_message_id,
                      rfc_message_id, propagated_at)
```

Populated in `reconcileDeletions` immediately after a successful propagation. The `gmail_msg_id` is the stable X-GM-MSGID / `emailId` exposed by Gmail IMAP — it survives label changes, so even after the user moves the message out of Trash we can still correlate.

The reconciliation pass walks each row and asks Gmail, via two `X-GM-RAW rfc822msgid:` searches, which of three states applies:

| Query result                               | Interpretation      | Action                                                                                |
| ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------- |
| `in:anywhere` match = 0                    | hard-deleted        | Forget the row. Leave source copy in source Trash to age out naturally.               |
| `in:anywhere` > 0, default-scope match = 0 | still in Trash/Spam | Leave the row; user hasn't acted yet.                                                 |
| `in:anywhere` > 0, default-scope match > 0 | restored            | Call `source.restoreMessage()` to move the source copy to source INBOX; drop the row. |

Rows are also aged out after 35 days (`RESTORATION_TRACKING_DAYS` in `SyncEngine.ts`) — Gmail Trash expires at 30 days, so nothing can reappear after that.

If SQLite is wiped, pending restorations for already-propagated messages are lost. No wrong action results — the source copy simply stays in the source's Trash until the user manually restores it, which is the same recovery path that exists today for any tombstone we didn't see in time.

### What it doesn't do

- **Only acts on messages imported after this feature shipped.** The `X-M2G-Source` and `X-M2G-Source-ID` headers are injected on `APPEND`. The dedup-skip path (when Gmail already has a copy matched by `rfc822msgid:` or content-hash) does not and cannot retrofit headers into existing Gmail messages — IMAP has no edit-in-place. Messages imported pre-upgrade, or deduped against a pre-existing POP3/Gmailify copy, are invisible to delete-sync forever. This is a one-way upgrade boundary.
- **No EXPUNGE.** The source move is to Trash, not a hard delete. Source providers' own retention (typically 30 days) gives the user a recovery window.
- **Restore always targets source INBOX.** Not the original source folder. Tracking the pre-delete folder through propagation/restoration would require more state; INBOX is a good-enough landing zone for ~all messages and easy to fan out from there.
- **Restore requires an RFC 5322 `Message-ID` in the Gmail copy.** IMAP sources find the trashed message in source Trash by `Message-ID` header search. If the original email lacked a Message-ID (extremely rare for Zoho/Yahoo/Outlook, possible for some auto-generated mail), the restoration is skipped and the row ages out without action.
- **Hard-delete in Gmail before 30 days is not mirrored.** If the user manually empties Gmail Trash, the source copy stays in source Trash for its provider's own retention (~30 days on Yahoo/Outlook/Zoho). They can clean it up manually if they really want it gone everywhere.
- **No UIDVALIDITY guard.** If the IMAP source rebuilds its mailbox and UIDVALIDITY changes between APPEND and reconciliation, the stored `X-M2G-Source-ID` may no longer map to the intended message. The MOVE will either fail (UID not found → caught as an error, logged, skipped) or, in a genuinely pathological collision, target a different message. UIDVALIDITY rotations are rare but this is a known sharp edge.
- **Reconciliation failures don't trip forward-sync backoff.** A thrown error from either reconcile pass is logged and swallowed at the scheduler level; the forward sync continues on its normal cadence. Delete-sync is explicitly best-effort.
