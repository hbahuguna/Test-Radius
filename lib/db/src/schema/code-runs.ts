import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { generatedTestScriptsTable } from "./scripts";

export const codeRunsTable = pgTable("generated_code_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  scriptId: uuid("script_id").notNull().references(() => generatedTestScriptsTable.id),
  status: text("status").notNull().default("queued"),
  events: jsonb("events").notNull().default([]),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertCodeRunSchema = createInsertSchema(codeRunsTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});
export type InsertCodeRun = z.infer<typeof insertCodeRunSchema>;
export type CodeRun = typeof codeRunsTable.$inferSelect;
