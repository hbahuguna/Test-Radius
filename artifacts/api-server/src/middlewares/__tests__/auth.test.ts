import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadAuth(env: Record<string, string | undefined>) {
  for (const key of ["DEMO_MODE", "NODE_ENV", "SUPABASE_URL", "SUPABASE_JWT_SECRET"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../auth");
}

function makeRequest(token?: string): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as Request;
}

function makeResponse() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status: vi.fn((code: number) => {
      statusCode = code;
      return response;
    }),
    json: vi.fn((value: unknown) => {
      body = value;
      return response;
    }),
  };
  return {
    response: response as unknown as Response,
    statusCode: () => statusCode,
    body: () => body,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("demo authentication fallback", () => {
  it("rejects anonymous production requests even when DEMO_MODE is true", async () => {
    const { requireAuth } = await loadAuth({
      NODE_ENV: "production",
      DEMO_MODE: "true",
    });
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await requireAuth(req, res.response, next);

    expect(res.statusCode()).toBe(401);
    expect(res.body()).toMatchObject({ error: "unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a valid individual Supabase identity in production", async () => {
    const { requireAuth } = await loadAuth({
      NODE_ENV: "production",
      DEMO_MODE: "true",
      SUPABASE_JWT_SECRET: "test-jwt-secret",
    });
    const token = jwt.sign(
      { sub: "account-123", email: "person@example.com" },
      "test-jwt-secret",
      { issuer: "supabase" },
    );
    const req = makeRequest(token);
    const res = makeResponse();
    const next = vi.fn();

    await requireAuth(req, res.response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({
      id: "account-123",
      email: "person@example.com",
    });
  });

  it("keeps the demo identity available in development", async () => {
    const { resolveUser } = await loadAuth({
      NODE_ENV: "development",
      DEMO_MODE: "true",
    });

    await expect(resolveUser(makeRequest())).resolves.toMatchObject({
      id: "demo-user-id",
      email: "demo@testradius.dev",
    });
  });
});