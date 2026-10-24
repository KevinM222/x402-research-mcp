#!/usr/bin/env node
// x402-research MCP server. We (the publisher) never hold keys. The BUYER may supply their own wallet key via
// X402_BUYER_PRIVATE_KEY; it is read only in signPayment(), kept in process memory, never logged or returned.
// Without a key, tools only return the 402 terms (preview). Every payment goes through the cap checks below.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const VERSION = "0.4.0";
const env = process.env;
// Network: Base Sepolia unless the user EXPLICITLY sets X402_NETWORK=eip155:8453.
export const NETWORK = env.X402_NETWORK || "eip155:84532";
const USDC = { "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e" };
if (!USDC[NETWORK]) { process.stderr.write("x402-research-mcp: unsupported X402_NETWORK (use eip155:84532 or eip155:8453)\n"); process.exit(1); }
export const MAINNET = NETWORK === "eip155:8453";
export const BASE = (env.X402_RESEARCH_URL || "https://x402-research-iota.vercel.app").replace(/\/$/, "");
const usdc = (v, d) => { const n = Number(v ?? d); if (!Number.isFinite(n) || n < 0) throw new Error("invalid USDC amount setting"); return Math.round(n * 1e6); };
export const SESSION_CAP = usdc(env.X402_SESSION_CAP_USDC, 0.5);   // base units, default 0.50 USDC
export const MAX_PRICE = usdc(env.X402_MAX_PRICE_USDC, 0.1);       // per-call ceiling, default 0.10 USDC
export const PREVIEW = /^(1|true|yes)$/i.test(env.X402_PREVIEW || "") || !env.X402_BUYER_PRIVATE_KEY;
let spent = 0; // base units committed this session (counted once a signed payment is sent, whatever the outcome)
export const session = () => ({ network: NETWORK, mainnet: MAINNET, preview: PREVIEW, spentUSDC: spent / 1e6, capUSDC: SESSION_CAP / 1e6, remainingUSDC: (SESSION_CAP - spent) / 1e6, maxPriceUSDC: MAX_PRICE / 1e6 });
export const _resetSession = () => { spent = 0; };

// Hardcoded payTo allowlist per tool. Signing is refused for any other recipient, even if X402_RESEARCH_URL is overridden.
const TREASURY = "0xa26f179e42836bc4ae0cea997fdfc9602d5b8147", RESEARCH = "0xacfca8bc6567e7db35ad8c814756695dad1cfb30";
export const PAYTO = { signal: RESEARCH, signal_batch: RESEARCH, brief: RESEARCH,
  risk_snapshot: TREASURY, invoice_decode: TREASURY, settlement_status: TREASURY, approval_enumerate: TREASURY };

// Advertised prices (from /llms.txt, base units of USDC). An offer above the advertised price is refused.
export const ROUTES = {
  signal:             { price: 3000,   desc: "Compact live trend signal (bullish/neutral/bearish + score) for one asset." },
  signal_batch:       { price: 20000,  desc: "Live trend signals for up to 10 assets in one call (flat price)." },
  brief:              { price: 50000,  desc: "Technical + sentiment research brief (price, 24h/7d change, RSI14, SMA20/50, trend, Fear & Greed)." },
  risk_snapshot:      { price: 100000, desc: "Public-data red-flag snapshot of a Base address (contract/EOA, EIP-7702, verification, proxy, age, balances, risk level). Informational only." },
  invoice_decode:     { price: 20000,  desc: "Decode and sanity-check a base64 x402 PAYMENT-REQUIRED header (scheme, network, USDC asset, payTo, amount); verdict ok/warn/fail. Never signs or pays." },
  settlement_status:  { price: 20000,  desc: "Check an x402 settlement tx on Base: success, USDC Transfer / AuthorizationUsed events, confirmations." },
  approval_enumerate: { price: 100000, desc: "List live ERC-20 approvals for a Base address (token, spender, allowance, unlimited flag). 503 when the indexer is down (not charged)." },
};

const b64 = (h) => { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } };
let client = null;
async function signPayment(paymentRequired) {
  if (!client) {
    const key = env.X402_BUYER_PRIVATE_KEY;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) throw new Error("malformed key");
    const [{ x402Client }, { registerExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
      import("@x402/core/client"), import("@x402/evm/exact/client"), import("viem/accounts")]);
    client = registerExactEvmScheme(new x402Client(), { signer: privateKeyToAccount(key) });
  }
  const { encodePaymentSignatureHeader } = await import("@x402/core/http");
  return encodePaymentSignatureHeader(await client.createPaymentPayload(paymentRequired));
}

export async function callPaid(tool, path, { preview, max_price_usdc, init } = {}) {
  const r0 = ROUTES[tool];
  const url = BASE + path;
  const req = (extra = {}) => fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers || {}), ...extra } });
  const parse = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };
  let res = await req();
  if (res.status !== 402) return { status: res.status, body: await parse(res), note: "No payment was requested (validation error or free response)." };
  const pr = b64(res.headers.get("payment-required") || "");
  const all = Array.isArray(pr?.accepts) ? pr.accepts : [];
  const onNet = all.filter((a) => a?.network === NETWORK);
  if (!onNet.length) return { status: 409, paid: false, refused: "wrongNetwork", expectedNetwork: NETWORK, offeredNetworks: all.map((a) => a?.network),
    error: "No offer on the configured network. Base mainnet requires explicitly setting X402_NETWORK=eip155:8453." };
  const offer = onNet.find((a) => a.scheme === "exact") ;
  if (!offer) return { status: 409, paid: false, refused: "nonExactScheme", offeredSchemes: onNet.map((a) => a?.scheme) };
  if (String(offer.asset).toLowerCase() !== USDC[NETWORK]) return { status: 409, paid: false, refused: "nonCanonicalAsset", offeredAsset: offer.asset };
  if (String(offer.payTo).toLowerCase() !== PAYTO[tool]) return { status: 409, paid: false, refused: "payToNotAllowlisted", offeredPayTo: offer.payTo, allowedPayTo: PAYTO[tool] };
  const amount = Number(offer.amount);
  const maxPrice = Math.min(MAX_PRICE, max_price_usdc != null ? usdc(max_price_usdc) : Infinity);
  const terms = { url, network: NETWORK, amountUSDC: amount / 1e6, amount: offer.amount, asset: offer.asset, payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds, advertisedUSDC: r0.price / 1e6, resource: pr.resource, session: session() };
  const refuse = (why) => ({ status: 402, paid: false, refused: why, terms });
  if (!Number.isSafeInteger(amount) || amount <= 0) return refuse("invalidAmount");
  if (amount > r0.price) return refuse(`offer ${amount / 1e6} USDC exceeds advertised ${r0.price / 1e6} USDC`);
  if (amount > maxPrice) return refuse(`offer ${amount / 1e6} USDC exceeds per-call max ${maxPrice / 1e6} USDC`);
  if (spent + amount > SESSION_CAP) return refuse(`would exceed session cap (${spent / 1e6} spent + ${amount / 1e6} > ${SESSION_CAP / 1e6} USDC)`);
  if (PREVIEW || preview) return { status: 402, paid: false, preview: true, terms,
    note: PREVIEW ? "Preview mode (no X402_BUYER_PRIVATE_KEY or X402_PREVIEW=1): nothing was signed or paid." : "preview=true: nothing was signed or paid." };
  let header;
  try { header = await signPayment({ ...pr, accepts: [offer] }); }
  catch { return { status: 500, paid: false, refused: "signingFailed", error: "Could not sign the payment (check that X402_BUYER_PRIVATE_KEY is a 0x-prefixed 32-byte hex key). Nothing was paid." }; }
  spent += amount; // committed before sending: a signed authorization may settle even if the response fails
  res = await req({ "PAYMENT-SIGNATURE": header });
  const s = res.headers.get("payment-response");
  return { status: res.status, paid: res.ok, body: await parse(res), ...(s ? { paymentResponse: b64(s) } : {}), session: session() };
}

const ASSETS = ["btc","eth","sol","xrp","doge","ada","avax","link","dot","ltc","bch","uni","aave","xlm","hbar","shib","sui","near","atom","fil"];
const asset = z.enum(ASSETS);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Base (8453) address, 0x + 40 hex");
const common = {
  preview: z.boolean().optional().describe("true = return the 402 terms without paying"),
  max_price_usdc: z.number().nonnegative().optional().describe("Refuse if the offer exceeds this (can only lower X402_MAX_PRICE_USDC)"),
};
const out = (r) => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: r.status >= 400 && r.status !== 402 });
const q = encodeURIComponent;

export const server = new McpServer({ name: "x402-research", version: VERSION });
const tool = (name, shape, path, method) => server.tool(name,
  `${ROUTES[name].desc} Price: ${ROUTES[name].price / 1e6} USDC per call (x402, ${MAINNET ? "Base mainnet" : "Base Sepolia testnet"}). Paid from YOUR wallet; capped per call and per session.`,
  { ...shape, ...common }, async (a) => { try { return out(await callPaid(name, path(a), { preview: a.preview, max_price_usdc: a.max_price_usdc, ...(method ? { init: method(a) } : {}) })); }
    catch { return out({ status: 502, paid: false, error: "Request failed (upstream unreachable or invalid input). Nothing was paid." }); } });
tool("signal", { asset }, (a) => `/api/signal/${a.asset}`);
tool("signal_batch", { assets: z.array(asset).min(1).max(10) }, (a) => `/api/signal-batch?assets=${a.assets.join(",")}`);
tool("brief", { asset }, (a) => `/api/brief/${a.asset}`);
tool("risk_snapshot", { address: addr }, (a) => `/api/firm/risk-snapshot?address=${a.address}`);
tool("invoice_decode", { header: z.string().min(8).max(16384).describe("base64 PAYMENT-REQUIRED header") }, () => `/api/x402/invoice-decode`,
  (a) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ header: a.header }) }));
tool("settlement_status", { tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }, (a) => `/api/x402/settlement-status?tx=${q(a.tx)}`);
tool("approval_enumerate", { address: addr }, (a) => `/api/x402/approval-enumerate?address=${a.address}`);
server.tool("session_status", "Free. Shows network, preview mode, USDC spent this session, cap and per-call max.", {}, async () => out({ status: 200, ...session() }));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("x402-research-mcp")) await server.connect(new StdioServerTransport());
