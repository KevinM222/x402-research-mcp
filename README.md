# x402-research-mcp

MCP (stdio) server for the [x402-research](https://x402-research-iota.vercel.app) pay-per-call API.
**Testnet (Base Sepolia) by default. Base mainnet only if you explicitly set `X402_NETWORK=eip155:8453`.**
The publisher never holds keys: payments come from *your* wallet key, supplied by you via env var, and are
capped per call and per session.

> [!WARNING]
> **Use a dedicated, low-balance wallet: never your main wallet.** Create a fresh key just for this server and fund it
> with only a few USDC (on mainnet, a little more than your session cap). Anyone or anything that can read your MCP
> client config or this process's environment can spend that wallet's funds. The caps limit what this server signs, not
> what a leaked key can do.

> **New:** [Preflight before you sign](docs/preflight-before-you-sign.md): one paid call (`/api/x402/preflight`, 0.05 USDC) that checks a Base address's risk, approvals and OFAC status (plus an optional x402 invoice) and returns a `proceed` / `review` / `stop` verdict.

## Tools (prices per call, USDC on Base, from /llms.txt)
| tool | route | price |
|---|---|---|
| `signal(asset)` | `GET /api/signal/{asset}` | 0.003 |
| `signal_batch(assets[≤10])` | `GET /api/signal-batch?assets=` | 0.02 |
| `brief(asset)` | `GET /api/brief/{asset}` | 0.03 |
| `risk_snapshot(address)` | `GET /api/firm/risk-snapshot?address=` | 0.03 |
| `invoice_decode(header)` | `POST /api/x402/invoice-decode` | 0.02 |
| `settlement_status(tx)` | `GET /api/x402/settlement-status?tx=` | 0.02 |
| `approval_enumerate(address)` | `GET /api/x402/approval-enumerate?address=` | 0.03 |
| `preflight(address, invoice?)` | `GET /api/x402/preflight?address=[&invoice=]` | 0.05 |
| `session_status()` | local | free |

Assets: btc eth sol xrp doge ada avax link dot ltc bch uni aave xlm hbar shib sui near atom fil.
Every paid tool also accepts `preview: true` (return the 402 terms, pay nothing) and `max_price_usdc`.

## Safety
- **Preview mode** is on whenever `X402_BUYER_PRIVATE_KEY` is unset or `X402_PREVIEW=1`: tools return the decoded 402 terms and never sign.
- **Per-call max** `X402_MAX_PRICE_USDC` (default 0.10). A tool's `max_price_usdc` can only lower it.
- **Session cap** `X402_SESSION_CAP_USDC` (default 0.50). A call that would push spend over the cap is refused before signing. Spend is counted when a signed payment is sent. It resets when the server process restarts.
- Offers are refused if they're above the advertised price, on another network, not the `exact` scheme, or in a non-canonical USDC asset.
- **payTo allowlist (hardcoded):** signal, signal_batch and brief pay only `0xacfca8bc6567e7db35ad8c814756695dad1cfb30`. risk_snapshot, invoice_decode, settlement_status, approval_enumerate and preflight pay only `0xa26f179e42836bc4ae0cea997fdfc9602d5b8147`. Any other recipient is refused, even if `X402_RESEARCH_URL` points elsewhere.
- The server never logs its environment or the key, and error messages don't echo config.
- There is no way to pass in a pre-signed payment: every payment is signed by this server under the caps above.
- Use a dedicated hot wallet holding only a few USDC. The key stays in the local process and is never logged or returned.

## Config
| var | default |
|---|---|
| `X402_NETWORK` | `eip155:84532` (Base Sepolia). Set `eip155:8453` for Base mainnet |
| `X402_RESEARCH_URL` | `https://x402-research-iota.vercel.app` (mainnet-only; testnet needs a Sepolia deployment) |
| `X402_BUYER_PRIVATE_KEY` | unset → preview only |
| `X402_MAX_PRICE_USDC` / `X402_SESSION_CAP_USDC` | `0.10` / `0.50` |
| `X402_PREVIEW` | unset (`1` forces preview) |

## Install
Claude Desktop (`claude_desktop_config.json`) or Cursor (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "x402-research": {
      "command": "npx",
      "args": ["-y", "@agentfirm402/x402-research-mcp"],
      "env": {
        "X402_NETWORK": "eip155:8453",
        "X402_PREVIEW": "1"
      }
    }
  }
}
```
Start in preview. To pay, remove `X402_PREVIEW` and add `"X402_BUYER_PRIVATE_KEY": "0x…"` (a **dedicated low-balance** wallet, never your main one),
and optionally `"X402_SESSION_CAP_USDC": "0.25"`.

## Tests
`npm test` runs offline against local mocks with throwaway keys and no funds. It covers unit refusals for each check, preview with no key, and a stdio leak test that greps all stdout and stderr for `/0x[0-9a-fA-F]{64}/`.
`npm run test:mainnet-preview` makes live mainnet 402 calls in preview mode and pays nothing.

## Release
Dependencies are pinned exactly, with a committed lockfile. Publishing happens only through `.github/workflows/mcp-publish.yml` (manual dispatch, `npm publish --provenance`).

Informational only. Not financial advice. MIT.
