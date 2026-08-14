import WebSocket from "ws";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class CdpError extends Error {
  override name = "CdpError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type CdpEventHandler = (params: unknown, sessionId?: string) => void;

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export function connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpClient> {
  return CdpClient.connect(wsUrl, timeoutMs);
}

export class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<CdpEventHandler>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => {
      this.rejectAllPending(new Error("CDP connection closed"));
    });
    ws.on("error", (err) => {
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
    });
  }

  static connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out connecting to ${wsUrl}`));
      }, timeoutMs);
      timer.unref();
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  send<T = unknown>(
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP connection is not open (cannot send "${method}")`));
        return;
      }
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      const payload: CdpMessage = { id, method };
      if (params !== undefined) payload.params = params;
      if (sessionId !== undefined) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(
          new Error(`Failed to send CDP message "${method}": ${err.message}`),
        );
      });
    });
  }

  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.listeners.delete(method);
    };
  }

  once<T = unknown>(method: string, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let off: (() => void) | undefined;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error(`Timed out waiting for CDP event "${method}"`));
      }, timeoutMs);
      timer.unref();
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off?.();
        resolve(params as T);
      });
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(rawDataToString(data)) as CdpMessage;
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const request = this.pending.get(msg.id);
      if (!request) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        request.reject(
          new CdpError(
            msg.error.code,
            msg.error.data !== undefined
              ? `${msg.error.message} (${JSON.stringify(msg.error.data)})`
              : msg.error.message,
          ),
        );
      } else {
        request.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const handler of [...handlers]) {
          handler(msg.params, msg.sessionId);
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      request.reject(error);
    }
  }
}
