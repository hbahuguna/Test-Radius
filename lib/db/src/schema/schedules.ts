import { pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const testSchedulesTable = pgTable("test_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  goal: text("goal").notNull(),
  cronExpression: text("cron_expression").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  modelId: text("model_id"),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTestScheduleSchema = createInsertSchema(testSchedulesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTestSchedule = z.infer<typeof insertTestScheduleSchema>;
export type TestSchedule = typeof testSchedulesTable.$inferSelect;
