import Stripe from "stripe";
import { logger } from "./logger";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    _stripe = new Stripe(key, { apiVersion: "2025-09-30 CL" as Stripe.LatestApiVersion });
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

export function isSubscriptionPrice(priceId: string): boolean {
  return priceId === (process.env.STRIPE_PRICE_PRO_MONTHLY ?? "price_pro_monthly");
}

export const STRIPE_PRO_MONTHLY_CREDITS = 500;
