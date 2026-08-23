import { Request, Response, NextFunction } from "express";
import { getFieldServeDb, FieldServeDataStore } from "./fieldserve-db";

let activeSessionId: number | null = null;
let stepSeq = 0;

function getStore(): FieldServeDataStore {
  return new FieldServeDataStore(getFieldServeDb());
}

export function startRecording(name: string, baseUrl: string, apiSpec?: string, apiSpecUrl?: string): number {
  const store = getStore();
  activeSessionId = store.startRecordingSession(name, baseUrl, apiSpec, apiSpecUrl);
  stepSeq = 0;
  return activeSessionId!;
}

export function stopRecording(): void {
  if (activeSessionId === null) return;
  const store = getStore();
  store.stopRecordingSession(activeSessionId);
  activeSessionId = null;
  stepSeq = 0;
}

export function isRecording(): boolean {
  return activeSessionId !== null;
}

export function getActiveSessionId(): number | null {
  return activeSessionId;
}

export function recordingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (activeSessionId === null) {
    next();
    return;
  }

  // Don't capture the recording control endpoints themselves (start/stop/status/sessions)
  if (req.path.startsWith("/record")) {
    next();
    return;
  }

  const startTime = Date.now();
  const seq = ++stepSeq;

  // Strip hop-by-hop and auth headers — they are transient and will expire
  const SKIP_HEADERS = new Set(["authorization", "host", "connection", "accept-encoding", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"]);
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string" && !SKIP_HEADERS.has(k.toLowerCase())) reqHeaders[k] = v;
  }

  let reqBody: string | null = null;
  if (req.body && typeof req.body === "object") {
    reqBody = JSON.stringify(req.body);
  } else if (typeof req.body === "string") {
    reqBody = req.body;
  }

  const originalSend = res.send.bind(res);
  const chunks: Buffer[] = [];

  (res as any).send = function (body: any) {
    const durationMs = Date.now() - startTime;
    const resHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.getHeaders())) {
      if (typeof v === "string") resHeaders[k] = v;
    }

    let resBody = "";
    if (Buffer.isBuffer(body)) {
      resBody = body.toString("utf-8");
    } else if (typeof body === "string") {
      resBody = body;
    } else if (body !== undefined && body !== null) {
      try { resBody = JSON.stringify(body); } catch { resBody = String(body); }
    }

    try {
      // Re-check: recording may have been stopped before this response is sent
      if (activeSessionId !== null) {
        const store = getStore();
        store.addRecordedStep(
          activeSessionId!,
          seq,
          req.method,
          req.originalUrl || req.url,
          reqHeaders,
          reqBody,
          res.statusCode,
          resHeaders,
          resBody.slice(0, 10240),
          durationMs,
        );
      }
    } catch {
      // Don't let recording errors break requests
    }

    return originalSend(body);
  };

  next();
}
