import Stripe from "stripe";
import { logger } from "./logger";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    // Deliberately no apiVersion override: the SDK pins the version it was
    // generated against, so it stays correct across SDK upgrades. Hardcoding it
    // is a trap — a stale literal fails at runtime while `as LatestApiVersion`
    // keeps tsc quiet.
    _stripe = new Stripe(key);
  }
  return _stripe;
}

/**
 * Get or create a Stripe customer for a user.
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  fullName?: string | null,
): Promise<string> {
  const stripe = getStripe();

  // Look up by Supabase user id stored in metadata
  const existing = await stripe.customers.search({
    query: `metadata['userId']:'${userId}'`,
    limit: 1,
  });
  if (existing.data.length > 0) {
    return existing.data[0].id;
  }

  const customer = await stripe.customers.create({
    email,
    name: fullName ?? undefined,
    metadata: { userId },
  });
  return customer.id;
}

/**
 * Map Stripe price IDs to credit bundles.
 */
const CREDIT_PACKS: Record<string, number> = {
  // Override these with real price IDs from your Stripe dashboard.
  [process.env.STRIPE_PRICE_CREDIT_PACK_10 ?? "price_credit_pack_10"]: 10,
  [process.env.STRIPE_PRICE_CREDIT_PACK_50 ?? "price_credit_pack_50"]: 50,
  [process.env.STRIPE_PRICE_CREDIT_PACK_200 ?? "price_credit_pack_200"]: 200,
};

export function creditsForPrice(priceId: string): number | null {
  return CREDIT_PACKS[priceId] ?? null;
}

/** Accept only configured prices; retain legacy UI aliases without sending
 * placeholder IDs to Stripe. */
export function resolveCheckoutPrice(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const [alias, key] of [
    ["price_credit_pack_10", "STRIPE_PRICE_CREDIT_PACK_10"],
    ["price_credit_pack_50", "STRIPE_PRICE_CREDIT_PACK_50"],
    ["price_credit_pack_200", "STRIPE_PRICE_CREDIT_PACK_200"],
    ["price_pro_monthly", "STRIPE_PRICE_PRO_MONTHLY"],
  ]) {
    const configured = process.env[key]?.trim();
    if (configured && (value === alias || value === configured)) return configured;
  }
  return null;
}

export function isSubscriptionPrice(priceId: string): boolean {
  return priceId === (process.env.STRIPE_PRICE_PRO_MONTHLY ?? "price_pro_monthly");
}

export const STRIPE_PRO_MONTHLY_CREDITS = 500;
