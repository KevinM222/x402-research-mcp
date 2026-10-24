// Live mainnet PREVIEW smoke: spawns the server over stdio with X402_NETWORK=eip155:8453, NO key and X402_PREVIEW=1.
// Each paid tool must return the 402 terms with paid:false. Nothing is signed or paid.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const env = { ...process.env, X402_NETWORK: "eip155:8453", X402_PREVIEW: "1", X402_RESEARCH_URL: "https://x402-research-iota.vercel.app" };
delete env.X402_BUYER_PRIVATE_KEY;
const c = new Client({ name: "preview", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"], env }));
const tools = (await c.listTools()).tools;
for (const t of tools) console.log(`tool ${t.name}: ${t.description}`);
const hdr = (await fetch("https://x402-research-iota.vercel.app/api/signal/btc")).headers.get("payment-required"); // a real 402 header
const calls = [["signal", { asset: "eth" }], ["signal_batch", { assets: ["btc", "eth", "sol"] }], ["brief", { asset: "btc" }],
  ["risk_snapshot", { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }], ["invoice_decode", { header: hdr }],
  ["settlement_status", { tx: "0x6db0873a0a6de25a5792d465378251d7b3fe74b55761a1ac1b9f6489bb0509f3" }],
  ["approval_enumerate", { address: "0xf9623fab6780984eacac443158c0309519451afa" }]];
let ok = true;
for (const [name, args] of calls) {
  const r = JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
  const pass = r.status === 402 && r.paid === false && r.preview === true && r.terms?.network === "eip155:8453";
  ok &&= pass;
  console.log(`${name}: status ${r.status} paid=${r.paid} ${r.terms?.amountUSDC} USDC (advertised ${r.terms?.advertisedUSDC}) payTo ${r.terms?.payTo} ${pass ? "PASS" : "FAIL " + JSON.stringify(r).slice(0, 300)}`);
}
console.log("session:", (await c.callTool({ name: "session_status", arguments: {} })).content[0].text.replace(/\s+/g, " "));
await c.close(); process.exit(ok ? 0 : 1);
