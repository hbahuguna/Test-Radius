import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";
import express from "express";
import http from "node:http";

/**
 * Guards the checkout.session.completed credit grant.
 *
 * Two things this pins down:
 *
 * 1. A webhook payload embeds the session WITHOUT `line_items` populated (that
 *    field only exists when explicitly expanded). An earlier version gated on
 *    `session.line_items`, so every genuine purchase fell through and no credits
 *    were ever granted — invisible in tests, because a hand-built fixture that
 *    included line_items passed.
 *
 * 2. Signature verification must reject tampered bodies, otherwise anyone who
 *    learns the endpoint URL can mint themselves credits by forging an event.
 */

const addCredits = vi.fn();
const listLineItems = vi.fn();
const constructEvent = vi.fn();

vi.mock("../../middlewares/auth", () => ({
  requireSignedUp: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/auth", () => ({
  getOrCreateUser: vi.fn(),
  addCredits: (...args: unknown[]) => addCredits(...args),
}));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@workspace/db", () => ({ db: {} }));
vi.mock("@workspace/db/schema", () => ({ usersTable: {}, creditLedgerTable: {} }));
vi.mock("../../lib/stripe", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
    checkout: { sessions: { listLineItems: (...a: unknown[]) => listLineItems(...a) } },
  }),
  getOrCreateStripeCustomer: vi.fn(),
  creditsForPrice: (priceId: string) => (priceId === "price_pack10" ? 10 : null),
  isSubscriptionPrice: () => false,
  STRIPE_PRO_MONTHLY_CREDITS: 500,
}));

const SECRET = "whsec_test_secret";

/** Exactly what Stripe sends: session object with NO line_items field. */
function realWorldPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        metadata: { userId: "user-1" },
        ...overrides,
      },
    },
  });
}

async function deliver(payload: string, signature: string | null) {
  const { default: billing } = await import("../billing");
  // Mirror app.ts: the raw parser is mounted at the absolute webhook path, and
  // the billing router is mounted under /billing — so /api/billing/webhook lines
  // up. Mounting the router straight at /api would 404 here.
  const app = express();
  app.use("/api/billing/webhook", express.raw({ type: "application/json" }));
  app.use("/api/billing", billing);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "stripe-signature": signature } : {}),
    },
    body: payload,
  });
  server.close();
  return res;
}

beforeEach(() => {
  addCredits.mockReset();
  listLineItems.mockReset();
  constructEvent.mockReset();
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

describe("checkout.session.completed credit grant", () => {
  it("grants credits from a real-world payload that has no line_items field", async () => {
    // The real Stripe SDK signs and verifies, so this exercises the same
    // constructEvent the route uses rather than a stubbed version.
    const stripe = new Stripe("sk_test_dummy");
    const payload = realWorldPayload();
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

    // Route calls the mocked stripe client; make it verify for real.
    constructEvent.mockImplementation((body: Buffer, sig: string, secret: string) =>
      stripe.webhooks.constructEvent(body, sig, secret),
    );
    listLineItems.mockResolvedValue({ data: [{ price: { id: "price_pack10" } }] });

    const res = await deliver(payload, signature);

    expect(res.status).toBe(200);
    expect(listLineItems).toHaveBeenCalledWith("cs_test_1");
    expect(addCredits).toHaveBeenCalledWith("user-1", 10, "purchase");
  });

  it("rejects a tampered payload with 400 and grants nothing", async () => {
    const stripe = new Stripe("sk_test_dummy");
    constructEvent.mockImplementation((body: Buffer, sig: string, secret: string) =>
      stripe.webhooks.constructEvent(body, sig, secret),
    );
    const tampered = realWorldPayload({ metadata: { userId: "attacker" } });

    const res = await deliver(tampered, "whsec_bogus.signature");

    expect(res.status).toBe(400);
    expect(addCredits).not.toHaveBeenCalled();
  });

  it("does not grant when payment_status is unpaid", async () => {
    const stripe = new Stripe("sk_test_dummy");
    const payload = realWorldPayload({ payment_status: "unpaid" });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    constructEvent.mockImplementation((body: Buffer, sig: string, secret: string) =>
      stripe.webhooks.constructEvent(body, sig, secret),
    );

    const res = await deliver(payload, signature);

    expect(res.status).toBe(200);
    expect(addCredits).not.toHaveBeenCalled();
  });

  it("does not grant for a subscription-mode session", async () => {
    const stripe = new Stripe("sk_test_dummy");
    const payload = realWorldPayload({ mode: "subscription" });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    constructEvent.mockImplementation((body: Buffer, sig: string, secret: string) =>
      stripe.webhooks.constructEvent(body, sig, secret),
    );

    const res = await deliver(payload, signature);

    expect(res.status).toBe(200);
    expect(addCredits).not.toHaveBeenCalled();
  });

  it("does not grant when the price is not a known credit pack", async () => {
    const stripe = new Stripe("sk_test_dummy");
    const payload = realWorldPayload();
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    constructEvent.mockImplementation((body: Buffer, sig: string, secret: string) =>
      stripe.webhooks.constructEvent(body, sig, secret),
    );
    listLineItems.mockResolvedValue({ data: [{ price: { id: "price_someone_elses" } }] });

    const res = await deliver(payload, signature);

    expect(res.status).toBe(200);
    expect(addCredits).not.toHaveBeenCalled();
  });
});