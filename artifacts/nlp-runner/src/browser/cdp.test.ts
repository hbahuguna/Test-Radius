import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { resolveChromePath } from "../config.js";
import { CdpClient, CdpError, connect } from "./cdp.js";
import { launch } from "./launch.js";

interface ServerPair {
  server: WebSocketServer;
  serverWs: WebSocket;
  client: CdpClient;
}

const pairs: ServerPair[] = [];
const openedBrowsers: Awaited<ReturnType<typeof launch>>[] = [];

function sendJson(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

async function makeServerPair(): Promise<ServerPair> {
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
  for (const pair of pairs.splice(0)) {
    pair.client.close();
    pair.serverWs.terminate();
    await new Promise<void>((resolve) => pair.server.close(() => resolve()));
  }
  for (const browser of openedBrowsers.splice(0)) {
    await browser.close();
  }
});

describe("connect", () => {
  it("resolves once the WebSocket handshake completes", async () => {
    const { client, serverWs } = await makeServerPair();
    expect(client).toBeInstanceOf(CdpClient);
    expect(serverWs.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects for an unreachable endpoint", async () => {
    await expect(connect("ws://127.0.0.1:1/devtools/closed", 2_000)).rejects.toThrow();
  });
});

describe("send", () => {
  it("resolves the matching response by id", async () => {
    const { client, serverWs } = await makeServerPair();
    serverWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number };
      sendJson(serverWs, { id: msg.id, result: { pong: true } });
    });
    await expect(client.send("Ping.pong")).resolves.toEqual({ pong: true });
  });

  it("correlates out-of-order responses to their own ids", async () => {
    const { client, serverWs } = await makeServerPair();
    serverWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number };
      if (msg.id === 1) {
        setTimeout(() => sendJson(serverWs, { id: 1, result: "first" }), 30);
      } else {
        sendJson(serverWs, { id: msg.id, result: "second" });
      }
    });
    const first = client.send("A.first");
    const second = client.send("B.second");
    await expect(second).resolves.toBe("second");
    await expect(first).resolves.toBe("first");
  });

  it("rejects with the CDP error message for an invalid method", async () => {
    const { client, serverWs } = await makeServerPair();
    serverWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number };
      sendJson(serverWs, {
        id: msg.id,
        error: { code: -32601, message: "Method not found: NotARealMethod" },
      });
    });
    await expect(client.send("NotARealMethod")).rejects.toThrow(CdpError);
    await expect(client.send("NotARealMethod")).rejects.toThrow(
      /Method not found/,
    );
  });

  it("rejects pending sends when the connection closes", async () => {
    const { client, serverWs } = await makeServerPair();
    const pending = client.send("A.wait");
    serverWs.close();
    await expect(pending).rejects.toThrow(/closed/i);
  });

  it("rejects sends after the connection is closed", async () => {
    const { client, serverWs } = await makeServerPair();
    serverWs.close();
    await new Promise((resolve) => serverWs.once("close", resolve));
    await expect(client.send("A.after")).rejects.toThrow(/not open/);
  });
});

describe("event subscription", () => {
  it("dispatches events to subscribed handlers with params", async () => {
    const { client, serverWs } = await makeServerPair();
    const calls: unknown[] = [];
    client.on("Foo.event", (params) => calls.push(params));
    sendJson(serverWs, { method: "Foo.event", params: { n: 1 } });
    sendJson(serverWs, { method: "Foo.event", params: { n: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("stops dispatching after the handler unsubscribes", async () => {
    const { client, serverWs } = await makeServerPair();
    const calls: unknown[] = [];
    const off = client.on("Foo.event", (params) => calls.push(params));
    const first = client.once("Foo.event");
    sendJson(serverWs, { method: "Foo.event", params: { n: 1 } });
    await expect(first).resolves.toEqual({ n: 1 });
    off();
    sendJson(serverWs, { method: "Foo.event", params: { n: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([{ n: 1 }]);
  });

  it("once() resolves with params for the next matching event", async () => {
    const { client, serverWs } = await makeServerPair();
    const event = client.once("Foo.event");
    sendJson(serverWs, { method: "Foo.event", params: { n: 42 } });
    await expect(event).resolves.toEqual({ n: 42 });
  });

  it("ignores responses that have no registered request", async () => {
    const { client, serverWs } = await makeServerPair();
    serverWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number };
      sendJson(serverWs, { id: msg.id, result: "ok" });
    });
    sendJson(serverWs, { id: 99999, result: "orphan" });
    await expect(client.send("Ping.pong")).resolves.toBe("ok");
  });
});

const detectedChrome = resolveChromePath("auto");

describe("cdp integration against Chrome", () => {
  it.runIf(detectedChrome)(
    "Browser.getVersion returns version JSON",
    async () => {
      const browser = await launch({ timeoutMs: 20_000 });
      openedBrowsers.push(browser);
      const client = await connect(browser.wsUrl);
      const version = await client.send<{
        product?: string;
        protocolVersion?: string;
      }>("Browser.getVersion");
      expect(version.product).toMatch(/^Chrome\//);
      expect(version.protocolVersion).toBeTruthy();
      client.close();
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "an invalid method rejects with the CDP error message",
    async () => {
      const browser = await launch({ timeoutMs: 20_000 });
      openedBrowsers.push(browser);
      const client = await connect(browser.wsUrl);
      await expect(client.send("Totally.Bogus")).rejects.toThrow(
        /wasn.t found|Method not found/i,
      );
      client.close();
    },
    30_000,
  );

  it.runIf(detectedChrome)(
    "Target.targetCreated fires exactly once per created target",
    async () => {
      const browser = await launch({ timeoutMs: 20_000 });
      openedBrowsers.push(browser);
      const client = await connect(browser.wsUrl);

      await client.send("Target.setDiscoverTargets", { discover: true });
      const created = client.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      const seen = await client.once<{ targetInfo: { targetId: string } }>(
        "Target.targetCreated",
      );
      const { targetId } = await created;
      expect(seen.targetInfo.targetId).toBe(targetId);

      const { targetInfos } = await client.send<{
        targetInfos: { targetId: string }[];
      }>("Target.getTargets");
      const matches = targetInfos.filter((info) => info.targetId === targetId);
      expect(matches.length).toBe(1);

      await client.send("Target.closeTarget", { targetId });
      client.close();
    },
    30_000,
  );
});
