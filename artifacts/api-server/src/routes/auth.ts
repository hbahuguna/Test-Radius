import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { getOrCreateUser, DatabaseUnavailableError } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Provision the tenant for the authenticated Supabase user. This is the
 * "sign up" step: it creates the user row + free credits. Must be called
 * from the signup flow. After provisioning, the user may use the app.
 */
router.post("/provision", requireAuth, async (req, res) => {
  const user = req.user!;
  try {
    const record = await getOrCreateUser(user, { allowCreate: true });
    res.json({
      id: record!.id,
      email: record!.email,
      creditsRemaining: record!.creditsRemaining,
      plan: record!.plan,
    });
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      res.status(503).json({
        error: "database_unavailable",
        message: "Unable to reach the database. Please try again in a moment, or contact support if this persists.",
      });
      return;
    }
    throw err;
  }
});

/**
 * Return the current user's record. 403 if the tenant was never provisioned
 * (i.e. they authenticated via login without signing up first).
 */
router.get("/me", requireAuth, async (req, res) => {
  const user = req.user!;
  logger.info({ me_sub: user.id, me_email: user.email }, "[auth/me] lookup");
  try {
    const record = await getOrCreateUser(user, { allowCreate: false });
    logger.info({ me_found: !!record }, "[auth/me] result");
    if (!record) {
      res.status(403).json({
        error: "signup_required",
        message: "No account found. Please sign up before signing in.",
      });
      return;
    }
    res.json(record);
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      res.status(503).json({
        error: "database_unavailable",
        message: "Unable to reach the database. Please try again in a moment, or contact support if this persists.",
      });
      return;
    }
    throw err;
  }
});

export default router;
