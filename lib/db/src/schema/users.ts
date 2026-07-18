import { pgTable, text, integer, timestamp, boolean, uuid, jsonb, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),              // Supabase sub (UUID)
  email: text("email").notNull().unique(),
  fullName: text("full_name"),
  avatarUrl: text("avatar_url"),
  creditsRemaining: integer("credits_remaining").notNull().default(50),
  creditsUsed: integer("credits_used").notNull().default(0),
  plan: text("plan").notNull().default("free"),  // free | pro | enterprise
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  modelProvider: text("model_provider").notNull().default("built-in"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastLogin: timestamp("last_login"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true, lastLogin: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

export const agenticRunsTable = pgTable("agentic_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  url: text("url").notNull(),
  goal: text("goal").notNull(),
  status: text("status").notNull().default("queued"),  // queued | running | completed | failed | stopped
  success: boolean("success"),
  creditsUsed: integer("credits_used").notNull().default(0),
  modelUsed: text("model_used").notNull().default("built-in"),
  assertionResults: jsonb("assertion_results"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertAgenticRunSchema = createInsertSchema(agenticRunsTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});
export type InsertAgenticRun = z.infer<typeof insertAgenticRunSchema>;
export type AgenticRun = typeof agenticRunsTable.$inferSelect;

export const creditLedgerTable = pgTable("credit_ledger", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),  // signup_bonus | run | purchase | subscription
  runId: uuid("run_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCreditLedgerSchema = createInsertSchema(creditLedgerTable).omit({ id: true, createdAt: true });
export type InsertCreditLedger = z.infer<typeof insertCreditLedgerSchema>;
export type CreditLedger = typeof creditLedgerTable.$inferSelect;

export const userApiKeysTable = pgTable("user_api_keys", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  provider: text("provider").notNull(),  // openai | anthropic | google
  encryptedKey: text("encrypted_key").notNull(),
  keyHint: text("key_hint").notNull(),   // last 4 chars for display
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserApiKeySchema = createInsertSchema(userApiKeysTable).omit({ id: true, createdAt: true });
export type InsertUserApiKey = z.infer<typeof insertUserApiKeySchema>;
export type UserApiKey = typeof userApiKeysTable.$inferSelect;
