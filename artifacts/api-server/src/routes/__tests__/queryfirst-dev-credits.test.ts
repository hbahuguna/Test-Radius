import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";

// The dev top-up must be unreachable in production. That gate is evaluated at
// module load, so each case re-imports the router with a fresh module registry.
const addCredits = vi.fn();
const deductCredit = vi.fn();
const getOrCreateUser = vi.fn();

vi.mock("@workspace/db", () => ({
  db: { insert: () => ({ values: vi.fn() }), update: () => ({}), select: () => ({}) },
}));
vi.mock("@workspace/db/schema", () => ({ userApiKeysTable: {} }));
vi.mock("../../middlewares/auth", () => ({
  requireSignedUp: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/auth", () => ({
  getOrCreateUser: (...args: unknown[]) => getOrCreateUser(...args),
  deductCredit: (...args: unknown[]) => deductCredit(...args),
  refundCredits: vi.fn(),
  addCredits: (...args: unknown[]) => addCredits(...args),
}));
vi.mock("../../lib/crypto", () => ({ decryptKey: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/fieldserve-db", () => ({ getFieldServeDb: vi.fn(), FieldServeDataStore: class {} }));
vi.mock("../fieldserve-ai", () => ({ API_SPEC: "" }));
vi.mock("openai", () => ({ default: class {} }));
vi.mock("@workspace/report-gen", () => ({ generatePdfToBuffer: vi.fn() }));
vi.mock("@workspace/nlp-runner", () => ({
  ChromeLaunchError: class extends Error {},
  openDatabase: vi.fn(),
  stepToEnglish: vi.fn(),
  detectGoogleSignIn: vi.fn(),
  resolveGoogleChromePath: vi.fn(),
  resolveMode: vi.fn(),
  summarizeTestName: vi.fn(),
  uniqueTestName: vi.fn(),
}));

const REAL_ENV = { ...process.env };

async function loadRouter(env: Record<string, string | undefined>) {
  for (const key of [
    "QF_DEV_CREDITS",
    "NODE_ENV",
    "STRIPE_SECRET_KEY",
    "STRIPE_PRICE_CREDIT_PACK_10",
    "STRIPE_PRICE_CREDIT_PACK_50",
    "STRIPE_PRICE_CREDIT_PACK_200",
    "QF_GOOGLE_API_KEY",
    "GOOGLE_API_KEY",
    "QF_GOOGLE_MODEL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  vi.resetModules();
  const mod = await import("../queryfirst");
  return mod.default;
}

function makeApp(router: express.IRouter) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = { id: "user-1", email: "t@t.co" };
    next();
  });
  app.use(router);
  return app;
}

let server: ReturnType<express.Express["listen"]> | undefined;

async function post(path: string, amount: unknown = 10) {
  const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, number> | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrCreateUser.mockResolvedValue({
    id: "user-1",
    creditsRemaining: 10,
    creditsUsed: 0,
  });
  addCredits.mockResolvedValue(undefined);
});

afterEach(() => {
  server?.close();
  server = undefined;
  process.env = { ...REAL_ENV };
});

async function listen(router: express.IRouter) {
  const app = makeApp(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
}

describe("POST /queryfirst/credits/dev-grant", () => {
  it("404s when QF_DEV_CREDITS is not set", async () => {
    await listen(await loadRouter({ NODE_ENV: "development" }));
    const { status } = await post("/credits/dev-grant");
    expect(status).toBe(404);
    expect(addCredits).not.toHaveBeenCalled();
  });

  it("404s in production even if QF_DEV_CREDITS is true", async () => {
    await listen(await loadRouter({ NODE_ENV: "production", QF_DEV_CREDITS: "true" }));
    const { status } = await post("/credits/dev-grant");
    expect(status).toBe(404);
    expect(addCredits).not.toHaveBeenCalled();
  });

  it("404s when QF_DEV_CREDITS is any non-true value", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "yes" }));
    expect((await post("/credits/dev-grant")).status).toBe(404);
    expect(addCredits).not.toHaveBeenCalled();
  });

  it("grants credits locally when explicitly enabled", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    getOrCreateUser.mockResolvedValue({ id: "user-1", creditsRemaining: 20, creditsUsed: 0 });

    const { status, body } = await post("/credits/dev-grant");
    expect(status).toBe(200);
    expect(addCredits).toHaveBeenCalledWith("user-1", 10, "dev_grant");
    expect(body).toMatchObject({ granted: 10, credits_remaining: 20 });
  });

  it("rejects a zero or non-numeric amount", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));

    for (const amount of [0, "abc", null, undefined]) {
      const res = await fetch(
        `http://127.0.0.1:${(server!.address() as { port: number }).port}/credits/dev-grant`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount }) },
      );
      expect(res.status).toBe(400);
    }
    expect(addCredits).not.toHaveBeenCalled();
    expect(deductCredit).not.toHaveBeenCalled();
  });

  it("drains credits when the amount is negative", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    getOrCreateUser
      .mockResolvedValueOnce({ id: "user-1", creditsRemaining: 79, creditsUsed: 1 })
      .mockResolvedValueOnce({ id: "user-1", creditsRemaining: 69, creditsUsed: 11 });

    const { status, body } = await post("/credits/dev-grant", -10);
    expect(status).toBe(200);
    expect(deductCredit).toHaveBeenCalledWith("user-1", "dev_drain", undefined, 10);
    expect(addCredits).not.toHaveBeenCalled();
    expect(body).toMatchObject({ granted: -10, credits_remaining: 69 });
  });

  // The drain exists to reach the low-balance UI; it must never push the
  // account negative, or runs would stop reporting insufficient_credits.
  it("clamps a drain at the current balance", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    getOrCreateUser
      .mockResolvedValueOnce({ id: "user-1", creditsRemaining: 3, creditsUsed: 0 })
      .mockResolvedValueOnce({ id: "user-1", creditsRemaining: 0, creditsUsed: 3 });

    const { status, body } = await post("/credits/dev-grant", -50);
    expect(status).toBe(200);
    expect(deductCredit).toHaveBeenCalledWith("user-1", "dev_drain", undefined, 3);
    expect(body).toMatchObject({ granted: -3, credits_remaining: 0 });
  });

  it("is a no-op when draining an already empty balance", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    getOrCreateUser.mockResolvedValue({ id: "user-1", creditsRemaining: 0, creditsUsed: 0 });

    const { status, body } = await post("/credits/dev-grant", -10);
    expect(status).toBe(200);
    expect(deductCredit).not.toHaveBeenCalled();
    expect(body).toMatchObject({ granted: 0, credits_remaining: 0 });
  });

  it("clamps a drain to the 100 credit ceiling", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    getOrCreateUser
      .mockResolvedValueOnce({ id: "user-1", creditsRemaining: 500, creditsUsed: 0 })
      .mockResolvedValueOnce({ id: "user-1", creditsRemaining: 400, creditsUsed: 0 });

    await post("/credits/dev-grant", -100000);
    expect(deductCredit).toHaveBeenCalledWith("user-1", "dev_drain", undefined, 100);
  });

  it("still 404s a negative drain in production", async () => {
    await listen(await loadRouter({ NODE_ENV: "production", QF_DEV_CREDITS: "true" }));
    const { status } = await post("/credits/dev-grant", -10);
    expect(status).toBe(404);
    expect(deductCredit).not.toHaveBeenCalled();
  });

  it("clamps the grant to the 100 credit ceiling", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    const res = await fetch(
      `http://127.0.0.1:${(server!.address() as { port: number }).port}/credits/dev-grant`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 100000 }) },
    );
    expect(res.status).toBe(200);
    expect(addCredits).toHaveBeenCalledWith("user-1", 100, "dev_grant");
  });
});

describe("GET /queryfirst/credits", () => {
  it("advertises the dev buttons only when enabled", async () => {
    await listen(await loadRouter({ NODE_ENV: "development", QF_DEV_CREDITS: "true" }));
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ credits_remaining: 10, credits_per_run: 2, dev_grant_enabled: true });
  });

  it("hides the dev buttons in production", async () => {
    await listen(await loadRouter({ NODE_ENV: "production", QF_DEV_CREDITS: "true" }));
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({ dev_grant_enabled: false });
  });

  it("falls back to the placeholder price id when Stripe is unconfigured", async () => {
    await listen(await loadRouter({ NODE_ENV: "development" }));
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({
      price_credit_pack_10: "price_credit_pack_10",
      stripe_configured: false,
    });
  });

  // Regression guard: the client must never be handed a hardcoded placeholder
  // once a real Stripe id is set, or checkout would 500 and the webhook would
  // credit nothing (CREDIT_PACKS is keyed off the env var).
  it("serves the real price id when one is configured", async () => {
    await listen(
      await loadRouter({
        NODE_ENV: "development",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_WEBHOOK_SECRET: "whsec_test_123",
        STRIPE_PRICE_CREDIT_PACK_10: "price_1RealId",
      }),
    );
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({
      price_credit_pack_10: "price_1RealId",
      stripe_configured: true,
    });
  });

  it("offers every configured pack so the UI can show all three options", async () => {
    await listen(
      await loadRouter({
        NODE_ENV: "development",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_WEBHOOK_SECRET: "whsec_test_123",
        STRIPE_PRICE_CREDIT_PACK_10: "price_1Ten",
        STRIPE_PRICE_CREDIT_PACK_50: "price_1Fifty",
        STRIPE_PRICE_CREDIT_PACK_200: "price_1TwoHundred",
      }),
    );
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({
      credit_packs: [
        { credits: 10, price_id: "price_1Ten" },
        { credits: 50, price_id: "price_1Fifty" },
        { credits: 200, price_id: "price_1TwoHundred" },
      ],
      price_credit_pack_10: "price_1Ten",
      stripe_configured: true,
    });
  });

  it("omits packs with no configured price rather than offering a broken one", async () => {
    await listen(
      await loadRouter({
        NODE_ENV: "development",
        STRIPE_SECRET_KEY: "sk_test_123",
        STRIPE_WEBHOOK_SECRET: "whsec_test_123",
        STRIPE_PRICE_CREDIT_PACK_10: "price_1Ten",
        STRIPE_PRICE_CREDIT_PACK_50: "price_1Fifty",
      }),
    );
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    const body = await res.json();
    // The 200 pack is absent entirely: offering it would send a placeholder id
    // to Stripe and 500 at checkout.
    expect(body.credit_packs).toEqual([
      { credits: 10, price_id: "price_1Ten" },
      { credits: 50, price_id: "price_1Fifty" },
    ]);
    // One real pack is still sellable, so checkout stays enabled.
    expect(body.stripe_configured).toBe(true);
  });

  // Regression guard: an empty-string QF_GOOGLE_API_KEY must not shadow a real
  // GOOGLE_API_KEY. With `??` the empty string won, platform mode silently
  // turned off, and credit-metered runs failed demanding a poolside BYOK key.
  it("falls back to GOOGLE_API_KEY when QF_GOOGLE_API_KEY is blank", async () => {
    await listen(
      await loadRouter({
        NODE_ENV: "development",
        QF_GOOGLE_API_KEY: "",
        GOOGLE_API_KEY: "platform-key",
        QF_GOOGLE_MODEL: "gemini-3.5-flash",
      }),
    );
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({ platform_model: "gemini-3.5-flash" });
  });

  it("prefers QF_GOOGLE_API_KEY when both are set", async () => {
    await listen(
      await loadRouter({
        NODE_ENV: "development",
        QF_GOOGLE_API_KEY: "qf-key",
        GOOGLE_API_KEY: "platform-key",
        QF_GOOGLE_MODEL: "gemini-3.5-flash",
      }),
    );
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({ platform_model: "gemini-3.5-flash" });
  });

  it("treats a whitespace-only key as unset", async () => {
    await listen(
      await loadRouter({
        NODE_ENV: "development",
        QF_GOOGLE_API_KEY: "   ",
        GOOGLE_API_KEY: "   ",
      }),
    );
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({ platform_model: null });
  });

  it("does not enable checkout before webhook verification is configured", async () => {
    await listen(await loadRouter({
      NODE_ENV: "development",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_PRICE_CREDIT_PACK_10: "price_1RealId",
      STRIPE_WEBHOOK_SECRET: "",
    }));
    const res = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/credits`);
    expect(await res.json()).toMatchObject({ stripe_configured: false });
  });
});
