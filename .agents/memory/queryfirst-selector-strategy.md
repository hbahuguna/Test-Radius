---
name: QueryFirst selector strategy
description: How text="..." locators work in the replay engine and the pitfall that caused "No element matches selector" failures.
---

## The bug

`resolveElement` (in `replay/dom.ts`) runs inside `page.evaluate()` call A. When it matches an element via `text="FAQs"`, it converted the live-DOM element to an `nth-child` CSS path **at that moment** and returned the path as `selector`. Then `page.click(selector)` ran `document.querySelector(nth-child-path)` in a **separate** evaluate call B — by which time a micro-DOM-mutation (scroll, animation, lazy-load) could make the path invalid.

Also: the text search in `resolveElement` only covered `button,a,summary` — missing `[role="tab"]` and other interactive roles.

## The fix

1. **`replay/dom.ts`**: Return the `text="..."` locator itself as the selector (don't convert to nth-child). Also expanded text search to include `[role="tab"],[role="button"],[role="link"],[role="menuitem"],[role="option"],li`.

2. **`browser/session.ts`**: All in-page evaluate calls that use `document.querySelector(sel)` — `queryElement`, `scrollIntoView`, `fill`, `select` — now handle `text="..."` format inline using imperative for-loops (no nested function definitions; esbuild-safe).

3. **`util/dom-queries.ts`**: `elementText`, `elementValue`, `elementIsVisible` — each inlines the same text-search logic. These functions are stringified and eval'd in the page, so helpers must be inlined, not shared.

## Why inline (not a shared helper)

Functions passed to `page.evaluate()` are stringified via `fn.toString()` and executed inside Chromium. Module-level helpers, imports, and closure variables are NOT available. Every function must be completely self-contained with inline logic only (no nested named functions — esbuild may inject `__name()` wrappers that break in-page execution).

## How to apply

Any time a new `session.ts` method does `document.querySelector(sel)` and the selector might come from the replay engine, add the same `if (sel.startsWith('text="')) { ... }` guard inline.
