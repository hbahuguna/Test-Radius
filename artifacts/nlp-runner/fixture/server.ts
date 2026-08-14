import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const PORT = Number(process.env.PORT ?? 3123);

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = normalize(resolve(FIXTURE_DIR, relPath));

  if (!filePath.startsWith(FIXTURE_DIR + sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  if (!existsSync(filePath) && !extname(filePath)) {
    filePath = filePath + ".html";
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }

  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
});

server.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other server or set PORT to a free port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QueryFirst fixture running at http://localhost:${PORT}`);
  console.log("Routes:");
  console.log("  /                  -> index.html");
  console.log("  /login             -> login.html");
  console.log("  /signup            -> signup.html");
  console.log("  /pricing-waitlist  -> pricing-waitlist.html");
  console.log("  /dynamic           -> dynamic.html");
  console.log("Redesign mode: append ?redesign=1 (persists for the session; ?redesign=0 resets).");
});
