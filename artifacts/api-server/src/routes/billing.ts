import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser, grantStripeCredits } from "../lib/auth";
import {
  getStripe,
  getOrCreateStripeCustomer,
  creditsForPrice,
  resolveCheckoutPrice,
  isSubscriptionPrice,
  STRIPE_PRO_MONTHLY_CREDITS,
} from "../lib/stripe";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Absolute base URL for Stripe redirect targets.
 *
 * Stripe rejects relative success/cancel URLs outright, so a missing Origin
 * header (curl, some proxies, server-to-server callers) used to fail checkout
 * with url_invalid. APP_ORIGIN is the deliberate, configured value; the Origin
 * header is only a fallback, and is restricted to http(s) so it cannot be used
 * to smuggle a javascript: URL into the redirect.
 */
function redirectBase(req: Request): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured) return configured;

  const origin = req.headers.origin;
  if (typeof origin === "string" && /^https?:\/\//i.test(origin)) {
    return origin.replace(/\/+$/, "");
  }
  return "";
}

/** Only same-site absolute paths are honored, so `returnTo` can't leave the app. */
function safeReturnTo(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

/**
 * POST /api/billing/checkout
 * Create a Stripe Checkout session for a credit pack or subscription.
 */
router.post("/checkout", requireSignedUp, async (req: Request, res: Response) => {
  const authUser = req.user!;
  const priceId = resolveCheckoutPrice(req.body?.priceId);

  if (!priceId) {
    res.status(400).json({ error: "invalid_or_unconfigured_price" });
    return;
  }

  try {
    const user = (await getOrCreateUser(authUser))!;
    const stripe = getStripe();
    const customerId = await getOrCreateStripeCustomer(user.id, user.email, user.fullName);

    // Persist the Stripe customer id on the user
    await db
      .update(usersTable)
      .set({ stripeCustomerId: customerId })
      .where(eq(usersTable.id, user.id));

    const mode = isSubscriptionPrice(priceId) ? "subscription" : "payment";
    // Credit packs can be bought from any page, so return the buyer to wherever
    // they started instead of hardcoding /tester.
    const base = redirectBase(req);
    const returnTo = safeReturnTo(req.body?.returnTo, "/tester");
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}${returnTo}?checkout=success`,
      cancel_url: `${base}${returnTo}?checkout=cancelled`,
      metadata: { userId: user.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, "Stripe checkout failed");
    res.status(500).json({ error: "checkout_failed" });
  }
});

/**
 * POST /api/billing/portal
 * Create a Stripe Customer Portal session.
 */
router.post("/portal", requireSignedUp, async (req: Request, res: Response) => {
  const authUser = req.user!;
  try {
    const user = (await getOrCreateUser(authUser))!;
    if (!user.stripeCustomerId) {
      res.status(400).json({ error: "no_customer" });
      return;
    }
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${redirectBase(req)}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, "Stripe portal failed");
    res.status(500).json({ error: "portal_failed" });
  }
});

/**
 * POST /api/billing/webhook
 * Stripe webhook handler. No auth — verified via signature.
 */
router.post("/webhook", async (req: Request, res: Response) => {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !webhookSecret) {
    res.status(400).json({ error: "missing_signature" });
    return;
  }

  let event: import("stripe").Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    logger.warn({ err }, "Stripe webhook signature invalid");
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as import("stripe").Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        // Guard on mode only. Do NOT require session.line_items here: the
        // webhook payload embeds the session without that field populated
        // (it is only present when explicitly expanded), so gating on it
        // silently skipped every real purchase and never granted credits.
        if (userId && session.mode === "payment" && session.payment_status === "paid") {
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
          const priceId = lineItems.data[0]?.price?.id;
          if (!priceId) {
            throw new Error("Paid Checkout session has no line items");
          }
          const credits = creditsForPrice(priceId);
          if (!credits) {
            // An unmapped price means we cannot know what was bought; granting
            // a guess would be wrong, so surface it loudly instead.
            logger.error({ priceId, sessionId: session.id }, "purchased price not in CREDIT_PACKS");
            throw new Error("Purchased Stripe price is not configured");
          }
          await grantStripeCredits(userId, credits, "purchase", session.id);
          logger.info({ userId, credits, priceId }, "Added purchased credits");
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as import("stripe").Stripe.Subscription;
        const userId = sub.metadata?.userId;
        if (userId) {
          await db
            .update(usersTable)
            .set({ plan: "pro", stripeSubscriptionId: sub.id })
            .where(eq(usersTable.id, userId));
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as import("stripe").Stripe.Subscription;
        const userId = sub.metadata?.userId;
        if (userId) {
          await db
            .update(usersTable)
            .set({ plan: "free", stripeSubscriptionId: null })
            .where(eq(usersTable.id, userId));
        }
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as import("stripe").Stripe.Invoice;
        if (!invoice.id) throw new Error("Paid invoice has no Stripe ID");
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const [u] = await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.stripeCustomerId, customerId))
            .limit(1);
          if (u) {
            await grantStripeCredits(u.id, STRIPE_PRO_MONTHLY_CREDITS, "subscription", invoice.id);
          }
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    logger.error({ err }, "Webhook processing failed");
    res.status(500).json({ error: "webhook_error" });
  }
});

export default router;
