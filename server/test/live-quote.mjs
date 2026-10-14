#!/usr/bin/env node
// Quotes a few trades per preset chain against the live networks (read-only) and prints the routes.
// Usage: node test/live-quote.mjs [chainKey...]
import { readFileSync } from "node:fs";
import { formatUnits, parseUnits } from "viem";
import { createPoolIndex } from "../src/engine/pools.js";
import { createRouteFinder } from "../src/engine/route.js";
import { createRpc } from "../src/engine/rpc.js";

const presets = JSON.parse(readFileSync(new URL("../../presets/chains.json", import.meta.url)));
const artifacts = JSON.parse(readFileSync(new URL("../../artifacts/aggregator.json", import.meta.url)));
const runtimeCode = artifacts.contracts.NadcabAggregationRouter.deployedBytecode;
const only = process.argv.slice(2);

for (const chain of presets.chains) {
  if (only.length && !only.includes(chain.key)) continue;
  const rpc = createRpc(process.env[`RPC_${chain.key.toUpperCase()}`] || chain.rpcUrl);
  const network = {
    wrappedNative: chain.wrappedNative,
    connectors: chain.tokens.filter((t) => t.connector).map((t) => t.address),
    sources: chain.sources,
  };
  const finder = createRouteFinder({ network, index: createPoolIndex(network, rpc), rpc, runtimeCode });
  const native = chain.tokens[0];
  const stable = chain.tokens.find((t) => t.stable);
  const other = chain.tokens[chain.tokens.length - 1];
  const trades = [
    [native, stable, "50"],
    [stable, other, "20000"],
  ];
  console.log(`\n=== ${chain.name} (${chain.id})`);
  for (const [tin, tout, amount] of trades) {
    const started = Date.now();
    try {
      const route = await finder.find({ tokenIn: tin.address, tokenOut: tout.address, amountIn: parseUnits(amount, tin.decimals) });
      if (!route) {
        console.log(`  ${amount} ${tin.symbol} -> ${tout.symbol}: no route`);
        continue;
      }
      const sym = (a) => chain.tokens.find((t) => t.address.toLowerCase() === a)?.symbol || a.slice(0, 8);
      console.log(
        `  ${amount} ${tin.symbol} -> ${formatUnits(route.amountOut, tout.decimals)} ${tout.symbol}  ` +
          `(best single ${formatUnits(route.bestSingle.amountOut, tout.decimals)}, impact ${(route.priceImpact * 100).toFixed(3)}%, ` +
          `${route.candidates} paths, ${Date.now() - started}ms)`
      );
      for (const path of route.paths) {
        console.log(`    ${path.shareBps / 100}%: ${path.hops.map((h) => `${sym(h.tokenIn)}>${sym(h.tokenOut)} ${h.sourceName} ${h.label}`).join(" | ")}`);
      }
      console.log(`    sources: ${route.sources.map((s) => `${s.name}=${Number(formatUnits(s.amountOut, tout.decimals)).toFixed(4)}`).join(", ")}`);
    } catch (error) {
      console.log(`  ${amount} ${tin.symbol} -> ${tout.symbol}: ERROR ${error.message}`);
    }
  }
}
