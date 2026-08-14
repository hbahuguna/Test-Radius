import { describe, expect, it } from "vitest";
import { ChromeLaunchError, buildLaunchArgs, parseDevToolsUrl } from "./index.js";

describe("smoke", () => {
  it("exports launch-related helpers", () => {
    expect(typeof parseDevToolsUrl).toBe("function");
    expect(typeof buildLaunchArgs).toBe("function");
    expect(ChromeLaunchError.name).toBe("ChromeLaunchError");
  });

  it("runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });
});
