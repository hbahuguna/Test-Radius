---
name: QueryFirst production auth
description: Production credit accounting and payment safety when the demo identity fallback is enabled.
---

Do not enable live QueryFirst credit purchases while production's DEMO_MODE fallback resolves unauthenticated requests to one shared demo user. Valid Stripe webhooks and sessions do not prove individual account ownership.

**Why:** The published checkout accepted an unauthenticated request, which created a live-mode payment session linked to the shared demo identity. Multiple anonymous users could therefore pay into a balance no individual account owns.

**How to apply:** Before enabling credit checkout, verify the deployed app requires a real Supabase identity for checkout and that new user records receive their individual signup grant. Keep anonymous demo access and payment checkout separate; never permit live purchases through the shared identity.