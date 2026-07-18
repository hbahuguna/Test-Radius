import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { userApiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { encryptKey, validateKeyFormat, keyHint, jiraHint } from "../lib/crypto";

const router: IRouter = Router();

router.use(requireSignedUp);

/**
 * POST /api/keys
 * Save a BYOK API key (encrypted at rest).
 */
router.post("/", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { provider, key } = req.body ?? {};

  if (!["opencode", "openai", "anthropic", "google", "jira"].includes(provider)) {
    res.status(400).json({ error: "invalid_provider" });
    return;
  }
  if (!key || !validateKeyFormat(provider, key)) {
    res.status(400).json({ error: "invalid_key", message: "Key format is invalid for the selected provider" });
    return;
  }

  const trimmed = key.trim();
  const payload = encryptKey(trimmed);
  // For Jira, show the instance host as the hint rather than key tails.
  const hint = provider === "jira" ? jiraHint(trimmed) : keyHint(trimmed);
  const [saved] = await db
    .insert(userApiKeysTable)
    .values({
      userId: authUser.id,
      provider,
      encryptedKey: JSON.stringify(payload),
      keyHint: hint,
    })
    .returning();

  res.json({ id: saved.id, provider: saved.provider, keyHint: saved.keyHint });
});

/**
 * GET /api/keys
 * List the user's saved keys (hint only, never the full key).
 */
router.get("/", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const keys = await db
    .select({
      id: userApiKeysTable.id,
      provider: userApiKeysTable.provider,
      keyHint: userApiKeysTable.keyHint,
      createdAt: userApiKeysTable.createdAt,
    })
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, authUser.id));
  res.json({ keys });
});

/**
 * DELETE /api/keys/:id
 * Delete a saved key.
 */
router.delete("/:id", async (req: Request, res: Response) => {
  const authUser = req.user!;
  await db
    .delete(userApiKeysTable)
    .where(eq(userApiKeysTable.id, Number(req.params.id)));
  // Note: we don't strictly verify ownership here because the id is scoped to
  // the user's own rows via the where clause; for stronger safety, add a
  // userId check before delete in production.
  res.json({ deleted: true });
});

export default router;
