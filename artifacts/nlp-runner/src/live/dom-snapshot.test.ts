import { describe, expect, it } from "vitest";
import { formatDom, type DomEntry } from "./dom-snapshot.js";

function entry(partial: Partial<DomEntry>): DomEntry {
  return {
    depth: 0,
    tag: "div",
    attrs: "",
    text: null,
    ref: null,
    interactive: false,
    scrollable: false,
    ...partial,
  };
}

describe("formatDom", () => {
  it("assigns sequential indices and renders the browser-use format", () => {
    const entries: DomEntry[] = [
      entry({ depth: 0, tag: "input", attrs: "type=text placeholder=Email", ref: "#email", interactive: true }),
      entry({ depth: 0, tag: "button", attrs: "class=btn", ref: "[data-testid='submit']", interactive: true }),
      entry({ depth: 1, tag: "div", text: "Some label text" }),
    ];
    const { text, selectorMap } = formatDom(entries);
    expect(selectorMap.get(1)).toBe("#email");
    expect(selectorMap.get(2)).toBe("[data-testid='submit']");
    expect(text).toContain("[1]<input type=text placeholder=Email />");
    expect(text).toContain("[2]<button class=btn />");
    expect(text).toContain("\tSome label text");
    expect(text.startsWith("[Start of page]")).toBe(true);
    expect(text.endsWith("[End of page]")).toBe(true);
  });

  it("marks new elements with *", () => {
    const entries: DomEntry[] = [
      entry({ ref: "#existing", interactive: true }),
      entry({ ref: "#fresh", interactive: true }),
    ];
    const first = formatDom(entries);
    expect(first.text).toContain("*[1]<div");
    expect(first.text).toContain("*[2]<div");

    // A snapshot that already saw #existing treats only #fresh as new.
    const second = formatDom(entries, new Set(["#existing"]));
    expect(second.text).toContain("[1]<div");
    expect(second.text).not.toContain("*[1]");
    expect(second.text).toContain("*[2]<div");
  });

  it("adds |SCROLL| markers for scrollable elements", () => {
    const entries: DomEntry[] = [
      entry({ ref: "#list", interactive: true, scrollable: true }),
    ];
    const { text } = formatDom(entries);
    expect(text).toContain("|SCROLL|[1]<div");
  });

  it("truncates long output", () => {
    const entries: DomEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(entry({ ref: `#el${i}`, interactive: true }));
    }
    const { text } = formatDom(entries, new Set(), 120);
    expect(text).toContain("truncated");
  });

  it("skips non-interactive containers with no text", () => {
    const entries: DomEntry[] = [entry({ depth: 0, text: null, interactive: false })];
    const { text, selectorMap } = formatDom(entries);
    expect(selectorMap.size).toBe(0);
    expect(text).not.toContain("<div");
  });
});
