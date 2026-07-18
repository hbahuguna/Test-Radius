---
name: TestRadius DB bootstrap
description: DB schema push is required before any API calls work; tables are not auto-migrated.
---

## Problem
The Replit PostgreSQL DB starts completely empty. The `users`, `user_api_keys`, `agentic_runs`, and `credit_ledger` tables must be explicitly pushed.

## Fix
```bash
pnpm --filter @workspace/db run push
```

**Why:** `drizzle-kit push` is not run automatically. Without it, every DB query throws "relation does not exist" and the api-server returns 500 on all authenticated routes.

**How to apply:** Run this once after any fresh environment setup or when tables are missing. Safe to re-run (drizzle checks current schema before applying changes).

## Auto-provision fix
`requireSignedUp` middleware was changed from `allowCreate: false` to `allowCreate: true` so authenticated users are auto-provisioned on first API call, rather than getting 403 `signup_required` if the provision step was missed during OAuth flow.
