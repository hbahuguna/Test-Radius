import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

/**
 * Regression guard for the Stripe webhook raw-body ordering bug.
 *
 * `stripe.webhooks.constructEvent` needs the *unparsed* request body. Express
 * middleware is first-match-wins, so mounting express.json() before the
 * webhook's express.raw() consumes the stream, leaving req.body as a plain
 * object and making signature verification impossible — every webhook 400s and
 * purchased credits are never granted, even though payment succeeded.
 *
 * There is no app-level test harness (app.ts pulls in the whole router tree), so
 * this pins the invariant two ways: the source ordering, and the actual
 * constructEvent contract that ordering exists to satisfy.
 */
const appSource = readFileSync(
  fileURLToPath(new URL("../app.ts", import.meta.url)),
  "utf8",
);

describe("Stripe webhook body parsing", () => {
  it("mounts express.raw() for the webhook before express.json()", () => {
    // Match the mount calls themselves, not the prose in the comment above them.
    const rawIndex = appSource.search(/app\.use\([^)]*express\.raw\(/);
    const jsonIndex = appSource.search(/app\.use\(\s*express\.json\(\)\s*\)/);

    expect(rawIndex).toBeGreaterThan(-1);
    expect(jsonIndex).toBeGreaterThan(-1);
    expect(rawIndex).toBeLessThan(jsonIndex);
  });

  it("routes the raw parser at the webhook path", () => {
    expect(appSource).toMatch(/app\.use\(\s*"\/api\/billing\/webhook"\s*,\s*express\.raw\(/);
  });

  it("accepts a validly signed payload when raw() is mounted first", () => {
    const stripe = new Stripe("sk_test_dummy");
    const secret = "whsec_test_secret";
    const payload = JSON.stringify({
      id: "evt_test_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", object: "checkout.session", metadata: { userId: "u1" } } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });

    // Buffer stands in for the raw request body express.raw() would hand over.
    const event = stripe.webhooks.constructEvent(Buffer.from(payload), signature, secret);
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a parsed object, which is exactly what the bad ordering produces", () => {
    const stripe = new Stripe("sk_test_dummy");
    const secret = "whsec_test_secret";
    const payload = JSON.stringify({ id: "evt_test_1", object: "event", type: "checkout.session.completed" });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });

    expect(() => stripe.webhooks.constructEvent(JSON.parse(payload), signature, secret)).toThrow();
  });
});
