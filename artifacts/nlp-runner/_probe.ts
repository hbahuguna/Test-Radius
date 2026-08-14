import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowserSession } from "./src/browser/session.js";

const pkgRoot = fileURLToPath(new URL(".", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixture/server.ts", import.meta.url));
const port = 4400 + Math.floor(Math.random() * 100);

const proc = spawn("pnpm", ["exec", "tsx", fixturePath], {
  cwd: pkgRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

async function waitForServer(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

await waitForServer(`http://127.0.0.1:${port}/`, 10_000);

const session = await BrowserSession.launch({ timeoutMs: 20_000 });
const page = await session.newPage();
await page.navigate(`http://127.0.0.1:${port}/signup`);
await page.fill("[data-testid=signup-email]", "ada@example.com");
await page.click("[data-testid=signup-submit]");
await new Promise((r) => setTimeout(r, 500));

const visible = await page.evaluate(() => {
  const el = document.querySelector("#signup-result");
  const rect = el.getBoundingClientRect();
  return { hidden: el.hidden, text: el.textContent, w: rect.width, h: rect.height };
});
console.log("after click:", JSON.stringify(visible));
console.log("url:", await page.getUrl());

await session.close();
proc.kill("SIGTERM");
