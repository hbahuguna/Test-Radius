import { start } from "node:repl";
import { launch } from "./launch.js";
import { connect } from "./cdp.js";
import { BrowserSession, Page } from "./session.js";

const FIXTURE_URL = "http://localhost:3123";

const session: BrowserSession = await BrowserSession.launch({
  headless: process.env.QF_PROBE_HEADFUL === "1" ? false : true,
  timeoutMs: 20_000,
});

const context = {
  FIXTURE_URL,
  launch,
  connect,
  BrowserSession,
  session,
  browser: session.browser,
  client: session.client,
  send: session.client.send.bind(session.client),
  on: session.client.on.bind(session.client),
  once: session.client.once.bind(session.client),
  newPage: session.newPage.bind(session),
  pages: session.pages.bind(session),
  async exit(): Promise<void> {
    await session.close();
    process.exit(0);
  },
};

console.log("QueryFirst CDP probe — live session");
console.log(`  wsUrl:  ${session.browser.wsUrl}`);
console.log(`  pid:    ${session.browser.pid} (headless=${session.browser.headless})`);
console.log("Helpers:");
console.log("  send(method, params?)     raw CDP send (browser connection)");
console.log("  on(method, cb)            subscribe to events (returns unsub fn)");
console.log("  once(method)              await the next event");
console.log("  newPage(url?)             create + attach a page -> Page");
console.log("  pages()                   list page targets");
console.log("  session.close() / exit()  shutdown and quit");
console.log("Page API: page.send, page.on, page.once, page.navigate(url), page.getUrl()");
console.log("          page.evaluate(fn|expr, ...args), page.screenshot({file?, fullPage?})");
console.log("          page.queryElement(sel), page.click(sel), page.fill(sel, text)");
console.log("          page.getAccessibilitySnapshot() -> [{ ref, role, name, bounds }]");
console.log("          page.pageSignature() -> 8-hex hash (URL+title+landmarks+interactives)");
console.log("          page.fingerprint(sel) -> 8-hex hash of element tag+attrs+path");
console.log("          page.waitFor(predicate, {timeoutMs?, pollMs?, desc?}) -> poll until truthy");
console.log(`  fixture: ${FIXTURE_URL}  (pnpm fixture)`);
console.log('Try:  const p = await newPage(); await p.navigate(FIXTURE_URL + "/login")');

const repl = start({ prompt: "cdp> ", useGlobal: false });
Object.assign(repl.context, context);

repl.on("exit", async () => {
  await session.close();
  process.exit(0);
});
