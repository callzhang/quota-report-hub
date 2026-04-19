# Quota Report Hub

Minimal Vercel app that accepts quota reports from local Codex reporter scripts and displays the latest status.

## Endpoints

- `POST /api/report`
  - Requires `Authorization: Bearer <REPORT_INGEST_TOKEN>`
  - Appends an event row and updates the latest row per `source + hostname + account_id`
- `GET /api/status`
  - Returns the current merged dataset

## Required environment variables

- `REPORT_INGEST_TOKEN`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

## Local test

```bash
npm install
npm test
```
