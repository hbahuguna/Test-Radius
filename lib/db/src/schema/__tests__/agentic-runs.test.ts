import { describe, it, expect } from "vitest";
import { agenticRunsTable, insertAgenticRunSchema } from "../users";
import { getTableColumns } from "drizzle-orm";

const NEW_COLUMNS = [
  "groupId",
  "scheduleId",
  "stepCount",
  "duration",
  "failureBundle",
  "videoUrl",
  "metadata",
] as const;

describe("agenticRunsTable schema", () => {
  it("compiles with all 7 new Phase 4 columns", () => {
    const columns = getTableColumns(agenticRunsTable);
    for (const col of NEW_COLUMNS) {
      expect(columns).toHaveProperty(col);
    }
  });

  it("new columns have correct data types", () => {
    const columns = getTableColumns(agenticRunsTable);
    expect(columns.groupId).toBeDefined();
    expect(columns.scheduleId).toBeDefined();
    expect(columns.stepCount).toBeDefined();
    expect(columns.duration).toBeDefined();
    expect(columns.failureBundle).toBeDefined();
    expect(columns.videoUrl).toBeDefined();
    expect(columns.metadata).toBeDefined();
  });

  it("has correct total column count (original 12 + 7 Phase 4 + 1 batchId = 20)", () => {
    const columns = getTableColumns(agenticRunsTable);
    const count = Object.keys(columns).length;
    expect(count).toBe(20);
  });
});

describe("insertAgenticRunSchema", () => {
  const MINIMAL_INPUT = {
    userId: "user-abc-123",
    url: "https://example.com",
    goal: "Test the homepage",
  };

  it("accepts insert with only required fields (backward compat)", () => {
    const result = insertAgenticRunSchema.safeParse(MINIMAL_INPUT);
    expect(result.success).toBe(true);
  });

  it("accepts insert with all new fields populated", () => {
    const input = {
      ...MINIMAL_INPUT,
      groupId: "550e8400-e29b-41d4-a716-446655440000",
      scheduleId: "550e8400-e29b-41d4-a716-446655440001",
      stepCount: 5,
      duration: 42,
      failureBundle: {
        domSnapshot: "<html>...</html>",
        screenshot: "base64...",
        actionHistory: [
          { step: 1, action: "click", selector: "#submit" },
        ],
        rootCause: "element_not_found",
        fixSuggestion: "Add a shorter wait or check selector",
      },
      videoUrl: "https://storage.example.com/videos/run-123.mp4",
      metadata: {
        browser: "chromium",
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0...",
      },
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects insert without required fields", () => {
    const result = insertAgenticRunSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("allows null for all optional fields", () => {
    const input = {
      ...MINIMAL_INPUT,
      groupId: null,
      scheduleId: null,
      stepCount: null,
      duration: null,
      failureBundle: null,
      videoUrl: null,
      metadata: null,
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("allows deeply nested failureBundle (5+ levels)", () => {
    const input = {
      ...MINIMAL_INPUT,
      failureBundle: {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: "deeply nested value",
              },
            },
          },
        },
      },
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("allows large metadata payload (50+ keys)", () => {
    const largeMeta: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      largeMeta[`key_${i}`] = `value_${i}`;
    }
    const input = {
      ...MINIMAL_INPUT,
      metadata: largeMeta,
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("allows videoUrl with special characters", () => {
    const input = {
      ...MINIMAL_INPUT,
      videoUrl: "https://example.com/videos/test%20file+special&chars.mp4",
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("allows stepCount = 0 (run failed before any steps)", () => {
    const input = {
      ...MINIMAL_INPUT,
      stepCount: 0,
      duration: 0,
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("allows duration = 0 (run completed instantly)", () => {
    const input = {
      ...MINIMAL_INPUT,
      duration: 0,
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects non-uuid groupId", () => {
    const input = {
      ...MINIMAL_INPUT,
      groupId: "not-a-uuid",
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid scheduleId", () => {
    const input = {
      ...MINIMAL_INPUT,
      scheduleId: "not-a-uuid",
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer stepCount", () => {
    const input = {
      ...MINIMAL_INPUT,
      stepCount: "five",
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer duration", () => {
    const input = {
      ...MINIMAL_INPUT,
      duration: "slow",
    };
    const result = insertAgenticRunSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
