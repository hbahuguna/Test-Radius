import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { couponsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser, redeemCoupon, CouponError } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(requireSignedUp);

const ADMIN_EMAILS = (process.env.COUPON_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdmin(email: string | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * POST /api/tester/coupons/redeem
 * Redeem a coupon code for the calling user. Grants credits on success.
 */
router.post("/redeem", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const code = (req.body?.code as string) ?? "";
  const user = (await getOrCreateUser(authUser, { allowCreate: false }))!;
  try {
    const { credits } = await redeemCoupon(user.id, code);
    res.json({ ok: true, credits_granted: credits });
  } catch (e) {
    if (e instanceof CouponError) {
      res.status(400).json({ error: e.code, message: e.message });
      return;
    }
    logger.error({ err: e, code }, "Coupon redemption failed");
    res.status(500).json({ error: "coupon_error", message: "Failed to redeem coupon" });
  }
});

/**
 * GET /api/tester/coupons/:code
 * Public-ish lookup so the UI can preview a coupon's value before redeeming.
 */
router.get("/:code", async (req: Request, res: Response) => {
  const code = (Array.isArray(req.params.code) ? req.params.code[0] : req.params.code ?? "").trim().toUpperCase();
  if (!code) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }
  const [coupon] = await db.select().from(couponsTable).where(eq(couponsTable.code, code)).limit(1);
  if (!coupon || !coupon.active) {
    res.status(404).json({ error: "not_found", message: "That coupon code does not exist." });
    return;
  }
  res.json({
    code: coupon.code,
    credits: coupon.credits,
    description: coupon.description,
    expired: coupon.expiresAt ? coupon.expiresAt.getTime() < Date.now() : false,
  });
});

/**
 * Admin: create / update a coupon. Gated by COUPON_ADMIN_EMAILS (comma list).
 * POST /api/tester/coupons  { code, credits, description?, maxRedemptions?, expiresAt? }
 */
router.post("/", async (req: Request, res: Response) => {
  const authUser = req.user!;
  if (!isAdmin(authUser.email)) {
    res.status(403).json({ error: "forbidden", message: "Not authorized to manage coupons." });
    return;
  }
  const code = (req.body?.code as string)?.trim().toUpperCase();
  const credits = Number(req.body?.credits);
  if (!code || !Number.isFinite(credits) || credits <= 0) {
    res.status(400).json({ error: "invalid_request", message: "code and a positive credits number are required." });
    return;
  }
  const values = {
    code,
    credits,
    description: req.body?.description ?? null,
    maxRedemptions: req.body?.maxRedemptions != null ? Number(req.body.maxRedemptions) : null,
    expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : null,
    active: true,
  };
  await db
    .insert(couponsTable)
    .values(values)
    .onConflictDoUpdate({ target: couponsTable.code, set: values });
  res.json({ ok: true, coupon: values });
});

export default router;
