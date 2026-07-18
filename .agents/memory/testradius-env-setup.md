---
name: TestRadius env setup
description: Required env vars for the api-server to function correctly
---

## Required env vars (shared, set via setEnvVars)

| Var | Purpose | Notes |
|-----|---------|-------|
| `SUPABASE_URL` | JWKS endpoint for ES256 token verification | `https://ntcaohfrebjwdtdmzrml.supabase.co` |
| `VITE_SUPABASE_URL` | Frontend Supabase client | Same value |
| `VITE_SUPABASE_ANON_KEY` | Frontend Supabase client | Anon key from Supabase dashboard |
| `ENCRYPTION_KEY` | AES-256-GCM for BYOK API key storage | 64-char hex string; stored as secret |

**Why:** The api-server auth middleware (`auth.ts`) tries JWKS (ES256) first using `SUPABASE_URL`. Without it, falls through to HS256 fallback and fails with "SUPABASE_JWT_SECRET is not configured". The crypto lib (`crypto.ts`) throws on startup if `ENCRYPTION_KEY` is absent.

**How to apply:** After any fresh DB/deploy, verify these four vars exist before debugging auth failures.
