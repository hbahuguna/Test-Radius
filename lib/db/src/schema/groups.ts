import { pgTable, text, integer, timestamp, uuid, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable, agenticRunsTable } from "./users";

export const testGroupsTable = pgTable("test_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTestGroupSchema = createInsertSchema(testGroupsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTestGroup = z.infer<typeof insertTestGroupSchema>;
export type TestGroup = typeof testGroupsTable.$inferSelect;

export const testGroupRunsTable = pgTable("test_group_runs", {
  id: serial("id").primaryKey(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => testGroupsTable.id, { onDelete: "cascade" }),
  runId: uuid("run_id")
    .notNull()
    .references(() => agenticRunsTable.id, { onDelete: "cascade" }),
  order: integer("order").notNull().default(0),
});

export const insertTestGroupRunSchema = createInsertSchema(testGroupRunsTable).omit({
  id: true,
});
export type InsertTestGroupRun = z.infer<typeof insertTestGroupRunSchema>;
export type TestGroupRun = typeof testGroupRunsTable.$inferSelect;
