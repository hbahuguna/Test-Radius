---
name: Stripe credential handoff
description: Distinguishes Stripe connector authorization from configuration of the existing direct-key billing flow.
---

Do not treat an added Stripe connection as proof that the application's named Stripe secrets are configured. Connector authorization supports account provisioning, but does not automatically populate STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET for an existing direct-key implementation.

**Why:** Both secrets remained absent after Stripe was successfully connected and account API calls worked. The application's checkout requires separate secure credential intake.

**How to apply:** Check secret existence using the secure environment tools. Request missing values through the Secrets form, never chat or source files. Ensure the API key, price IDs, and webhook signing secret belong to the same Stripe account and mode. Preserve the existing billing architecture during configuration-only requests rather than replacing it with managed synchronization without agreement.