import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  create: vi.fn(),
  getUser: vi.fn(),
  customer: vi.fn(),
}));

vi.mock("../../middlewares/auth", () => ({
  requireSignedUp: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    Object.assign(req, { user: { id: "user-1", email: "billing@example.invalid" } });
    next();
  },
}));
vi.mock("../../lib/auth", () => ({
  getOrCreateUser: mocks.getUser,
  grantStripeCredits: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@workspace/db", () => ({
  db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));
vi.mock("@workspace/db/schema", () => ({ usersTable: { id: "id" } }));
vi.mock("../../lib/stripe", () => ({
  getStripe: () => ({
    webhookEndpoints: { retrieve: mocks.retrieve },
    checkout: { sessions: { create: mocks.create } },
  }),
  getOrCreateStripeCustomer: mocks.customer,
  resolveCheckoutPrice: (id: unknown) => id === "price_credit_pack_10" ? "price_pack10" : null,
  isSubscriptionPrice: () => false,
  creditsForPrice: () => 10,
  STRIPE_PRO_MONTHLY_CREDITS: 500,
}));

const endpoint = {
  status: "enabled",
  url: "https://app.example.invalid/api/billing/webhook",
  enabled_events: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
};
let server: http.Server;
let base: string;

beforeAll(async () => {
  const { default: billing } = await import("../billing");
  const app = express();
  app.use(express.json());
  app.use("/api/billing", billing);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ORIGIN", "https://app.example.invalid");
  vi.stubEnv("STRIPE_WEBHOOK_ENDPOINT_ID", "we_fixture");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fixture");
  mocks.retrieve.mockResolvedValue(endpoint);
  mocks.getUser.mockResolvedValue({ id: "user-1", email: "billing@example.invalid" });
  mocks.customer.mockResolvedValue("cus_fixture");
  mocks.create.mockResolvedValue({ url: "https://checkout.stripe.com/fixture" });
});
afterEach(() => vi.unstubAllEnvs());

async function checkout(priceId = "price_credit_pack_10", authorized = true) {
  return fetch(`${base}/api/billing/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: "Bearer test-fixture" } : {}),
    },
    body: JSON.stringify({ priceId, returnTo: "/settings" }),
  });
}

describe("checkout waits for credit fulfillment readiness", () => {
  it("creates an authenticated one-time checkout when the matching webhook is enabled", async () => {
    expect((await checkout()).status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith("we_fixture");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "payment",
      line_items: [{ price: "price_pack10", quantity: 1 }],
      success_url: "https://app.example.invalid/settings?checkout=success",
      metadata: { userId: "user-1" },
    }));
  });

  it("blocks checkout while the webhook is paused without creating a customer", async () => {
    mocks.retrieve.mockResolvedValue({ ...endpoint, status: "disabled" });
    const response = await checkout();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "billing_not_active" });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("blocks checkout without a configured endpoint", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_ENDPOINT_ID", "");
    expect((await checkout()).status).toBe(503);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("blocks checkout without a signing secret", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect((await checkout()).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("blocks an enabled webhook targeting a different application", async () => {
    mocks.retrieve.mockResolvedValue({ ...endpoint, url: "https://other.example.invalid/webhook" });
    expect((await checkout()).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("blocks an endpoint that does not handle delayed payment success", async () => {
    mocks.retrieve.mockResolvedValue({ ...endpoint, enabled_events: ["checkout.session.completed"] });
    expect((await checkout()).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Locally the webhook arrives via `stripe listen`, not a Dashboard endpoint,
  // so requiring STRIPE_WEBHOOK_ENDPOINT_ID would block all local checkout.
  it("skips the endpoint check outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_WEBHOOK_ENDPOINT_ID", "");
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    expect((await checkout()).status).toBe(200);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      success_url: "http://localhost:3000/settings?checkout=success",
    }));
  });

  // Stripe is live-mode here, so an unverified webhook would leave a real
  // payment with no credits delivered.
  it("still requires the signing secret outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect((await checkout()).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("still requires authentication before checking readiness", async () => {
    expect((await checkout("price_credit_pack_10", false)).status).toBe(401);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown price before checking readiness", async () => {
    expect((await checkout("price_unknown")).status).toBe(400);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});