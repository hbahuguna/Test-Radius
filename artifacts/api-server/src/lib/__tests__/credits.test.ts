import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the drizzle query builder with an in-memory users table so we can assert
// on the WHERE guard that makes deductCredit atomic.
interface MockUser {
  id: string;
  credits_remaining: number;
  credits_used: number;
}

let users: MockUser[] = [];
let ledger: Array<{ userId: string; amount: number; reason: string }> = [];

const usersTable = {
  id: "users",
  creditsRemaining: "users.credits_remaining",
  creditsUsed: "users.credits_used",
};

const creditLedgerTable = {
  userId: "user_id",
  amount: "amount",
  reason: "reason",
  runId: "run_id",
};

/**
 * Flattens a `sql` fragment (as produced by the mocked tag below) into a
 * comparable string so the in-memory UPDATE can be evaluated.
 */
function renderSql(fragment: SqlFragment): string {
  const { parts, values } = fragment;
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < values.length) out += String(values[i] ?? "");
  }
  return out.replace(/\s+/g, " ").trim();
}

interface SqlFragment {
  parts: readonly string[];
  values: readonly unknown[];
}

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: async (row: unknown) => {
        ledger.push(row as never);
      },
    }),
    update: () => {
      // Per-UPDATE state: the row change and the guard are captured as the
      // chain is built, mirroring how drizzle assembles the statement.
      let setValues: Record<string, SqlFragment> = {};
      let guard: { kind: string; val?: unknown } | undefined;

      const chain: Record<string, unknown> = {
        set(values: Record<string, unknown>) {
          setValues = values as Record<string, SqlFragment>;
          return chain;
        },
        where(cond: { kind: string; conds?: Array<{ kind: string; val?: unknown }>; val?: unknown }) {
          guard = cond.kind === "and" ? cond.conds?.find((c) => c.kind === "gte") : cond;
          return chain;
        },
        async returning() {
          const idx = users.findIndex((u) => u.id === "user-1");
          if (idx < 0) return [];
          const row = users[idx];
          if (guard?.kind === "gte" && row.credits_remaining < Number(guard.val)) return [];

          const next = { ...row };
          const rem = renderSql(setValues.creditsRemaining);
          const used = renderSql(setValues.creditsUsed);

          const remMatch = /^users\.credits_remaining ([-+]) (\d+)$/.exec(rem);
          if (remMatch) {
            const delta = Number(remMatch[2]);
            next.credits_remaining += remMatch[1] === "-" ? -delta : delta;
          }
          const usedPlus = /^users\.credits_used \+ (\d+)$/.exec(used);
          const usedGreatest = /^GREATEST\(0, users\.credits_used - (\d+)\)$/.exec(used);
          if (usedPlus) {
            next.credits_used += Number(usedPlus[1]);
          } else if (usedGreatest) {
            next.credits_used = Math.max(0, next.credits_used - Number(usedGreatest[1]));
          }

          users[idx] = next;
          return [{ creditsRemaining: next.credits_remaining }];
        },
      };
      return chain;
    },
  },
}));

vi.mock("@workspace/db/schema", () => ({
  usersTable,
  creditLedgerTable,
  couponsTable: {},
  couponRedemptionsTable: {},
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    // Keep the real tag but capture its chunks so the mock DB can evaluate them.
    sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({
      parts: Array.from(parts),
      values,
    }),
    eq: (_col: unknown, val: unknown) => ({ kind: "eq", val }),
    and: (...conds: unknown[]) => ({ kind: "and", conds: conds as Array<{ kind: string; val: unknown }> }),
    gte: (_col: unknown, val: unknown) => ({ kind: "gte", val }),
  };
});

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { deductCredit, refundCredits } = await import("../auth");

beforeEach(() => {
  users = [{ id: "user-1", credits_remaining: 10, credits_used: 0 }];
  ledger = [];
});

describe("deductCredit", () => {
  it("charges the given amount and writes a negative ledger row", async () => {
    expect(await deductCredit("user-1", "qf_record", undefined, 2)).toBe(true);
    expect(users[0].credits_remaining).toBe(8);
    expect(users[0].credits_used).toBe(2);
    expect(ledger).toEqual([{ userId: "user-1", amount: -2, reason: "qf_record", runId: undefined }]);
  });

  it("defaults to a single credit so existing callers are unchanged", async () => {
    expect(await deductCredit("user-1", "run")).toBe(true);
    expect(users[0].credits_remaining).toBe(9);
    expect(ledger[0].amount).toBe(-1);
  });

  it("refuses and leaves the balance untouched when short", async () => {
    users[0].credits_remaining = 1;

    expect(await deductCredit("user-1", "qf_record", undefined, 2)).toBe(false);
    expect(users[0].credits_remaining).toBe(1);
    expect(users[0].credits_used).toBe(0);
    expect(ledger).toHaveLength(0);
  });

  it("guards the balance in the UPDATE so concurrent charges cannot overdraw", async () => {
    users[0].credits_remaining = 2;

    // Two 2-credit charges against a 2-credit balance. The second must lose,
    // rather than both passing a separate SELECT check.
    expect(await deductCredit("user-1", "qf_record", undefined, 2)).toBe(true);
    expect(await deductCredit("user-1", "qf_record", undefined, 2)).toBe(false);
    expect(users[0].credits_remaining).toBe(0);
    expect(ledger).toHaveLength(1);
  });

  it("lets a user spend down to exactly zero, not one credit short", async () => {
    users[0].credits_remaining = 2;
    expect(await deductCredit("user-1", "qf_record", undefined, 2)).toBe(true);
    expect(users[0].credits_remaining).toBe(0);
  });

  it("is a no-op for a non-positive amount", async () => {
    expect(await deductCredit("user-1", "qf_record", undefined, 0)).toBe(true);
    expect(users[0].credits_remaining).toBe(10);
    expect(ledger).toHaveLength(0);
  });
});

describe("refundCredits", () => {
  it("gives the credits back and mirrors the charge into the ledger", async () => {
    users[0].credits_remaining = 8;
    users[0].credits_used = 2;

    await refundCredits("user-1", "qf_refund_record_failed", undefined, 2);

    expect(users[0].credits_remaining).toBe(10);
    expect(users[0].credits_used).toBe(0);
    expect(ledger).toEqual([
      { userId: "user-1", amount: 2, reason: "qf_refund_record_failed", runId: undefined },
    ]);
  });

  it("never drives credits_used negative", async () => {
    users[0].credits_used = 0;

    await refundCredits("user-1", "qf_refund_replay_failed", undefined, 2);

    expect(users[0].credits_used).toBe(0);
    expect(users[0].credits_remaining).toBe(12);
  });

  it("round-trips a charge back to the starting balance", async () => {
    await deductCredit("user-1", "qf_browse", undefined, 2);
    await refundCredits("user-1", "qf_refund_browse_failed", undefined, 2);

    expect(users[0].credits_remaining).toBe(10);
    expect(users[0].credits_used).toBe(0);
    expect(ledger.map((r) => r.amount)).toEqual([-2, 2]);
  });
});
