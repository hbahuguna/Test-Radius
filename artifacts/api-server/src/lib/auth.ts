import { db } from "@workspace/db";
import { usersTable, creditLedgerTable, couponsTable, couponRedemptionsTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { AuthedUser } from "../middlewares/auth";
import { logger } from "../lib/logger";

export class CouponError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const FREE_SIGNUP_CREDITS = 20;

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
export async function getOrCreateUser(
  authUser: AuthedUser,
  opts?: { allowCreate?: boolean },
): Promise<UserRecord | null> {
  const allowCreate = opts?.allowCreate ?? true;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, authUser.id))
    .limit(1);

  if (existing.length > 0) {
    const u = existing[0];
    // Touch last_login
    await db
      .update(usersTable)
      .set({ lastLogin: new Date(), email: authUser.email || u.email })
      .where(eq(usersTable.id, u.id));
    return toRecord(u);
  }

  if (!allowCreate) {
    // Login attempt for an account that was never signed up.
    return null;
  }

  // Provision new user with free credits
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
}

/**
 * Deduct one credit from a user. Returns false if insufficient credits.
 */
export async function deductCredit(userId: string, reason: string, runId?: string): Promise<boolean> {
  const user = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (user.length === 0) return false;
  if (user[0].creditsRemaining < 1) return false;

  await db
    .update(usersTable)
    .set({
      creditsRemaining: user[0].creditsRemaining - 1,
      creditsUsed: user[0].creditsUsed + 1,
    })
    .where(eq(usersTable.id, userId));

  await db.insert(creditLedgerTable).values({
    userId,
    amount: -1,
    reason,
    runId,
  });

  return true;
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
