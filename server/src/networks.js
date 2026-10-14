import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { ERC20, NATIVE, ROUTER } from "./engine/abi.js";
import { createReader } from "./engine/multicall.js";
import { createPoolIndex } from "./engine/pools.js";
import { createRouteFinder } from "./engine/route.js";
import { createRpc } from "./engine/rpc.js";
import { getSettings, onSettingsChange } from "./settings.js";

const artifacts = JSON.parse(readFileSync(new URL("../../artifacts/aggregator.json", import.meta.url), "utf8"));
const RUNTIME = artifacts.contracts.NadcabAggregationRouter.deployedBytecode;

const runtimes = new Map();

/** Engine, RPC and reader for one configured network; rebuilt whenever its settings change. */
function build(network) {
  const rpc = createRpc(network.rpcUrl);
  const engineNetwork = {
    wrappedNative: network.wrappedNative,
    router: network.router || "",
    connectors: network.tokens.filter((t) => t.connector).map((t) => t.address),
    sources: network.sources,
  };
  const index = createPoolIndex(engineNetwork, rpc);
  return {
    fingerprint: JSON.stringify(network),
    network,
    rpc,
    reader: createReader(rpc),
    finder: createRouteFinder({ network: engineNetwork, index, rpc, runtimeCode: RUNTIME }),
    index,
    routerState: null,
    routerStateAt: 0,
  };
}

function sync(settings) {
  const keep = new Set();
  for (const network of settings.networks) {
    keep.add(network.chainId);
    const existing = runtimes.get(network.chainId);
    if (!existing || existing.fingerprint !== JSON.stringify(network)) runtimes.set(network.chainId, build(network));
  }
  for (const chainId of runtimes.keys()) if (!keep.has(chainId)) runtimes.delete(chainId);
}

sync(getSettings());
onSettingsChange(sync);

export function runtime(chainId) {
  return runtimes.get(Number(chainId)) || null;
}

export function allRuntimes() {
  return [...runtimes.values()];
}

const ROUTER_READS = ["feeBps", "surplusShareBps", "feeRecipient", "paused", "owner", "wrappedNative"];

/** Live router settings (fees, pause, owner), cached for 30 seconds. */
export async function routerState(rt) {
  if (!rt.network.router) return null;
  if (rt.routerState && Date.now() - rt.routerStateAt < 30_000) return rt.routerState;
  const results = await rt.reader.readMany(
    ROUTER_READS.map((name) => ({ to: rt.network.router, data: encodeFunctionData({ abi: ROUTER, functionName: name }) }))
  );
  if (results.some((r) => !r.ok)) {
    rt.routerState = { address: rt.network.router, deployed: false };
  } else {
    const [feeBps, surplusShareBps, feeRecipient, paused, owner, wrappedNative] = results.map((r, i) =>
      decodeFunctionResult({ abi: ROUTER, functionName: ROUTER_READS[i], data: r.data })
    );
    rt.routerState = {
      address: rt.network.router,
      deployed: true,
      feeBps: Number(feeBps),
      surplusShareBps: Number(surplusShareBps),
      feeRecipient: feeRecipient.toLowerCase(),
      paused,
      owner: owner.toLowerCase(),
      wrappedNativeMatches: wrappedNative.toLowerCase() === rt.network.wrappedNative,
    };
  }
  rt.routerStateAt = Date.now();
  return rt.routerState;
}

/** symbol / name / decimals of a token, read on-chain. */
export async function tokenMeta(rt, address) {
  if (address === NATIVE) return { address: NATIVE, ...rt.network.native, native: true };
  const reads = await rt.reader.readMany(
    ["symbol", "name", "decimals"].map((name) => ({ to: address, data: encodeFunctionData({ abi: ERC20, functionName: name }) }))
  );
  if (!reads[2].ok) return null;
  const decode = (i, name, fallback) => {
    try {
      return reads[i].ok ? decodeFunctionResult({ abi: ERC20, functionName: name, data: reads[i].data }) : fallback;
    } catch {
      return fallback;
    }
  };
  const symbol = String(decode(0, "symbol", "TOKEN")).slice(0, 16);
  return { address, symbol, name: String(decode(1, "name", symbol)).slice(0, 60), decimals: Number(decode(2, "decimals", 18)) };
}
