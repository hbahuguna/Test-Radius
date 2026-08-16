import type { Readable, Writable } from "node:stream";

/**
 * Chrome DevTools `--remote-debugging-pipe` transport.
 *
 * Chrome requires two extra pipes passed as file descriptors 3 (commands in)
 * and 4 (responses out) and frames every message as null-terminated JSON:
 * `{"id":1,"method":...}\0`. See Playwright's PipeTransport and Chromium's
 * devtools_pipe_handler for the reference wire format.
 */
export class ChromePipe {
  private pending: Buffer[] = [];
  private closed = false;

  constructor(
    private readonly readStream: Readable,
    private readonly writeStream: Writable,
    private readonly onMessage: (text: string) => void,
  ) {
    readStream.on("data", (chunk: Buffer) => this.onData(chunk));
    readStream.on("end", () => {
      this.closed = true;
    });
    readStream.on("error", () => {
      this.closed = true;
    });
  }

  send(text: string): boolean {
    if (this.closed) return false;
    this.writeStream.write(text);
    this.writeStream.write("\0");
    return true;
  }

  close(): void {
    this.closed = true;
    this.writeStream.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let start = 0;
    let idx: number;
    while ((idx = chunk.indexOf(0, start)) !== -1) {
      if (idx > start) this.pending.push(chunk.subarray(start, idx));
      const message = Buffer.concat(this.pending).toString("utf8");
      this.pending = [];
      this.onMessage(message);
      start = idx + 1;
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
  }
}
