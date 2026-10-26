// Offline unit tests against a local mock x402 server. No network, no real funds: a throwaway random key signs
// authorizations for the mock only; nothing is ever broadcast.
import http from "node:http";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
const USDC_SEP = "0x036CbD53842c5426634e7929541eC2318f3dCF7e", OLD_RESEARCH = "0xacfca8bc6567e7db35ad8c814756695dad1cfb30", TREASURY = "0xa26f179e42836bc4ae0cea997fdfc9602d5b8147";
const base = () => ({ scheme: "exact", network: "eip155:84532", amount: "3000", asset: USDC_SEP, payTo: TREASURY, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } });
let offer = base(), lastSig = null;
const srv = http.createServer((q, r) => {
  lastSig = q.headers["payment-signature"] || null;
  if (lastSig) { r.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from('{"success":true}').toString("base64") }); return r.end('{"ok":1}'); }
  r.writeHead(402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "x" }, accepts: [offer] })).toString("base64") }); r.end("{}");
}).listen(0);
await new Promise((ok) => srv.on("listening", ok));
const KEY = generatePrivateKey();
for (const k of ["X402_NETWORK", "X402_PREVIEW", "X402_SESSION_CAP_USDC", "X402_MAX_PRICE_USDC"]) delete process.env[k];
Object.assign(process.env, { X402_RESEARCH_URL: `http://127.0.0.1:${srv.address().port}`, X402_BUYER_PRIVATE_KEY: KEY });
const m = await import("./server.mjs");
let n = 0;
const t = async (name, fn) => { offer = base(); lastSig = null; m._resetSession(); await fn(); n++; console.log("PASS", name); };

await t("Sepolia is the default network", async () => { assert.equal(m.NETWORK, "eip155:84532"); assert.equal(m.MAINNET, false); assert.equal(m.SESSION_CAP, 500000); assert.equal(m.MAX_PRICE, 100000); });
await t("happy path pays and counts spend", async () => { const r = await m.callPaid("signal", "/s"); assert.ok(r.paid); assert.ok(lastSig); assert.equal(m.session().spentUSDC, 0.003); });
await t("preview:true does not sign", async () => { const r = await m.callPaid("signal", "/s", { preview: true }); assert.ok(r.preview); assert.equal(r.paid, false); assert.equal(lastSig, null); });
await t("refuse non-exact scheme", async () => { offer.scheme = "upto"; const r = await m.callPaid("signal", "/s"); assert.equal(r.refused, "nonExactScheme"); assert.equal(lastSig, null); });
await t("refuse non-canonical asset", async () => { offer.asset = "0x1111111111111111111111111111111111111111"; const r = await m.callPaid("signal", "/s"); assert.equal(r.refused, "nonCanonicalAsset"); assert.equal(lastSig, null); });
await t("refuse wrong network (mainnet offer on Sepolia default)", async () => { offer.network = "eip155:8453"; const r = await m.callPaid("signal", "/s"); assert.equal(r.refused, "wrongNetwork"); assert.equal(lastSig, null); });
await t("refuse price above advertised", async () => { offer.amount = "3001"; const r = await m.callPaid("signal", "/s"); assert.match(r.refused, /advertised/); assert.equal(lastSig, null); });
await t("refuse over 0.10 per call (default X402_MAX_PRICE_USDC)", async () => { const orig = m.ROUTES.risk_snapshot.price; m.ROUTES.risk_snapshot.price = 200000; // isolate the per-call check from the advertised-price check
  try { offer.payTo = TREASURY; offer.amount = "110000"; const r = await m.callPaid("risk_snapshot", "/r"); assert.match(r.refused, /per-call max 0.1 USDC/); assert.equal(lastSig, null); } finally { m.ROUTES.risk_snapshot.price = orig; } });
await t("max_price_usdc arg can lower but not raise the per-call max", async () => { offer.payTo = TREASURY; offer.amount = "50000"; let r = await m.callPaid("preflight", "/p", { max_price_usdc: 0.04 }); assert.match(r.refused, /per-call max/); assert.equal(lastSig, null);
  r = await m.callPaid("preflight", "/p", { max_price_usdc: 5 }); assert.ok(r.paid, "arg cannot raise the default; 0.05 is under 0.10"); });
await t("preflight: advertised 0.05, treasury only, refuses 0.050001", async () => { assert.equal(m.ROUTES.preflight.price, 50000); assert.equal(m.PAYTO.preflight, TREASURY);
  offer.payTo = TREASURY; offer.amount = "50001"; const r = await m.callPaid("preflight", "/p"); assert.match(r.refused, /advertised/); assert.equal(lastSig, null);
  offer.amount = "50000"; offer.payTo = OLD_RESEARCH; assert.equal((await m.callPaid("preflight", "/p")).refused, "payToNotAllowlisted"); });
await t("preflight respects a lower X402_MAX_PRICE_USDC-style cap via arg", async () => { offer.payTo = TREASURY; offer.amount = "50000"; const r = await m.callPaid("preflight", "/p", { max_price_usdc: 0.049 }); assert.match(r.refused, /per-call max/); assert.equal(lastSig, null); });
await t("advertised prices: brief/risk_snapshot/approval_enumerate 0.03", async () => { for (const k of ["brief", "risk_snapshot", "approval_enumerate"]) assert.equal(m.ROUTES[k].price, 30000); });
await t("refuse over 0.50 session cap", async () => { offer.payTo = TREASURY; offer.amount = "50000";
  for (let i = 0; i < 10; i++) assert.ok((await m.callPaid("preflight", "/p")).paid);
  lastSig = null; const r = await m.callPaid("preflight", "/p"); assert.match(r.refused, /session cap/); assert.equal(lastSig, null); assert.equal(m.session().spentUSDC, 0.5); });
await t("payTo allowlist: every tool accepts ONLY the treasury; old research address and others refused", async () => {
  const TOOLS = { signal: 3000, signal_batch: 20000, brief: 30000, risk_snapshot: 30000, invoice_decode: 20000, settlement_status: 20000, approval_enumerate: 30000, preflight: 50000 };
  assert.deepEqual(Object.keys(m.PAYTO).sort(), Object.keys(TOOLS).sort());
  for (const [k, v] of Object.entries(m.PAYTO)) assert.equal(v, TREASURY, k);
  for (const [tool, amt] of Object.entries(TOOLS)) {
    for (const bad of [OLD_RESEARCH, "0x000000000000000000000000000000000000dEaD"]) {
      m._resetSession(); lastSig = null; offer = { ...base(), amount: String(amt), payTo: bad };
      const r = await m.callPaid(tool, "/x"); assert.equal(r.refused, "payToNotAllowlisted", `${tool} ${bad}`); assert.equal(lastSig, null, `${tool} signed for ${bad}`);
    }
    m._resetSession(); offer = { ...base(), amount: String(amt), payTo: TREASURY.toUpperCase().replace("0X", "0x") };
    assert.ok((await m.callPaid(tool, "/x")).paid, `${tool} should pay the treasury`);
  }
  m._resetSession(); offer = base(); });
await t("no payment_signature passthrough in server", async () => { assert.ok(!/payment_signature/.test(readFileSync(new URL("./server.mjs", import.meta.url), "utf8"))); });
srv.close();
console.log(`offline unit tests PASS (${n})`);
