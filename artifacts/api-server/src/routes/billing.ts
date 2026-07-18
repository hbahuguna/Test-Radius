import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser, addCredits } from "../lib/auth";
import {
  getStripe,
  getOrCreateStripeCustomer,
  creditsForPrice,
  isSubscriptionPrice,
  STRIPE_PRO_MONTHLY_CREDITS,
} from "../lib/stripe";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(requireSignedUp);

/**
 * POST /api/billing/checkout
 * Create a Stripe Checkout session for a credit pack or subscription.
 */
router.post("/checkout", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { priceId } = req.body ?? {};

  if (!priceId) {
    res.status(400).json({ error: "price_id_required" });
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
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.headers.origin || ""}/tester?checkout=success`,
      cancel_url: `${req.headers.origin || ""}/tester?checkout=cancelled`,
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
router.post("/portal", async (req: Request, res: Response) => {
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
      return_url: `${req.headers.origin || ""}/settings`,
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
      case "checkout.session.completed": {
        const session = event.data.object as import("stripe").Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        if (userId && session.mode === "payment" && session.line_items) {
          // Resolve credits from the purchased price
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
          const priceId = lineItems.data[0]?.price?.id;
          if (priceId) {
            const credits = creditsForPrice(priceId);
            if (credits) {
              await addCredits(userId, credits, "purchase");
              logger.info({ userId, credits }, "Added purchased credits");
            }
          }
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
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const [u] = await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.stripeCustomerId, customerId))
            .limit(1);
          if (u) {
            await addCredits(u.id, STRIPE_PRO_MONTHLY_CREDITS, "subscription");
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
