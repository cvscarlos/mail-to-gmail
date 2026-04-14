# mail-bridge

A production-quality, extensible one-way email sync tool that copies messages from Zoho Mail to Gmail.

## Why mail-bridge?

Zoho Mail's free tier often restricts POP/IMAP access. `mail-bridge` uses the Zoho Mail REST API (via OAuth 2.0) to fetch messages and appends them directly to your Gmail mailbox via IMAP with an App Password. This ensures reliable sync without forwarding or POP/IMAP on the source side.

## Features

- **One-Way Sync:** Zoho -> Gmail.
- **Idempotent:** Safe to run every 5 minutes.
- **Deduplication:** Uses source message IDs and content hashes.
- **MIME Preservation:** Copies original raw email content.
- **Extensible:** Architecture allows adding new source/destination providers easily.

## Setup Guide

### 1. Zoho OAuth Setup
1. Go to the [Zoho API Console](https://api-console.zoho.com/).
2. Create a **Self Client**.
3. Copy the **Client ID** and **Client Secret**.
4. In the "Generate Code" tab, use the scope `ZohoMail.messages.READ,ZohoMail.accounts.READ`.
5. Exchange the generated code for a **Refresh Token** using `curl` or a tool like Postman.

### 2. Gmail Setup
1. Enable **IMAP** in your Gmail settings.
2. Create an **App Password** in your Google Account security settings.

### 3. Configuration
Copy `.env.example` to `.env` and fill in your credentials.

```bash
cp .env.example .env
```

### 4. Running the Sync

#### Using Node.js
```bash
npm install
npm start sync
```

#### Using Docker
```bash
docker build -t mail-bridge .
docker run --env-file .env -v $(pwd)/data:/app/data mail-bridge sync
```

## Scheduler
Since `mail-bridge` exposes a single "sync once" command, you can run it every 5 minutes using cron:

```bash
*/5 * * * * /path/to/mail-bridge sync
```

## Architecture
- `src/core/`: Interfaces, Sync Engine, State Management.
- `src/providers/`: Zoho and Gmail specific implementations.
- `src/utils/`: Logger, Config validation, Retry logic.
