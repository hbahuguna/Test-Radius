import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadSpawner() {
  process.env.BROWSER_USE_URL = "http://localhost:8001";
  vi.resetModules();
  return import("../browser-use-spawner");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("waitForBrowserUseReady", () => {
  it("keeps probing until the service becomes healthy", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { waitForBrowserUseReady } = await loadSpawner();
    await expect(
      waitForBrowserUseReady({ timeoutMs: 250, pollIntervalMs: 1 }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false when the service never becomes healthy before timeout", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const { waitForBrowserUseReady } = await loadSpawner();
    await expect(
      waitForBrowserUseReady({ timeoutMs: 5, pollIntervalMs: 1 }),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });
});