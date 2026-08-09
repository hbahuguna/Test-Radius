import { pgTable, text, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const agenticBatchesTable = pgTable("agentic_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  parallelLimit: integer("parallel_limit").notNull().default(1),
  status: text("status").notNull().default("queued"),  // queued | running | completed | failed | partial_failure
  totalRuns: integer("total_runs").notNull(),
  completedRuns: integer("completed_runs").notNull().default(0),
  failedRuns: integer("failed_runs").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});
