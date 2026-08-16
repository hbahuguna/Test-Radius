import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ChromePipe } from "./pipe.js";

describe("ChromePipe", () => {
  function makePipe(onMessage: (text: string) => void): {
    cmdIn: PassThrough;
    respOut: PassThrough;
    pipe: ChromePipe;
  } {
    // Chrome's pipe protocol: commands are written to fd3, responses are read
    // from fd4. Both are framed as null-terminated JSON.
    const cmdIn = new PassThrough();
    const respOut = new PassThrough();
    const pipe = new ChromePipe(respOut, cmdIn, onMessage);
    return { cmdIn, respOut, pipe };
  }

  it("emits a message from a single null-terminated frame", () => {
    const seen: string[] = [];
    const { respOut, pipe } = makePipe((t) => seen.push(t));
    respOut.write('{"a":1}\u0000');
    expect(seen).toEqual(['{"a":1}']);
    expect(pipe["closed"]).toBe(false);
  });

  it("reassembles a frame split across chunks", () => {
    const seen: string[] = [];
    const { respOut, pipe } = makePipe((t) => seen.push(t));
    respOut.write('{"b":');
    expect(seen).toEqual([]);
    respOut.write('2}\u0000');
    expect(seen).toEqual(['{"b":2}']);
    expect(pipe["closed"]).toBe(false);
  });

  it("handles multiple frames packed into one chunk", () => {
    const seen: string[] = [];
    const { respOut, pipe } = makePipe((t) => seen.push(t));
    respOut.write("AA\u0000BBBB\u0000");
    expect(seen).toEqual(["AA", "BBBB"]);
    expect(pipe["closed"]).toBe(false);
  });

  it("writes null-terminated frames to the command stream", () => {
    const { cmdIn, pipe } = makePipe(() => {});
    const chunks: Buffer[] = [];
    cmdIn.on("data", (c: Buffer) => chunks.push(c));
    pipe.send('{"method":"x"}');
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"method":"x"}\u0000');
  });

  it("stops sending after the stream closes", async () => {
    const { cmdIn, respOut, pipe } = makePipe(() => {});
    const ended = new Promise<void>((resolve) => respOut.on("end", () => resolve()));
    respOut.end();
    await ended;
    expect(pipe["closed"]).toBe(true);
    expect(pipe.send("nope")).toBe(false);
    expect(cmdIn.readableLength).toBe(0);
  });
});
