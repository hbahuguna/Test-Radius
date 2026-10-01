#!/usr/bin/env node
// Diagnose DATABASE_URL connectivity: DNS (IPv4/IPv6), TCP reachability, and
// a real Postgres handshake. Usage:
//   node scripts/check-connection.mjs
//   node scripts/check-connection.mjs "postgresql://..."
//
// Exits non-zero if the database is unreachable, so it can gate scripts/CI.
import { lookup } from "node:dns/promises";
import net from "node:net";
import pg from "pg";

const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) {
  console.error("No DATABASE_URL provided (arg or env).");
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("DATABASE_URL is not a valid URL.");
  process.exit(2);
}

const host = parsed.hostname;
const port = Number(parsed.port || 5432);
console.log(`Host: ${host}`);
console.log(`Port: ${port}`);
console.log(`User: ${decodeURIComponent(parsed.username)}`);
console.log("");

async function tcpProbe(family, address) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port, family });
    const start = Date.now();
    socket.setTimeout(6000);
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - start });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "timeout", ms: Date.now() - start });
    });
    socket.once("error", (err) => {
      resolve({ ok: false, error: err.code || err.message, ms: Date.now() - start });
    });
  });
}

const addresses = await lookup(host, { all: true }).catch((err) => {
  console.error(`DNS lookup failed: ${err.code || err.message}`);
  return [];
});

if (addresses.length === 0) {
  console.error("No DNS records found for host.");
  process.exit(1);
}

const v4 = addresses.filter((a) => a.family === 4);
const v6 = addresses.filter((a) => a.family === 6);
console.log(`DNS: ${v4.length} IPv4, ${v6.length} IPv6 record(s)`);

let anyReachable = false;
for (const { address, family } of addresses) {
  const res = await tcpProbe(family, address);
  anyReachable = anyReachable || res.ok;
  console.log(
    `  [IPv${family}] ${address}: ${res.ok ? `TCP OK (${res.ms}ms)` : `FAILED (${res.error}, ${res.ms}ms)`}`,
  );
}

if (v4.length === 0) {
  console.log("\nNote: host is IPv6-only. Networks without working IPv6 will hang here.");
  console.log("Use the Supabase connection pooler (IPv4) instead — see dashboard → Connect.");
}

console.log("\nPostgres handshake…");
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 8000 });
try {
  const { rows } = await pool.query("select current_database() as db, current_user as usr");
  console.log(`  OK: db=${rows[0].db} user=${rows[0].usr}`);
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  process.exit(1);
} finally {
  await pool.end();
}

if (!anyReachable) process.exit(1);
