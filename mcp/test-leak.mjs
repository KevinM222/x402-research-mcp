// Leak test: spawns the real server over stdio (raw JSON-RPC), runs every tool through pay, refusal and failure paths,
// and greps ALL captured stdout+stderr for any 32-byte hex (/0x[0-9a-fA-F]{64}/). The only allowed match is the tx hash
// we pass to settlement_status ourselves. Throwaway key + local mock; nothing broadcast.
import http from "node:http"; import { spawn } from "node:child_process"; import assert from "node:assert";
import { generatePrivateKey } from "viem/accounts";
const TX = "0x" + "ab".repeat(32);
const RESEARCH = "0xacfca8bc6567e7db35ad8c814756695dad1cfb30", TREASURY = "0xa26f179e42836bc4ae0cea997fdfc9602d5b8147";
const PRICE = { "/api/signal": 3000, "/api/signal-batch": 20000, "/api/brief": 50000, "/api/firm": 100000, "/api/x402/invoice": 20000, "/api/x402/settlement": 20000, "/api/x402/approval": 100000 };
const srv = http.createServer((q, r) => {
  if (q.headers["payment-signature"]) { r.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from('{"success":true}').toString("base64") }); return r.end('{"ok":1}'); }
  const p = Object.keys(PRICE).find((k) => q.url.startsWith(k));
  const payTo = /signal|brief/.test(q.url) ? RESEARCH : TREASURY;
  r.writeHead(402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:84532", amount: String(PRICE[p]), asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }] })).toString("base64") }); r.end();
}).listen(0);
await new Promise((ok) => srv.on("listening", ok));
const URL_OK = `http://127.0.0.1:${srv.address().port}`;
const calls = [["signal", { asset: "eth" }], ["signal_batch", { assets: ["btc", "eth"] }], ["brief", { asset: "btc" }], ["risk_snapshot", { address: RESEARCH }],
  ["invoice_decode", { header: "eyJ4NDAyVmVyc2lvbiI6Mn0=" }], ["settlement_status", { tx: TX }], ["approval_enumerate", { address: RESEARCH }],
  ["signal", { asset: "eth", preview: true }], ["brief", { asset: "btc", max_price_usdc: 0.001 }], ["risk_snapshot", { address: "bad" }], ["session_status", {}]];
let all = "";
const done = (o) => calls.every((_, i) => o.includes(`"id":${i + 2}}`));
async function run(env, label, expectExit = false) {
  const ch = spawn("node", ["server.mjs"], { env: { PATH: process.env.PATH, ...env } });
  let out = "";
  ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d));
  const send = (id, method, params) => ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  send(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "leak", version: "0" } });
  ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  send(1, "tools/list", {});
  calls.forEach(([name, args], i) => send(i + 2, "tools/call", { name, arguments: args }));
  await new Promise((ok) => { const iv = setInterval(() => { if (done(out) || ch.exitCode !== null) { clearInterval(iv); ok(); } }, 50); setTimeout(ok, 15000); });
  ch.kill(); if (!expectExit) assert.ok(done(out), label + ": missing responses");
  console.log(`ran ${label}: ${out.length} bytes captured`); all += out;
}
await run({ X402_RESEARCH_URL: URL_OK, X402_BUYER_PRIVATE_KEY: generatePrivateKey() }, "pay path (valid key)");
await run({ X402_RESEARCH_URL: URL_OK, X402_BUYER_PRIVATE_KEY: generatePrivateKey(), X402_SESSION_CAP_USDC: "0.01" }, "session-cap refusals");
await run({ X402_RESEARCH_URL: URL_OK, X402_BUYER_PRIVATE_KEY: generatePrivateKey().slice(0, 60) }, "malformed key");
await run({ X402_RESEARCH_URL: "http://127.0.0.1:1", X402_BUYER_PRIVATE_KEY: generatePrivateKey() }, "unreachable upstream");
await run({ X402_RESEARCH_URL: URL_OK, X402_BUYER_PRIVATE_KEY: generatePrivateKey(), X402_NETWORK: "eip155:1" }, "bad network config (exits)", true);
await run({ X402_RESEARCH_URL: URL_OK, X402_BUYER_PRIVATE_KEY: generatePrivateKey(), X402_NETWORK: "eip155:8453" }, "mainnet config vs Sepolia mock (wrongNetwork)");
srv.close(); if (process.env.DEBUG) (await import("node:fs")).writeFileSync("/tmp/leak.out", all);
assert.ok(/\\?"paid\\?": true/.test(all), "pay path must actually have been exercised");
const hits = (all.match(/0x[0-9a-fA-F]{64}/g) || []).filter((h) => h.toLowerCase() !== TX);
assert.deepEqual(hits, [], "32-byte hex found in output: possible key leak");
assert.ok(!/X402_BUYER_PRIVATE_KEY=/.test(all) && !/127\.0\.0\.1:1\b/.test(all), "config echoed in output");
console.log(`PASS leak grep: ${all.length} bytes of stdout+stderr, 0 matches of /0x[0-9a-fA-F]{64}/ besides the supplied tx`);
