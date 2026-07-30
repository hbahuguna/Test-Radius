import { describe, it, expect } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { testGroupsTable, testGroupRunsTable } from "../groups";
import { usersTable, agenticRunsTable } from "../users";
import * as schemaIndex from "../index";

function getPgInlineForeignKeys(table: object): any[] {
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:PgInlineForeignKeys)",
  );
  if (!sym) return [];
  return (table as any)[sym];
}

describe("testGroupsTable schema", () => {
  it("compiles with all 5 columns (id, userId, name, description, createdAt)", () => {
    const columns = getTableColumns(testGroupsTable);
    expect(columns).toHaveProperty("id");
    expect(columns).toHaveProperty("userId");
    expect(columns).toHaveProperty("name");
    expect(columns).toHaveProperty("description");
    expect(columns).toHaveProperty("createdAt");
    expect(Object.keys(columns)).toHaveLength(5);
  });

  it("userId references usersTable.id", () => {
    const fks = getPgInlineForeignKeys(testGroupsTable);
    const userIdFk = fks.find((fk: any) => {
      const ref = fk.reference();
      const foreignTableName = ref.foreignTable?.[Symbol.for("drizzle:Name")];
      return foreignTableName === "users";
    });
    expect(userIdFk).toBeDefined();
    expect(userIdFk.onDelete).toBe("no action");
  });
});

describe("testGroupRunsTable schema", () => {
  it("compiles with all 4 columns (id, groupId, runId, order)", () => {
    const columns = getTableColumns(testGroupRunsTable);
    expect(columns).toHaveProperty("id");
    expect(columns).toHaveProperty("groupId");
    expect(columns).toHaveProperty("runId");
    expect(columns).toHaveProperty("order");
    expect(Object.keys(columns)).toHaveLength(4);
  });

  it("groupId references testGroupsTable.id with cascade delete", () => {
    const fks = getPgInlineForeignKeys(testGroupRunsTable);
    const groupFk = fks.find((fk: any) => {
      const ref = fk.reference();
      const foreignTableName = ref.foreignTable?.[Symbol.for("drizzle:Name")];
      return foreignTableName === "test_groups";
    });
    expect(groupFk).toBeDefined();
    expect(groupFk.onDelete).toBe("cascade");
  });

  it("runId references agenticRunsTable.id with cascade delete", () => {
    const fks = getPgInlineForeignKeys(testGroupRunsTable);
    const agenticFk = fks.find((fk: any) => {
      const ref = fk.reference();
      const foreignTableName = ref.foreignTable?.[Symbol.for("drizzle:Name")];
      return foreignTableName === "agentic_runs";
    });
    expect(agenticFk).toBeDefined();
    expect(agenticFk.onDelete).toBe("cascade");
  });

  it("order column defaults to 0", () => {
    const columns = getTableColumns(testGroupRunsTable);
    const orderCol = columns.order as any;
    expect(orderCol.hasDefault).toBe(true);
    expect(orderCol.default).toBe(0);
  });

  it("has 2 foreign key constraints total", () => {
    const fks = getPgInlineForeignKeys(testGroupRunsTable);
    expect(fks).toHaveLength(2);
  });
});

describe("schema exports", () => {
  it("testGroupsTable is exported from schema package", () => {
    expect(testGroupsTable).toBeDefined();
    expect(getTableName(testGroupsTable)).toBe("test_groups");
  });

  it("testGroupRunsTable is exported from schema package", () => {
    expect(testGroupRunsTable).toBeDefined();
    expect(getTableName(testGroupRunsTable)).toBe("test_group_runs");
  });

  it("both tables re-exported from schema index", () => {
    expect(schemaIndex.testGroupsTable).toBeDefined();
    expect(schemaIndex.testGroupRunsTable).toBeDefined();
    expect(getTableName(schemaIndex.testGroupsTable)).toBe("test_groups");
    expect(getTableName(schemaIndex.testGroupRunsTable)).toBe("test_group_runs");
  });
});
