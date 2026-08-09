import { describe, it, expect } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { agenticBatchesTable } from "../batches";
import { usersTable, agenticRunsTable } from "../users";
import * as schemaIndex from "../index";

function getPgInlineForeignKeys(table: object): any[] {
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:PgInlineForeignKeys)",
  );
  if (!sym) return [];
  return (table as any)[sym];
}

describe("agenticBatchesTable schema", () => {
  it("compiles with all 9 columns", () => {
    const columns = getTableColumns(agenticBatchesTable);
    expect(columns).toHaveProperty("id");
    expect(columns).toHaveProperty("userId");
    expect(columns).toHaveProperty("parallelLimit");
    expect(columns).toHaveProperty("status");
    expect(columns).toHaveProperty("totalRuns");
    expect(columns).toHaveProperty("completedRuns");
    expect(columns).toHaveProperty("failedRuns");
    expect(columns).toHaveProperty("createdAt");
    expect(columns).toHaveProperty("completedAt");
    expect(Object.keys(columns)).toHaveLength(9);
  });

  it("status defaults to 'queued'", () => {
    const columns = getTableColumns(agenticBatchesTable);
    const statusCol = columns.status as any;
    expect(statusCol.hasDefault).toBe(true);
    expect(statusCol.default).toBe("queued");
  });

  it("parallelLimit defaults to 1", () => {
    const columns = getTableColumns(agenticBatchesTable);
    const col = columns.parallelLimit as any;
    expect(col.hasDefault).toBe(true);
    expect(col.default).toBe(1);
  });

  it("completedRuns defaults to 0", () => {
    const columns = getTableColumns(agenticBatchesTable);
    const col = columns.completedRuns as any;
    expect(col.hasDefault).toBe(true);
    expect(col.default).toBe(0);
  });

  it("failedRuns defaults to 0", () => {
    const columns = getTableColumns(agenticBatchesTable);
    const col = columns.failedRuns as any;
    expect(col.hasDefault).toBe(true);
    expect(col.default).toBe(0);
  });

  it("userId references usersTable.id", () => {
    const fks = getPgInlineForeignKeys(agenticBatchesTable);
    const userIdFk = fks.find((fk: any) => {
      const ref = fk.reference();
      const foreignTableName = ref.foreignTable?.[Symbol.for("drizzle:Name")];
      return foreignTableName === "users";
    });
    expect(userIdFk).toBeDefined();
  });
});

describe("agenticRunsTable batchId column", () => {
  it("has batchId column", () => {
    const columns = getTableColumns(agenticRunsTable);
    expect(columns).toHaveProperty("batchId");
  });

  it("total column count is 20 (original 12 + 7 Phase 4 + 1 batchId)", () => {
    const columns = getTableColumns(agenticRunsTable);
    expect(Object.keys(columns)).toHaveLength(20);
  });
});

describe("schema exports", () => {
  it("agenticBatchesTable is exported from schema package", () => {
    expect(agenticBatchesTable).toBeDefined();
    expect(getTableName(agenticBatchesTable)).toBe("agentic_batches");
  });

  it("agenticBatchesTable re-exported from schema index", () => {
    expect(schemaIndex.agenticBatchesTable).toBeDefined();
    expect(getTableName(schemaIndex.agenticBatchesTable)).toBe("agentic_batches");
  });
});
