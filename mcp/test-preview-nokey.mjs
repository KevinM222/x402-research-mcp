// Preview with no key: separate process so env is clean. Must not sign even when the offer is valid.
import http from "node:http"; import assert from "node:assert";
let sig = null;
const offer = { scheme: "exact", network: "eip155:84532", amount: "3000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0xa26f179e42836bc4ae0cea997fdfc9602d5b8147", maxTimeoutSeconds: 60 };
const srv = http.createServer((q, r) => { sig = q.headers["payment-signature"] || sig; r.writeHead(402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [offer] })).toString("base64") }); r.end(); }).listen(0);
await new Promise((ok) => srv.on("listening", ok));
for (const k of ["X402_NETWORK", "X402_PREVIEW", "X402_BUYER_PRIVATE_KEY"]) delete process.env[k];
process.env.X402_RESEARCH_URL = `http://127.0.0.1:${srv.address().port}`;
const m = await import("./server.mjs");
assert.equal(m.PREVIEW, true); assert.equal(m.NETWORK, "eip155:84532");
const r = await m.callPaid("signal", "/s"); assert.equal(r.preview, true); assert.equal(r.paid, false); assert.equal(sig, null);
srv.close(); console.log("PASS preview with no key (Sepolia default, nothing signed)");
