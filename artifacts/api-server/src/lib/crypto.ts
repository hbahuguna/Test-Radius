import crypto from "crypto";

/**
 * AES-256-GCM encryption for BYOK API keys.
 * Key is provided via ENCRYPTION_KEY env var (32-byte hex string).
 */

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is not configured");
  }
  // Accept raw 32-byte hex, or derive from arbitrary string
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export interface EncryptedPayload {
  encrypted: string; // base64
  iv: string;        // base64
  tag: string;       // base64
}

export function encryptKey(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptKey(payload: EncryptedPayload): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encrypted, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Validate that an API key matches the expected provider prefix.
 */
export function validateKeyFormat(provider: string, key: string): boolean {
  const trimmed = key.trim();
  switch (provider) {
    case "openai":
      return trimmed.startsWith("sk-") && trimmed.length > 20;
    case "anthropic":
      return trimmed.startsWith("sk-ant-") && trimmed.length > 20;
    case "google":
      return trimmed.length > 20; // Google API keys are variable format
    case "opencode":
      return trimmed.length > 10; // OpenCode Zen API keys are variable format
    case "openrouter":
      return trimmed.startsWith("sk-or-") && trimmed.length > 20;
    case "poolside":
      return trimmed.startsWith("sky_") && trimmed.length > 20;
    case "jira": {
      // Jira credentials are stored as a JSON object:
      // { baseUrl, email, token }
      try {
        const parsed = JSON.parse(trimmed);
        return (
          typeof parsed.baseUrl === "string" &&
          parsed.baseUrl.startsWith("http") &&
          typeof parsed.email === "string" &&
          parsed.email.includes("@") &&
          typeof parsed.token === "string" &&
          parsed.token.length > 0
        );
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export function keyHint(key: string): string {
  const trimmed = key.trim();
  return trimmed.slice(-4);
}

/**
 * Hint for stored Jira connections — show a short host label instead of key tails.
 */
export function jiraHint(payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    const url = parsed.baseUrl as string;
    return url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "jira";
  } catch {
    return "jira";
  }
}
