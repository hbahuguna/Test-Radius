import { db } from "@workspace/db";
import { usersTable, creditLedgerTable, couponsTable, couponRedemptionsTable } from "@workspace/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import type { AuthedUser } from "../middlewares/auth";
import { logger } from "../lib/logger";

export class CouponError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const FREE_SIGNUP_CREDITS = 10;

export interface UserRecord {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  creditsRemaining: number;
  creditsUsed: number;
  plan: string;
  modelProvider: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

/**
 * Get or create a user record from an authenticated Supabase user.
 * On first sight, provisions the user with the free signup credit bundle.
 *
 * Pass `allowCreate: false` for login-only flows: a brand-new Supabase auth
 * user who has never signed up will NOT be provisioned and `null` is returned,
 * forcing the caller to reject with "sign up first".
 */
export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

export async function getOrCreateUser(
  authUser: AuthedUser,
  opts?: { allowCreate?: boolean },
): Promise<UserRecord | null> {
  const allowCreate = opts?.allowCreate ?? true;

  try {
    const existing = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, authUser.id))
      .limit(1);

    if (existing.length > 0) {
      const u = existing[0];
      await db
        .update(usersTable)
        .set({ lastLogin: new Date(), email: authUser.email || u.email })
        .where(eq(usersTable.id, u.id));
      return toRecord(u);
    }

    if (!allowCreate) {
      return null;
    }

    const [created] = await db
      .insert(usersTable)
      .values({
        id: authUser.id,
        email: authUser.email,
        fullName: authUser.fullName,
        avatarUrl: authUser.avatarUrl,
        creditsRemaining: FREE_SIGNUP_CREDITS,
        creditsUsed: 0,
        plan: "free",
        modelProvider: "built-in",
        lastLogin: new Date(),
      })
      .returning();

    await db.insert(creditLedgerTable).values({
      userId: created.id,
      amount: FREE_SIGNUP_CREDITS,
      reason: "signup_bonus",
    });

    logger.info({ userId: created.id }, "Provisioned new user with free credits");
    return toRecord(created);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.error({ err: message, userId: authUser.id }, "Database error in getOrCreateUser");
    throw new DatabaseUnavailableError(
      "Unable to reach the database. If this is a development environment, the Supabase database may be paused — resume it at https://supabase.com/dashboard.",
    );
  }
}

/**
 * Deduct credits from a user. Returns false if the user does not exist or has
 * an insufficient balance.
 *
 * The decrement and the balance guard happen in a single UPDATE so concurrent
 * requests can't both pass the check and overdraw the account.
 */
export async function deductCredit(
  userId: string,
  reason: string,
  runId?: string,
  amount = 1,
): Promise<boolean> {
  if (amount < 1) return true;

  const updated = await db
    .update(usersTable)
    .set({
      creditsRemaining: sql`${usersTable.creditsRemaining} - ${amount}`,
      creditsUsed: sql`${usersTable.creditsUsed} + ${amount}`,
    })
    .where(and(eq(usersTable.id, userId), gte(usersTable.creditsRemaining, amount)))
    .returning({ creditsRemaining: usersTable.creditsRemaining });

  if (updated.length === 0) return false;

  await db.insert(creditLedgerTable).values({
    userId,
    amount: -amount,
    reason,
    runId,
  });

  return true;
}

/**
 * Give credits back to a user after a failed run. Counterpart to
 * deductCredit — mirrors the original charge into the ledger so the running
 * balance stays auditable.
 */
export async function refundCredits(
  userId: string,
  reason: string,
  runId?: string,
  amount = 1,
): Promise<void> {
  if (amount < 1) return;

  const updated = await db
    .update(usersTable)
    .set({
      creditsRemaining: sql`${usersTable.creditsRemaining} + ${amount}`,
      creditsUsed: sql`GREATEST(0, ${usersTable.creditsUsed} - ${amount})`,
    })
    .where(eq(usersTable.id, userId))
    .returning({ creditsRemaining: usersTable.creditsRemaining });

  if (updated.length === 0) return;

  await db.insert(creditLedgerTable).values({
    userId,
    amount,
    reason,
    runId,
  });
}

/**
 * Add credits to a user (purchase / subscription).
 */
export async function addCredits(userId: string, amount: number, reason: string): Promise<void> {
  const user = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (user.length === 0) return;

  await db
    .update(usersTable)
    .set({ creditsRemaining: user[0].creditsRemaining + amount })
    .where(eq(usersTable.id, userId));

  await db.insert(creditLedgerTable).values({ userId, amount, reason });
}

/**
 * Redeem a coupon code for the given user. Validates the code (exists,
 * active, not expired, redemptions remaining) and that the user hasn't
 * already redeemed it, then grants credits via addCredits. Throws CouponError
 * on any validation failure so callers can surface a clear message.
 */
export async function redeemCoupon(userId: string, codeRaw: string): Promise<{ credits: number }> {
  const code = (codeRaw ?? "").trim().toUpperCase();
  if (!code) throw new CouponError("invalid_code", "A coupon code is required.");

  const [coupon] = await db.select().from(couponsTable).where(eq(couponsTable.code, code)).limit(1);
  if (!coupon) throw new CouponError("not_found", "That coupon code does not exist.");
  if (!coupon.active) throw new CouponError("inactive", "That coupon code is no longer active.");
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now())
    throw new CouponError("expired", "That coupon code has expired.");
  if (coupon.maxRedemptions != null && coupon.redemptions >= coupon.maxRedemptions)
    throw new CouponError("max_reached", "That coupon code has reached its redemption limit.");

  const already = await db
    .select()
    .from(couponRedemptionsTable)
    .where(and(eq(couponRedemptionsTable.userId, userId), eq(couponRedemptionsTable.code, code)))
    .limit(1);
  if (already.length > 0) throw new CouponError("already_redeemed", "You have already redeemed this coupon.");

  await addCredits(userId, coupon.credits, "coupon_redemption");

  await db
    .update(couponsTable)
    .set({ redemptions: sql`${couponsTable.redemptions} + 1` })
    .where(eq(couponsTable.code, code));

  await db.insert(couponRedemptionsTable).values({ userId, code });

  logger.info({ userId, code, credits: coupon.credits }, "Coupon redeemed");
  return { credits: coupon.credits };
}

function toRecord(u: typeof usersTable.$inferSelect): UserRecord {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    avatarUrl: u.avatarUrl,
    creditsRemaining: u.creditsRemaining,
    creditsUsed: u.creditsUsed,
    plan: u.plan,
    modelProvider: u.modelProvider,
    stripeCustomerId: u.stripeCustomerId,
    stripeSubscriptionId: u.stripeSubscriptionId,
  };
}
