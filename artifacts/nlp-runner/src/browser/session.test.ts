import { type AddressInfo } from "node:net";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { resolveChromePath } from "../config.js";
import { CdpClient, connect } from "./cdp.js";
import {
  BrowserSession,
  ElementNotFoundError,
  EvaluationError,
  NavigationError,
  Page,
  WaitTimeoutError,
} from "./session.js";

const sessions: BrowserSession[] = [];
const pairs: {
  server: WebSocketServer;
  serverWs: WebSocket;
  client: CdpClient;
}[] = [];

async function makePair() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const serverWsPromise = new Promise<WebSocket>((resolve) =>
    server.once("connection", resolve),
  );
  const client = await connect(`ws://127.0.0.1:${address.port}`);
  const serverWs = await serverWsPromise;
  const pair = { server, serverWs, client };
  pairs.push(pair);
  return pair;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const pair of pairs.splice(0)) {
    pair.client.close();
    pair.serverWs.terminate();
    await new Promise<void>((resolve) => pair.server.close(() => resolve()));
  }
});

describe("Page event session filtering", () => {
  it("delivers only events for its own session", async () => {
    const { client, serverWs } = await makePair();
    const page = new Page(client, "session-a", "target-1");
    const received: string[] = [];
    page.on("Foo.event", (_params, sessionId) =>
      received.push(String(sessionId)),
    );
    serverWs.send(
      JSON.stringify({
        method: "Foo.event",
        params: { n: 1 },
        sessionId: "session-a",
      }),
    );
    serverWs.send(
      JSON.stringify({ method: "Foo.event", params: { n: 2 }, sessionId: "other" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(["session-a"]);
  });

  it("once() resolves only for the matching session", async () => {
    const { client, serverWs } = await makePair();
    const page = new Page(client, "session-a", "target-1");
    const event = page.once("Foo.event", 1_000);
    serverWs.send(
      JSON.stringify({ method: "Foo.event", params: { n: 1 }, sessionId: "other" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    serverWs.send(
      JSON.stringify({ method: "Foo.event", params: { n: 2 }, sessionId: "session-a" }),
    );
    await expect(event).resolves.toEqual({ n: 2 });
  });
});

const detectedChrome = resolveChromePath("auto");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureServerPath = fileURLToPath(
  new URL("../../fixture/server.ts", import.meta.url),
);

async function waitForServer(
  baseUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

let fixturePort = 0;
let fixtureProc: ChildProcess | undefined;

if (detectedChrome) {
  fixturePort = 3300 + Math.floor(Math.random() * 200);
  fixtureProc = spawn("pnpm", ["exec", "tsx", fixtureServerPath], {
    cwd: pkgRoot,
    env: { ...process.env, PORT: String(fixturePort) },
    stdio: "ignore",
  });
}

const fixtureUp = detectedChrome
  ? await waitForServer(`http://127.0.0.1:${fixturePort}/`, 10_000)
  : false;

afterAll(() => {
  fixtureProc?.kill("SIGTERM");
});

const fixtureBase = () => `http://127.0.0.1:${fixturePort}`;

describe("BrowserSession integration", () => {
  it.runIf(detectedChrome)(
    "newPage returns a page; navigate + getUrl return the URL",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      expect(page.targetId).toBeTruthy();
      expect(page.sessionId).toBeTruthy();

      const url = "data:text/html,<h1>Hello QF-15</h1>";
      await expect(page.navigate(url)).resolves.toEqual({ url });
      expect(await page.getUrl()).toBe(url);
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "Page.loadEventFired fires exactly once per navigation",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      let loads = 0;
      const off = page.on("Page.loadEventFired", () => loads++);
      await page.navigate("data:text/html,<h1>one</h1>");
      await page.navigate("data:text/html,<h1>two</h1>");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(loads).toBe(2);
      off();
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "bogus host navigation errors and the session stays reusable",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();

      await expect(
        page.navigate("http://no-such-host.invalid/", { timeoutMs: 10_000 }),
      ).rejects.toThrow(NavigationError);

      const url = "data:text/html,<h1>back online</h1>";
      await expect(page.navigate(url)).resolves.toEqual({ url });
      expect(await page.getUrl()).toBe(url);
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "attachPage attaches an existing target",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const { targetId } = await session.client.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      const page = await session.attachPage(targetId);
      expect(page.targetId).toBe(targetId);
      const url = "data:text/html,<h1>attached</h1>";
      await page.navigate(url);
      expect(await page.getUrl()).toBe(url);
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "pages() lists page targets",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const before = await session.pages();
      await session.newPage();
      await session.newPage();
      const after = await session.pages();
      expect(after.length).toBe(before.length + 2);
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "close() kills the Chrome process and closes the socket",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      const pid = session.browser.pid;
      expect(() => process.kill(pid, 0)).not.toThrow();
      await session.close();
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(
        session.client.send("Browser.getVersion"),
      ).rejects.toThrow(/not open/);
    },
    30_000,
  );
});

const integration = fixtureUp && detectedChrome;

describe("QF-16 page primitives", () => {
  it.runIf(integration)(
    "evaluate returns serializable values, accepts args and expressions",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      expect(await page.evaluate(() => document.title)).toBe(
        "Login — QueryFirst Fixture",
      );
      const innerWidth = await page.evaluate(() =>
        JSON.stringify(window.innerWidth),
      );
      expect(typeof innerWidth).toBe("string");
      expect(Number(innerWidth)).toBeGreaterThan(0);
      expect(await page.evaluate((a: number, b: number) => a + b, 2, 3)).toBe(5);
      expect(await page.evaluate("document.title")).toBe(
        "Login — QueryFirst Fixture",
      );
    },
    30_000,
  );

  it.runIf(integration)(
    "evaluate surfaces the JS exception message",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      await expect(
        page.evaluate(() => {
          throw new Error("boom-qf16");
        }),
      ).rejects.toThrow(EvaluationError);
      await expect(
        page.evaluate(() => {
          throw new Error("boom-qf16");
        }),
      ).rejects.toThrow(/boom-qf16/);
    },
    30_000,
  );

  it.runIf(integration)(
    "screenshot returns a valid PNG base64 string",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const b64 = await page.screenshot();
      expect(Buffer.from(b64, "base64").subarray(0, 8)).toEqual(PNG_SIGNATURE);
    },
    30_000,
  );

  it.runIf(integration)(
    "screenshot writes a non-zero-byte PNG to disk",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const file = join(
        tmpdir(),
        `qf16-shot-${Date.now()}-${Math.random()}.png`,
      );
      await page.screenshot({ file });
      try {
        const info = await stat(file);
        expect(info.size).toBeGreaterThan(0);
        expect((await readFile(file)).subarray(0, 8)).toEqual(PNG_SIGNATURE);
      } finally {
        await rm(file, { force: true });
      }
    },
    30_000,
  );

  it.runIf(integration)(
    "screenshot on a blank page returns a valid PNG",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();

      expect(
        Buffer.from(await page.screenshot(), "base64").subarray(0, 8),
      ).toEqual(PNG_SIGNATURE);
    },
    30_000,
  );

  it.runIf(integration)(
    "queryElement returns coordinates inside the email input",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const loc = await page.queryElement("#login-email");
      expect(loc.width).toBeGreaterThan(0);
      expect(loc.height).toBeGreaterThan(0);
      expect(loc.centerX).toBeGreaterThanOrEqual(loc.x);
      expect(loc.centerX).toBeLessThanOrEqual(loc.x + loc.width);
      expect(loc.centerY).toBeGreaterThanOrEqual(loc.y);
      expect(loc.centerY).toBeLessThanOrEqual(loc.y + loc.height);
    },
    30_000,
  );

  it.runIf(integration)(
    "queryElement multi-match selector returns the first match",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const firstInput = await page.queryElement("input");
      const email = await page.queryElement("#login-email");
      expect(firstInput.x).toBe(email.x);
      expect(firstInput.y).toBe(email.y);
    },
    30_000,
  );

  it.runIf(integration)(
    "queryElement missing selector throws ElementNotFoundError",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      await expect(page.queryElement("#nope-qf16")).rejects.toThrow(
        ElementNotFoundError,
      );
    },
    30_000,
  );

  it.runIf(integration)(
    "fill then click triggers the form handler like a human click",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      await page.fill('[data-testid="login-email"]', "a@b.com");
      await page.fill('[data-testid="login-password"]', "secret");
      await page.click('[data-testid="login-submit"]');
      const text = await page.evaluate(
        () =>
          (document.querySelector("#login-result") as HTMLElement).textContent,
      );
      expect(text).toBe("Welcome back, a@b.com!");
    },
    30_000,
  );

  it.runIf(integration)(
    "fill replaces a prior value rather than appending",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      await page.fill("#login-email", "first@x.com");
      await page.fill("#login-email", "second@x.com");
      const value = await page.evaluate(
        () =>
          (document.querySelector("#login-email") as HTMLInputElement).value,
      );
      expect(value).toBe("second@x.com");
    },
    30_000,
  );

  it.runIf(integration)(
    "fill fires a real input event",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      await page.evaluate(() => {
        const w = window as unknown as { __qf16InputFired: boolean };
        w.__qf16InputFired = false;
        document
          .querySelector("#login-email")!
          .addEventListener("input", () => {
            w.__qf16InputFired = true;
          });
      });
      await page.fill("#login-email", "x@y.com");
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __qf16InputFired: boolean })
              .__qf16InputFired,
        ),
      ).toBe(true);
    },
    30_000,
  );

  it.runIf(integration)(
    "click and fill work on the ?redesign=1 variant via remapped testids",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login?redesign=1`);

      expect(
        await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="redesign-banner"]')),
        ),
      ).toBe(true);
      await page.fill(
        '[data-testid="login-email-address"]',
        "ada@lovelace.dev",
      );
      await page.fill('[data-testid="login-password-field"]', "secret");
      await page.click('[data-testid="btn-sign-in"]');
      const text = await page.evaluate(
        () =>
          (
            document.querySelector(
              '[data-testid="login-message"]',
            ) as HTMLElement
          ).textContent,
      );
      expect(text).toBe("Welcome back, ada@lovelace.dev!");
    },
    30_000,
  );
});

describe("QF-23 a11y snapshot", () => {
  it.runIf(integration)(
    "snapshot lists interactive controls on /signup with role/name",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/signup`);

      const snap = await page.getAccessibilitySnapshot();
      const byRef = new Map(snap.map((n) => [n.ref, n]));

      const name = byRef.get('[data-testid="signup-name"]');
      expect(name?.role).toBe("textbox");
      expect(name?.name).toBe("Name");

      const email = byRef.get('[data-testid="signup-email"]');
      expect(email?.role).toBe("textbox");
      expect(email?.name).toBe("Email");

      const submit = byRef.get('[data-testid="signup-submit"]');
      expect(submit?.role).toBe("button");
      expect(submit?.name).toBe("Create account");

      expect(snap.some((n) => n.role === "heading")).toBe(false);
      expect(snap.some((n) => n.ref === '[data-testid="signup-result"]')).toBe(
        false,
      );
      for (const n of snap) {
        expect(n.bounds.width).toBeGreaterThan(0);
        expect(n.bounds.height).toBeGreaterThan(0);
      }
    },
    30_000,
  );

  it.runIf(integration)(
    "snapshot bounds overlap the real element locations",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/signup`);

      const snap = await page.getAccessibilitySnapshot();
      const email = snap.find((n) => n.ref === '[data-testid="signup-email"]');
      expect(email).toBeDefined();

      const loc = await page.queryElement('[data-testid="signup-email"]');
      const centerX = email!.bounds.x + email!.bounds.width / 2;
      const centerY = email!.bounds.y + email!.bounds.height / 2;
      expect(Math.abs(centerX - loc.centerX)).toBeLessThan(2);
      expect(Math.abs(centerY - loc.centerY)).toBeLessThan(2);
    },
    30_000,
  );

  it.runIf(integration)(
    "snapshot reflects the ?redesign=1 testids",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login?redesign=1`);

      const snap = await page.getAccessibilitySnapshot();
      const byRef = new Map(snap.map((n) => [n.ref, n]));

      const email = byRef.get('[data-testid="login-email-address"]');
      expect(email?.role).toBe("textbox");
      expect(email?.name).toBe("Email");

      const submit = byRef.get('[data-testid="btn-sign-in"]');
      expect(submit?.role).toBe("button");
      expect(submit?.name).toBe("Sign in");

      expect(byRef.has('[data-testid="login-email"]')).toBe(false);
      expect(snap.some((n) => n.name.includes("Redesigned layout"))).toBe(false);
    },
    30_000,
  );
});

describe("QF-24 page signature", () => {
  it.runIf(integration)(
    "same page across two loads produces identical signatures",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const first = await page.pageSignature();
      await page.navigate(`${fixtureBase()}/login`);
      const second = await page.pageSignature();
      expect(second).toBe(first);
      expect(first).toMatch(/^[0-9a-f]{8}$/);
    },
    30_000,
  );

  it.runIf(integration)(
    "changing the visible heading changes the signature",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const original = await page.pageSignature();
      await page.evaluate(() => {
        (document.querySelector("h1") as HTMLElement).textContent =
          "Totally different heading";
      });
      expect(await page.pageSignature()).not.toBe(original);
    },
    30_000,
  );

  it.runIf(integration)(
    "adding an interactive element changes the signature",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const original = await page.pageSignature();
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.dataset.testid = "injected-btn";
        btn.textContent = "Injected";
        document.body.appendChild(btn);
      });
      expect(await page.pageSignature()).not.toBe(original);
    },
    30_000,
  );

  it.runIf(integration)(
    "filling a form field changes the signature",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/signup`);

      const empty = await page.pageSignature();
      await page.fill('[data-testid="signup-email"]', "ada@example.com");
      expect(await page.pageSignature()).not.toBe(empty);
    },
    30_000,
  );

  it.runIf(integration)(
    "revealing hidden result text changes the signature",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/signup`);

      const before = await page.pageSignature();
      // clicking the submit reveals the (hidden) #signup-result paragraph text
      await page.click('[data-testid="signup-submit"]');
      expect(await page.pageSignature()).not.toBe(before);
    },
    30_000,
  );

  it.runIf(integration)(
    "?redesign=1 vs normal mode produce different signatures",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const normal = await page.pageSignature();
      await page.navigate(`${fixtureBase()}/login?redesign=1`);
      const redesign = await page.pageSignature();
      expect(redesign).not.toBe(normal);
    },
    30_000,
  );
});

describe("QF-25 element fingerprint", () => {
  it.runIf(integration)(
    "same element across two loads produces identical fingerprints",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const first = await page.fingerprint('[data-testid="login-email"]');
      await page.navigate(`${fixtureBase()}/login`);
      const second = await page.fingerprint('[data-testid="login-email"]');
      expect(second).toBe(first);
      expect(first).toMatch(/^[0-9a-f]{8}$/);
    },
    30_000,
  );

  it.runIf(integration)(
    "adding id / class / aria-label changes the fingerprint",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const baseline = await page.fingerprint('[data-testid="login-email"]');

      await page.evaluate(() => {
        document
          .querySelector('[data-testid="login-email"]')!
          .setAttribute("aria-label", "Email address");
      });
      expect(await page.fingerprint('[data-testid="login-email"]')).not.toBe(
        baseline,
      );

      await page.evaluate(() => {
        document
          .querySelector('[data-testid="login-email"]')!
          .classList.add("is-validated");
      });
      expect(await page.fingerprint('[data-testid="login-email"]')).not.toBe(
        baseline,
      );

      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="login-email"]')!;
        el.id = "renamed-email";
      });
      expect(await page.fingerprint('[data-testid="login-email"]')).not.toBe(
        baseline,
      );
    },
    30_000,
  );

  it.runIf(integration)(
    "two different elements produce different fingerprints",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/login`);

      const email = await page.fingerprint('[data-testid="login-email"]');
      const password = await page.fingerprint('[data-testid="login-password"]');
      const submit = await page.fingerprint('[data-testid="login-submit"]');
      expect(password).not.toBe(email);
      expect(submit).not.toBe(email);
    },
    30_000,
  );
});

describe("QF-26 waitFor unit", () => {
  function fakePage(sequence: unknown[]) {
    const page = new Page({} as CdpClient, "session-x", "target-x");
    let calls = 0;
    page.evaluate = async <T = unknown>(
      _fn: string | ((...args: unknown[]) => T),
      ..._args: unknown[]
    ): Promise<T> => {
      const value = sequence[Math.min(calls, sequence.length - 1)];
      calls++;
      return value as T;
    };
    return { page, calls: () => calls };
  }

  it("resolves immediately when the condition already holds", async () => {
    const { page, calls } = fakePage([true]);
    await expect(
      page.waitFor(() => true, { timeoutMs: 500 }),
    ).resolves.toBe(true);
    expect(calls()).toBe(1);
  });

  it("polls until the condition becomes truthy and returns the value", async () => {
    const { page, calls } = fakePage([false, false, "done"]);
    await expect(
      page.waitFor(() => "done", { timeoutMs: 2000, pollMs: 10 }),
    ).resolves.toBe("done");
    expect(calls()).toBe(3);
  });

  it("throws WaitTimeoutError when the condition never holds", async () => {
    const { page, calls } = fakePage([false]);
    const started = Date.now();
    const err = await page
      .waitFor(() => false, {
        timeoutMs: 80,
        pollMs: 20,
        desc: "magic appears",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect(String(err)).toContain("magic appears");
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(calls()).toBeGreaterThan(2);
  });

  it("propagates errors thrown by the predicate immediately", async () => {
    const page = new Page({} as CdpClient, "session-x", "target-x");
    page.evaluate = vi.fn(async () => {
      throw new EvaluationError("boom");
    });
    await expect(
      page.waitFor(() => {
        throw new Error("boom");
      }),
    ).rejects.toBeInstanceOf(EvaluationError);
  });
});

describe("QF-26 waitFor integration", () => {
  it.runIf(integration)(
    "resolves once a condition becomes true on a live page",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/dynamic`);

      const started = Date.now();
      const visible = await page.waitFor(
        () =>
          !(document.querySelector("#appears-late") as HTMLElement).classList.contains(
            "hidden",
          ),
        { timeoutMs: 5000, pollMs: 100, desc: "appears-late becomes visible" },
      );
      expect(visible).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    },
    30_000,
  );

  it.runIf(integration)(
    "throws WaitTimeoutError for a condition that never holds",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/dynamic`);

      const err = await page
        .waitFor(() => false, {
          timeoutMs: 1000,
          pollMs: 100,
          desc: "never happens",
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(WaitTimeoutError);
      expect(String(err)).toContain("never happens");
    },
    30_000,
  );

  it.runIf(integration)(
    "returns the resolved value from the predicate",
    async () => {
      const session = await BrowserSession.launch({ timeoutMs: 20_000 });
      sessions.push(session);
      const page = await session.newPage();
      await page.navigate(`${fixtureBase()}/dynamic`);

      const status = await page.waitFor(
        () =>
          (document.querySelector('[data-testid="dynamic-status"]') as HTMLElement)
            .textContent === "Ready",
        { timeoutMs: 5000, pollMs: 100 },
      );
      expect(status).toBe(true);
    },
    30_000,
  );
});
