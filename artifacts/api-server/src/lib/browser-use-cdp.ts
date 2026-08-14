/**
 * Resolve a Chrome DevTools Protocol WebSocket URL from an HTTP CDP endpoint.
 *
 * browser-use (Python) launches Chrome with `--remote-debugging-port=<N>`.
 * We connect our own CdpClient to the same Chrome instance via the WebSocket
 * URL exposed at `http://127.0.0.1:<N>/json/version`.
 */

export interface ChromeVersionInfo {
  webSocketDebuggerUrl: string;
  [key: string]: unknown;
}

/**
 * Fetch `<httpCdpUrl>/json/version` and return the `webSocketDebuggerUrl`.
 *
 * @param httpCdpUrl - e.g. `http://127.0.0.1:9242`
 */
export async function resolveWsUrl(httpCdpUrl: string): Promise<string> {
  const res = await fetch(`${httpCdpUrl}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Chrome version info from ${httpCdpUrl}/json/version: HTTP ${res.status}`,
    );
  }
  const info = (await res.json()) as ChromeVersionInfo;
  if (!info.webSocketDebuggerUrl) {
    throw new Error(
      `Chrome version info at ${httpCdpUrl}/json/version has no webSocketDebuggerUrl`,
    );
  }
  return info.webSocketDebuggerUrl;
}

/**
 * Resolve the HTTP CDP base URL from a WebSocket CDP URL.
 * `ws://127.0.0.1:9242/devtools/browser/abc` → `http://127.0.0.1:9242`
 */
export function httpCdpUrlFromWs(wsUrl: string): string {
  const m = /^https?:\/\/([^/]+)/.exec(wsUrl) ?? /^wss?:\/\/([^/]+)/.exec(wsUrl);
  if (!m) throw new Error(`Cannot parse CDP URL: ${wsUrl}`);
  const proto = wsUrl.startsWith("wss") ? "https" : "http";
  return `${proto}://${m[1]}`;
}
