---
name: Stripe credential handoff
description: Distinguishes Stripe connector authorization from configuration of the existing direct-key billing flow.
---

Do not treat an added Stripe connection as proof that the application's named Stripe secrets are configured. Connector authorization supports account provisioning, but does not automatically populate STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET for an existing direct-key implementation.

**Why:** Both secrets remained absent after Stripe was successfully connected and account API calls worked. The application's checkout requires separate secure credential intake.

**How to apply:** Check secret existence using the secure environment tools. Request missing values through the Secrets form, never chat or source files. Ensure the API key, price IDs, and webhook signing secret belong to the same Stripe account and mode. Preserve the existing billing architecture during configuration-only requests rather than replacing it with managed synchronization without agreement.

Do not assume the Stripe connector and a separately supplied application key address the same account.

**Why:** The connector provisioned a price in a test-mode account, while the supplied application key authenticated to a different live account. Checkout then failed with “No such price” even though each credential worked independently.

**How to apply:** Before provisioning or activating payments, compare non-secret account identifiers and mode through the connector API and the application's initialized Stripe client. Do not inspect key values. Align the catalog, checkout client and webhook within the chosen account/mode, and confirm the intended mode with the user before switching from testing to real payments.

QueryFirst credit purchases are intended to use the user's live Stripe account, not the connector's separate test account.

**Why:** The user explicitly chose live mode for real payments after the account/mode mismatch was explained.

**How to apply:** Preserve that choice during future billing configuration. Reuse matching one-time credit-pack prices from the application account; do not substitute similarly named recurring prices or silently return to the connector's sandbox.

Workspace secret existence is not proof that the current published server has those secrets.

**Why:** Development checkout and signature verification succeeded, while the published server reported a missing Stripe API key. The production existence tool included shared keys even though the running deployment lacked them. Replit documentation identifies deployment secrets as a separate publishing configuration.

**How to apply:** Have the user ensure both Stripe secrets are included under Publishing → Adjust settings before republishing. Verify a benign signed request against the published webhook before enabling it; do not rely only on the workspace or production existence flags.