# Nadcab Aggregator DEX

A 1inch-style DEX aggregator that Nadcab Console deploys for customers. One site serves several networks; each
network has its own `NadcabAggregationRouter` contract, deployed from the customer's wallet.

## How a swap works

1. The site asks the server for a quote (`/api/quote`).
2. The server's routing engine finds pools on every enabled liquidity source, searches direct, two-hop and three-hop
   paths through connector tokens, and splits the trade across up to five non-overlapping paths in 10% steps. It
   weighs each extra path against its gas cost, and never returns less than the best single path.
3. The wallet sends `swap(params, paths)` to the router. The router pulls the input once, runs every path, checks the
   total against the trader's minimum, takes the partner fee and a share of any positive slippage for the fee
   recipient, and sends the rest to the trader.

Quotes come from the router itself (`quote(paths, amounts)`), which simulates V2 math, Solidly `getAmountOut` and
concentrated-liquidity swaps that revert inside the callback. Before a router is deployed on a network, the server
places the router's code at a fixed address with an `eth_call` state override, so quotes work from day one.

## Liquidity sources

| Kind | Discovery | Examples |
| --- | --- | --- |
| `v2` | `getPair` with a fixed fee | Uniswap V2, SushiSwap, PancakeSwap V2, QuickSwap, Trader Joe V1 |
| `v2-dynamic` | `getPair`, priced with the pair's `getAmountOut` | Camelot V2 |
| `solidly` | `getPool(a, b, stable)` | Aerodrome, Velodrome |
| `v3` | `getPool(a, b, fee)` | Uniswap V3, PancakeSwap V3, SushiSwap V3, Nadcab AMM v3 |
| `slipstream` | `getPool(a, b, tickSpacing)` | Aerodrome / Velodrome Slipstream |
| `algebra` | `poolByPair(a, b)` | QuickSwap V3, Camelot V3, Thena Fusion |

`presets/chains.json` lists the tokens and sources for Ethereum, BNB Chain, Polygon, Arbitrum, Base, OP Mainnet and
Avalanche. Any EVM chain works with custom sources, including Nadcab chains running the Nadcab AMM v2/v3 DEX.

## Layout

- `contracts/` – the router (Foundry). `forge test` runs the unit tests against mock V2, Solidly, V3 and Algebra pools.
- `server/` – Fastify API and routing engine (`src/engine`). Settings are pushed by the Console to `/api/admin/settings`.
- `web/` – the swap site (Next.js static export).
- `presets/chains.json` – public-chain presets.

## Checks

- `node server/test/e2e.mjs` – anvil chain with mock DEXes, the bundled server, quotes and on-chain swaps (CI).
- `node server/test/live-quote.mjs [chain…]` – read-only quotes on the live public chains.
- `node server/test/fork-swaps.mjs [chain…]` – forks each chain with anvil and executes swaps through every preset
  source, checking each lands within 0.5% of its quote.

## Server API

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Branding, networks, tokens, sources and live router fees (no private RPC URLs) |
| `GET /api/quote?chainId&tokenIn&tokenOut&amount[&exclude]` | Best split route; `native` for the coin |
| `GET /api/token/:chainId/:address` | ERC-20 metadata |
| `POST /api/rpc/:chainId` | Read-only JSON-RPC relay |
| `GET/PUT /api/admin/settings`, `GET /api/admin/status`, `POST /api/admin/logo` | Console management (`Authorization: Bearer ADMIN_SECRET`) |
