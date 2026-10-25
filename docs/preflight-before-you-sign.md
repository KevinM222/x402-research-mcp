# Preflight before you sign

`GET /api/x402/preflight` is a single paid x402 call an agent can make **before** it signs, swaps, approves, or pays
on Base (chain 8453). It bundles four public-data checks into one response with a `summary.verdict` of
`proceed`, `review` or `stop`.

> Informational heuristics only. Not a security audit, not a compliance determination, not financial advice.
> **`proceed` does not mean safe.**

## The route

| | |
|---|---|
| URL | `https://x402-research-iota.vercel.app/api/x402/preflight?address=0x…[&invoice=…]` |
| Price | 0.05 USDC (`50000` base units), scheme `exact`, network `eip155:8453` |
| Asset | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| payTo | `0xa26f179e42836bc4ae0cea997fdfc9602d5b8147` |
| Free example | [`/api/preflight/sample`](https://x402-research-iota.vercel.app/api/preflight/sample) (static, labeled example, not live data) |

Parameters:
- `address` (required): the Base address you are about to interact with (counterparty, spender, contract or recipient).
- `invoice` (optional): an x402 `PAYMENT-REQUIRED` header you were asked to pay, as base64 or JSON. Preflight decodes
  and sanity-checks it (scheme, network, canonical USDC, payTo, amount).

What's checked:
1. **Risk snapshot:** EOA vs contract, EIP-7702 delegation, source verification, upgradeable proxy, age, activity, ETH/USDC balance.
2. **ERC-20 approvals:** live allowances granted by the address, flagging unlimited ones.
3. **OFAC SDN screen:** exact-address match against the SDN digital-currency list.
4. **Invoice check** (only if `invoice` is passed).

Status codes:

| status | meaning | charged? |
|---|---|---|
| 402 | payment required (read terms from the `PAYMENT-REQUIRED` header) | no |
| 200 | result, with a `PAYMENT-RESPONSE` settlement receipt header | yes |
| 400 | bad input (e.g. malformed address) | no |
| 503 | an upstream source failed or the 60s deadline passed | **no**: payment is not settled |

Payment is settled only after a successful response, so a 400/503 never costs anything.

## Calling it from TypeScript (`@x402/fetch`)

```bash
npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
```

The example probes the 402 first and refuses unexpected terms before anything is signed. Use a **dedicated,
low-balance** wallet key.

```ts
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "https://x402-research-iota.vercel.app";
const EXPECTED = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  payTo: "0xa26f179e42836bc4ae0cea997fdfc9602d5b8147",
  maxAmount: 50_000n, // 0.05 USDC (6 decimals)
};

// Dedicated low-balance hot wallet only. Never your main wallet.
const signer = privateKeyToAccount(process.env.X402_BUYER_PRIVATE_KEY as `0x${string}`);
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

export async function preflight(address: string, invoice?: string) {
  const url = new URL("/api/x402/preflight", BASE);
  url.searchParams.set("address", address);
  if (invoice) url.searchParams.set("invoice", invoice); // the 402 PAYMENT-REQUIRED header (base64) or its JSON

  // 1) Unpaid probe: read the 402 terms and refuse anything unexpected before signing.
  const probe = await fetch(url);
  if (probe.status === 400) throw new Error(`bad input: ${await probe.text()}`); // not charged
  if (probe.status !== 402) throw new Error(`expected 402, got ${probe.status}`);
  const terms = JSON.parse(Buffer.from(probe.headers.get("payment-required")!, "base64").toString("utf8"));
  const offer = terms.accepts?.[0];
  if (!offer || offer.network !== EXPECTED.network || offer.asset.toLowerCase() !== EXPECTED.asset.toLowerCase()
      || offer.payTo.toLowerCase() !== EXPECTED.payTo || BigInt(offer.amount) > EXPECTED.maxAmount) {
    throw new Error("unexpected payment terms; refusing to pay");
  }

  // 2) Paid call. The wrapper signs an EIP-3009 USDC authorization and retries with the payment header.
  const res = await fetchWithPayment(url);
  if (res.status === 503) throw new Error("upstream unavailable; payment NOT settled (not charged); retry later");
  if (!res.ok) throw new Error(`preflight failed: HTTP ${res.status}`);
  const receipt = res.headers.get("payment-response");
  const settlement = receipt ? decodePaymentResponseHeader(receipt) : null; // { success, transaction, network, payer }
  return { result: await res.json(), settlement };
}

const out = await preflight("0xf9623fab6780984eacac443158c0309519451afa");
switch (out.result.summary.verdict) {
  case "stop": /* do not sign */ break;
  case "review": /* ask a human or gather more data */ break;
  case "proceed": /* no flags found; still not a safety guarantee */ break;
}
```

## Calling it from the MCP server

`@agentfirm402/x402-research-mcp` 0.4.1 does **not** have a single `preflight` tool yet. Until it does, an agent can
cover most of the bundle with two tools (no OFAC screen or invoice check, and two charges instead of one):

```text
risk_snapshot({ address: "0x…" })        # contract/EOA, 7702, proxy, verification, age, balances
approval_enumerate({ address: "0x…" })   # live ERC-20 allowances, unlimited flag
invoice_decode({ header: "<base64 PAYMENT-REQUIRED>" })   # optional, for an invoice you were sent
```

Pass `preview: true` on any tool to see the decoded 402 terms without paying. With no `X402_BUYER_PRIVATE_KEY` set,
the server is always in preview. Spending is capped per call (`X402_MAX_PRICE_USDC`, default 0.10) and per session
(`X402_SESSION_CAP_USDC`, default 0.50). For the full bundle with a verdict, call `/api/x402/preflight` directly as
shown above. See the [README](../README.md) for install and config.

## Example response

This is the free [`/api/preflight/sample`](https://x402-research-iota.vercel.app/api/preflight/sample): **static,
illustrative data**, with the same shape as the paid response (the paid one has no `sample`, `notice` or `paidRoute` fields).

```json
{
  "sample": true,
  "notice": "EXAMPLE ONLY - static illustrative data, not a live result for this address. Buy GET /api/x402/preflight?address=0x... (0.05 USDC, Base) for live data.",
  "paidRoute": "/api/x402/preflight?address=0xf9623fab6780984eacac443158c0309519451afa",
  "signed": false,
  "address": "0xf9623fab6780984eacac443158c0309519451afa",
  "chainId": 8453,
  "risk": {
    "accountType": "eoa",
    "isContract": false,
    "eip7702DelegatedTo": null,
    "sentTxCount": 412,
    "ageDays": 690,
    "balances": {
      "eth": 0.0213,
      "usdc": 18.4
    },
    "flags": [],
    "riskLevel": "low",
    "disclaimer": "Informational public-data heuristics only. Not financial advice, not a security audit."
  },
  "approvals": {
    "status": "ok",
    "complete": true,
    "highRiskCount": 1,
    "reason": null,
    "approvals": [
      {
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "symbol": "USDC",
        "decimals": 6,
        "spender": "0x111111125421ca6dc452d289314280a0f8842a65",
        "allowance": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        "allowanceFormatted": "unlimited",
        "unlimited": true,
        "risk": "high"
      }
    ],
    "coverageNote": "ERC-20 allowances only: Permit2 sub-allowances and NFT operator approvals (setApprovalForAll) are not covered. \"none\" does not mean the wallet is safe."
  },
  "invoice": null,
  "sanctions": {
    "status": "clear",
    "listed": false,
    "source": "OFAC SDN digital-currency addresses (ETH/EVM) via github.com/0xB10C/ofac-sanctioned-digital-currency-addresses",
    "note": "Exact-address match against the OFAC SDN list only; \"clear\" is not a compliance determination."
  },
  "summary": {
    "verdict": "stop",
    "verdictNote": "Informational heuristic only, not a guarantee, audit or compliance determination. stop = any high flag or OFAC match; review = medium/low flags, unknown/incomplete data, or a requested invoice check that did not complete; proceed = all checks complete with no low/medium/high flags (info-only flags allowed). \"proceed\" does not mean safe.",
    "sanctionsStatus": "clear",
    "flags": [
      {
        "source": "approvals",
        "level": "high",
        "code": "unlimited_approval",
        "detail": "Unlimited USDC allowance to spender 0x111111125421ca6dc452d289314280a0f8842a65."
      }
    ],
    "highRiskCount": 1,
    "riskLevel": "low",
    "approvalsStatus": "ok",
    "invoiceVerdict": null,
    "coverageNote": "Public-data heuristics only. Risk: Base RPC + Sourcify/Blockscout. ERC-20 allowances only: Permit2 sub-allowances and NFT operator approvals (setApprovalForAll) are not covered. \"none\" does not mean the wallet is safe. An empty flag list or approvals status \"none\" never means the address or wallet is safe. Not financial advice, not a security audit."
  },
  "disclaimer": "Informational public-data heuristics only. Not financial advice, not a security audit."
}
```

## Verdict semantics

`summary.verdict` is derived only from the flags in the response:

| verdict | rule | suggested agent behavior |
|---|---|---|
| `stop` | any **high** flag (e.g. unlimited approval, high-risk contract signal) **or** an OFAC match | don't sign; surface `summary.flags` to a human |
| `review` | medium/low flags, **or** any check unknown/incomplete (e.g. approvals `status: "unknown"`), **or** a requested invoice check that didn't complete | pause; get human confirmation or more data |
| `proceed` | every check completed and no low/medium/high flags (info-only flags allowed) | you may continue, **but this is not a safety guarantee** |

Why `proceed` isn't "safe":
- Approvals cover **ERC-20 allowances only**. Permit2 sub-allowances and NFT operator approvals (`setApprovalForAll`)
  aren't checked, so `approvals.status: "none"` doesn't mean the wallet is clean.
- The sanctions screen is an **exact-address** OFAC SDN match. `clear` isn't a compliance determination.
- Risk signals are public-data heuristics (Base RPC, Sourcify/Blockscout). A new malicious contract can look clean.
- Results are a point-in-time read; state can change after the call.

Always read `summary.flags[]` (`source`, `level`, `code`, `detail`) and `summary.coverageNote`, not just the verdict.
