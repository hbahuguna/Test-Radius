import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockUser {
  id: string;
  credits_remaining: number;
}

interface MockLedgerEntry {
  userId: string;
  amount: number;
  reason: string;
  stripeReference: string;
}

interface SqlFragment {
  parts: readonly string[];
  values: readonly unknown[];
}

interface MockState {
  users: MockUser[];
  ledger: MockLedgerEntry[];
  transactionCount: number;
  insertAttempts: Array<{
    row: MockLedgerEntry;
    conflictTarget?: unknown;
  }>;
  updates: Array<{
    setValues: Record<string, SqlFragment>;
    userId?: unknown;
  }>;
  updateFailure?: Error;
}

const state: MockState = {
  users: [],
  ledger: [],
  transactionCount: 0,
  insertAttempts: [],
  updates: [],
};

const usersTable = {
  id: "users.id",
  creditsRemaining: "users.credits_remaining",
};

const creditLedgerTable = {
  id: "credit_ledger.id",
  stripeReference: "credit_ledger.stripe_reference",
};

function makeTransaction() {
  return {
    insert: () => {
      let row: MockLedgerEntry | undefined;
      let conflictTarget: unknown;
      const chain = {
        values(value: MockLedgerEntry) {
          row = value;
          return chain;
        },
        onConflictDoNothing(options: { target: unknown }) {
          conflictTarget = options.target;
          return chain;
        },
        async returning() {
          const ledgerRow = row;
          if (!ledgerRow) throw new Error("Ledger values were not provided");
          state.insertAttempts.push({ row: ledgerRow, conflictTarget });
          if (state.ledger.some((entry) => entry.stripeReference === ledgerRow.stripeReference)) {
            return [];
          }
          state.ledger.push(ledgerRow);
          return [{ id: state.ledger.length }];
        },
      };
      return chain;
    },
    update: () => {
      let setValues: Record<string, SqlFragment> = {};
      let userId: unknown;
      const chain = {
        set(values: Record<string, SqlFragment>) {
          setValues = values;
          return chain;
        },
        where(condition: { kind: string; val?: unknown }) {
          userId = condition.val;
          return chain;
        },
        async returning() {
          state.updates.push({ setValues, userId });
          if (state.updateFailure) throw state.updateFailure;

          const user = state.users.find((candidate) => candidate.id === userId);
          if (!user) return [];

          const fragment = setValues.creditsRemaining;
          const expression = renderSql(fragment);
          const match = /^users\.credits_remaining \+ (\d+)$/.exec(expression);
          if (!match) throw new Error(`Unexpected balance SQL: ${expression}`);
          user.credits_remaining += Number(match[1]);
          return [{ id: user.id }];
        },
      };
      return chain;
    },
  };
}

function renderSql(fragment: SqlFragment): string {
  let output = "";
  for (let index = 0; index < fragment.parts.length; index++) {
    output += fragment.parts[index];
    if (index < fragment.values.length) output += String(fragment.values[index] ?? "");
  }
  return output.replace(/\s+/g, " ").trim();
}

vi.mock("@workspace/db", () => ({
  db: {
    async transaction<T>(callback: (tx: ReturnType<typeof makeTransaction>) => Promise<T>): Promise<T> {
      state.transactionCount++;
      const usersSnapshot = state.users.map((user) => ({ ...user }));
      const ledgerSnapshot = state.ledger.map((entry) => ({ ...entry }));
      try {
        return await callback(makeTransaction());
      } catch (error) {
        state.users = usersSnapshot;
        state.ledger = ledgerSnapshot;
        throw error;
      }
    },
  },
}));

vi.mock("@workspace/db/schema", () => ({
  usersTable,
  creditLedgerTable,
  couponsTable: {},
  couponRedemptionsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({
    parts: Array.from(parts),
    values,
  }),
  eq: (_column: unknown, value: unknown) => ({ kind: "eq", val: value }),
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  gte: (_column: unknown, value: unknown) => ({ kind: "gte", val: value }),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { grantStripeCredits } = await import("../auth");

beforeEach(() => {
  state.users = [{ id: "user-1", credits_remaining: 10 }];
  state.ledger = [];
  state.transactionCount = 0;
  state.insertAttempts = [];
  state.updates = [];
  state.updateFailure = undefined;
});

describe("grantStripeCredits", () => {
  it("records the Stripe reference and applies the balance increment in one transaction", async () => {
    expect(await grantStripeCredits("user-1", 7, "purchase", "cs_test_123")).toBe(true);

    expect(state.transactionCount).toBe(1);
    expect(state.ledger).toEqual([
      { userId: "user-1", amount: 7, reason: "purchase", stripeReference: "cs_test_123" },
    ]);
    expect(state.users[0].credits_remaining).toBe(17);
    expect(state.updates).toHaveLength(1);
    expect(renderSql(state.updates[0].setValues.creditsRemaining)).toBe(
      "users.credits_remaining + 7",
    );
    expect(state.updates[0].userId).toBe("user-1");
    expect(state.insertAttempts[0].conflictTarget).toBe(creditLedgerTable.stripeReference);
  });

  it("returns false for an already-granted reference without changing the balance", async () => {
    state.ledger.push({
      userId: "user-1",
      amount: 5,
      reason: "purchase",
      stripeReference: "cs_test_existing",
    });

    expect(await grantStripeCredits("user-1", 5, "purchase", "cs_test_existing")).toBe(false);

    expect(state.users[0].credits_remaining).toBe(10);
    expect(state.ledger).toHaveLength(1);
    expect(state.updates).toHaveLength(0);
    expect(state.insertAttempts[0].conflictTarget).toBe(creditLedgerTable.stripeReference);
  });

  it("uses the unique-reference conflict path for concurrent duplicate deliveries", async () => {
    const results = await Promise.all([
      grantStripeCredits("user-1", 9, "subscription", "in_test_concurrent"),
      grantStripeCredits("user-1", 9, "subscription", "in_test_concurrent"),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(state.transactionCount).toBe(2);
    expect(state.insertAttempts).toHaveLength(2);
    expect(state.insertAttempts.every(
      (attempt) => attempt.conflictTarget === creditLedgerTable.stripeReference,
    )).toBe(true);
    expect(state.ledger).toHaveLength(1);
    expect(state.users[0].credits_remaining).toBe(19);
    expect(state.updates).toHaveLength(1);
  });

  it("rejects invalid amounts and an empty reference before opening a transaction", async () => {
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(grantStripeCredits("user-1", amount, "purchase", "cs_test_invalid"))
        .rejects.toThrow("Invalid Stripe credit grant");
    }
    await expect(grantStripeCredits("user-1", 1, "purchase", ""))
      .rejects.toThrow("Invalid Stripe credit grant");

    expect(state.transactionCount).toBe(0);
    expect(state.insertAttempts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("propagates a database failure and rolls back the ledger insert", async () => {
    const databaseError = new Error("database unavailable");
    state.updateFailure = databaseError;

    await expect(grantStripeCredits("user-1", 4, "purchase", "cs_test_retry"))
      .rejects.toBe(databaseError);

    expect(state.transactionCount).toBe(1);
    expect(state.ledger).toHaveLength(0);
    expect(state.users[0].credits_remaining).toBe(10);
    expect(state.insertAttempts).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
  });
});