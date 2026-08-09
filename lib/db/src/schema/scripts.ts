import { pgTable, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable, agenticRunsTable } from "./users";

export const generatedTestScriptsTable = pgTable("generated_test_scripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  sourceRunId: uuid("source_run_id").notNull().references(() => agenticRunsTable.id),
  version: integer("version").notNull().default(1),
  name: text("name").notNull().default("Generated Playwright script"),
  language: text("language").notNull().default("typescript"),
  framework: text("framework").notNull().default("playwright"),
  code: text("code").notNull(),
  description: text("description"),
  warnings: jsonb("warnings"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGeneratedTestScriptSchema = createInsertSchema(generatedTestScriptsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertGeneratedTestScript = z.infer<typeof insertGeneratedTestScriptSchema>;
export type GeneratedTestScript = typeof generatedTestScriptsTable.$inferSelect;
