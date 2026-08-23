import pino from "pino";
import fs from "node:fs";
import path from "node:path";

const isProduction = process.env.NODE_ENV === "production";

const logDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "replay-debug.log");

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          targets: [
            {
              target: "pino-pretty",
              options: { colorize: true },
              level: process.env.LOG_LEVEL ?? "info",
            },
            {
              target: "pino/file",
              options: { destination: logFile, mkdir: true },
              level: "debug",
            },
          ],
        },
      }),
});
