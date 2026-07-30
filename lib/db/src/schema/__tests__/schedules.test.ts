import { describe, it, expect } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { testSchedulesTable } from "../schedules";
import { usersTable } from "../users";
import * as schemaIndex from "../index";

function getPgInlineForeignKeys(table: object): any[] {
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:PgInlineForeignKeys)",
  );
  if (!sym) return [];
  return (table as any)[sym];
}

describe("testSchedulesTable schema", () => {
  it("compiles with all 12 columns", () => {
    const columns = getTableColumns(testSchedulesTable);
    const expected = [
      "id",
      "userId",
      "name",
      "url",
      "goal",
      "cronExpression",
      "timezone",
      "modelId",
      "enabled",
      "lastRunAt",
      "nextRunAt",
      "createdAt",
    ];
    for (const col of expected) {
      expect(columns).toHaveProperty(col);
    }
    expect(Object.keys(columns)).toHaveLength(12);
  });

  it("enabled defaults to true", () => {
    const columns = getTableColumns(testSchedulesTable);
    const enabledCol = columns.enabled as any;
    expect(enabledCol.hasDefault).toBe(true);
    expect(enabledCol.default).toBe(true);
  });

  it("lastRunAt is nullable timestamp", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.lastRunAt as any;
    expect(col.notNull).toBe(false);
    expect(col.dataType).toBe("date");
  });

  it("nextRunAt is nullable timestamp", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.nextRunAt as any;
    expect(col.notNull).toBe(false);
    expect(col.dataType).toBe("date");
  });

  it("cronExpression is required (not null)", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.cronExpression as any;
    expect(col.notNull).toBe(true);
  });

  it("name is required (not null)", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.name as any;
    expect(col.notNull).toBe(true);
  });

  it("url is required (not null)", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.url as any;
    expect(col.notNull).toBe(true);
  });

  it("goal is required (not null)", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.goal as any;
    expect(col.notNull).toBe(true);
  });

  it("modelId is nullable", () => {
    const columns = getTableColumns(testSchedulesTable);
    const col = columns.modelId as any;
    expect(col.notNull).toBe(false);
  });

  it("userId references usersTable.id", () => {
    const fks = getPgInlineForeignKeys(testSchedulesTable);
    const userIdFk = fks.find((fk: any) => {
      const ref = fk.reference();
      const foreignTableName = ref.foreignTable?.[Symbol.for("drizzle:Name")];
      return foreignTableName === "users";
    });
    expect(userIdFk).toBeDefined();
    expect(userIdFk.onDelete).toBe("no action");
  });

  it("is exported from schema index", () => {
    expect(schemaIndex.testSchedulesTable).toBeDefined();
    expect(getTableName(schemaIndex.testSchedulesTable)).toBe("test_schedules");
  });
});
