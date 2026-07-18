import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Stripe webhook needs the raw request body for signature verification.
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));

app.use("/api", router);

// In production, serve the built SPA so the API and frontend share one origin.
const PUBLIC_DIR_RAW = process.env.PUBLIC_DIR;
const PUBLIC_DIR = PUBLIC_DIR_RAW ? path.resolve(PUBLIC_DIR_RAW) : null;
// Vite emits to <outDir>/public when root is not the project root; resolve
// the actual index.html location defensively.
const SPA_DIR = PUBLIC_DIR
  ? fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
    ? PUBLIC_DIR
    : fs.existsSync(path.join(PUBLIC_DIR, "public", "index.html"))
      ? path.join(PUBLIC_DIR, "public")
      : PUBLIC_DIR
  : null;

if (SPA_DIR) {
  app.use(express.static(SPA_DIR));
  // SPA fallback — any non-API GET routes to index.html
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(SPA_DIR, "index.html"));
  });
  logger.info({ SPA_DIR }, "Serving static SPA from SPA_DIR");
}

export default app;

