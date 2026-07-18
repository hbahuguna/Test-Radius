import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { logger } from "../lib/logger";

export interface AuthedUser {
  id: string;          // Supabase sub (UUID)
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

const DEMO_MODE = process.env.DEMO_MODE?.toLowerCase() === "true" || process.env.DEMO_MODE === "1";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;

// JWKS for asymmetric (ES256) Supabase JWTs. Lazily initialized.
let jwks: JWTVerifyGetKey | null = null;
function getJwks(): JWTVerifyGetKey | null {
  if (!SUPABASE_URL) return null;
  if (!jwks) {
    try {
      jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    } catch (err) {
      logger.warn({ err }, "Failed to initialize JWKS");
      return null;
    }
  }
  return jwks;
}

interface SupabaseClaims {
  sub: string;
  email?: string;
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
    picture?: string;
  };
  [key: string]: unknown;
}

/**
 * Extract the bearer token from an Express request.
 */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Validate a Supabase JWT (HS256) and return the decoded claims.
 */
/**
 * Validate a Supabase JWT. Supports both:
 *  - asymmetric ES256 tokens (newer Supabase projects) verified via JWKS, and
 *  - symmetric HS256 tokens (local/demo) verified with SUPABASE_JWT_SECRET.
 */
async function verifySupabaseToken(token: string): Promise<SupabaseClaims | null> {
  // Try asymmetric verification (ES256) via JWKS first.
  const keys = getJwks();
  if (keys) {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: `${SUPABASE_URL}/auth/v1`,
      });
      return payload as unknown as SupabaseClaims;
    } catch (err) {
      logger.debug({ err: (err as Error)?.message }, "JWKS verification failed; falling back to HS256");
    }
  }

  // Fall back to symmetric HS256 with the configured secret.
  if (!JWT_SECRET) {
    logger.error("SUPABASE_JWT_SECRET is not configured; cannot validate tokens");
    return null;
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "supabase",
    }) as SupabaseClaims;
    return decoded;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, tokenHead: token.slice(0, 20) }, "Supabase token verification failed");
    return null;
  }
}

/**
 * Resolve the authenticated user from the request. Supports DEMO_MODE for
 * local development without a real Supabase token.
 */
export async function resolveUser(req: Request): Promise<AuthedUser | null> {
  if (DEMO_MODE) {
    return {
      id: "demo-user-id",
      email: "demo@testradius.dev",
      fullName: "Demo User",
      avatarUrl: null,
    };
  }

  const token = extractToken(req);
  logger.info({ hasAuthHeader: !!req.headers.authorization, tokenPrefix: token?.slice(0, 15) }, "[resolveUser]");
  if (!token) return null;

  const claims = await verifySupabaseToken(token);
  if (!claims?.sub) return null;

  const meta = claims.user_metadata ?? {};
  return {
    id: claims.sub,
    email: claims.email ?? "",
    fullName: meta.full_name ?? meta.name ?? null,
    avatarUrl: meta.avatar_url ?? meta.picture ?? null,
  };
}

/**
 * Express middleware: require a valid authenticated Supabase user (valid JWT).
 * Does NOT require the tenant to already exist — use requireSignedUp for that.
 * This is appropriate for the signup/provision endpoint (which creates the
 * tenant) and for read-only endpoints that want to know who's calling.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }
  req.user = user;
  next();
}

/**
 * Express middleware: require a valid authenticated user who has already
 * signed up. A Supabase auth user who never completed signup (no tenant row)
 * is rejected with 403 so the client can redirect them to sign up. Used to
 * gate tenant-scoped resources (tester runs, keys, billing, credits).
 */
export async function requireSignedUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }

  // Confirm the tenant exists (signup completed). Login-only callers with no
  // tenant record are refused — they must sign up first.
  const { getOrCreateUser } = await import("../lib/auth");
  const record = await getOrCreateUser(user, { allowCreate: false });
  if (!record) {
    res.status(403).json({
      error: "signup_required",
      message: "No account found. Please sign up before signing in.",
    });
    return;
  }

  req.user = user;
  next();
}

/**
 * Express middleware: attach user if present but do not block.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await resolveUser(req);
  if (user) req.user = user;
  next();
}
