# zoho-to-gmail: Technical Design Document

## 1. Provider Abstractions

To ensure `zoho-to-gmail` is extensible, we use a clean separation between the core sync logic and the specific email service implementations.

### Interfaces

- **`SourceProvider`**: Responsible for connecting to a source (like Zoho, IMAP, or Outlook), listing candidate messages since a certain checkpoint, and fetching the raw RFC822 MIME content.
- **`DestinationProvider`**: Responsible for storing the raw MIME content into a target mailbox (like Gmail or Generic IMAP).

### Registry

The system is designed to allow new providers to be registered in `src/providers`. The core engine only interacts with the interfaces, making it trivial to add an "IMAP Source" or a "Microsoft Graph Destination" in the future.

## 2. Deduplication Strategy

Preventing duplicate emails in the destination is critical for a sync tool. `zoho-to-gmail` employs a multi-layered deduplication strategy:

### Layer 1: Source Message ID

Each message in the source provider has a unique identifier. We store this ID in a local SQLite database along with the provider and account name. If we see the same ID again, we skip it.

- **Key**: `provider_id:account_id:message_id`

### Layer 2: Content Hashing (Fallback)

If a message ID changes or is not stable across certain operations, we calculate a SHA-256 hash of the **raw MIME content**. This ensures that even if the ID is different, identical content won't be imported twice.

## 3. Sync Logic & Idempotency

### Checkpoints

The sync engine maintains a "checkpoint" for each account, which stores the `receivedAt` timestamp of the last successfully imported message.

### Incremental Fetching

On each run, the engine:

1. Loads the checkpoint.
2. Lists messages from the source starting from the checkpoint (with a lookback window to handle late-arriving mail).
3. Filters candidates against the `StateStore` (seen IDs and hashes).
4. Imports new messages.
5. Updates the checkpoint.

### Locking

To prevent data corruption from overlapping cron jobs, `zoho-to-gmail` uses a file-based lock (`.db.lock`). If a sync is already in progress, new instances will exit immediately.
