#!/usr/bin/env node
// Prints aggregator settings for the given preset chain keys (all when none), for local runs and tests.
// Usage: node scripts/settings-from-presets.mjs [chainKey...] > settings.json
import { readFileSync } from "node:fs";

const presets = JSON.parse(readFileSync(new URL("../presets/chains.json", import.meta.url)));
const keys = process.argv.slice(2);
const chains = presets.chains.filter((chain) => !keys.length || keys.includes(chain.key));
const settings = {
  name: "Nadcab Aggregator",
  tagline: "Best price across every DEX",
  defaultChainId: chains[0]?.id,
  networks: chains.map((chain) => ({
    chainId: chain.id,
    key: chain.key,
    name: chain.name,
    native: chain.native,
    rpcUrl: chain.rpcUrl,
    publicRpcUrl: chain.rpcUrl,
    explorerUrl: chain.explorerUrl,
    wrappedNative: chain.wrappedNative,
    sources: chain.sources,
    tokens: chain.tokens,
  })),
};
console.log(JSON.stringify(settings, null, 2));
