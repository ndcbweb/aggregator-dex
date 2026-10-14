import { decodeFunctionResult, encodeFunctionData } from "viem";
import { HOP_KIND, LOOKUP, POOL } from "./abi.js";
import { createReader } from "./multicall.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const FOUND_TTL = 10 * 60_000;
const MISSING_TTL = 5 * 60_000;

const sortPair = (a, b) => (a < b ? [a, b] : [b, a]);

/** Factory calls that can return a pool for the pair, one per fee tier / tick spacing / stability flag. */
function lookups(source, token0, token1) {
  const abi = LOOKUP[source.kind === "v2-dynamic" ? "v2" : source.kind];
  const make = (args, meta) => ({
    source,
    meta,
    data: encodeFunctionData({ abi, functionName: abi[0].name, args }),
  });
  switch (source.kind) {
    case "v2":
    case "v2-dynamic":
      return [make([token0, token1], {})];
    case "solidly":
      return [make([token0, token1, false], { stable: false }), make([token0, token1, true], { stable: true })];
    case "v3":
      return (source.fees || []).map((fee) => make([token0, token1, fee], { fee }));
    case "slipstream":
      return (source.tickSpacings || []).map((tickSpacing) => make([token0, token1, tickSpacing], { tickSpacing }));
    case "algebra":
      return [make([token0, token1], {})];
    default:
      return [];
  }
}

function label(source, meta) {
  if (source.kind === "v2") return `${source.fee / 10_000}%`;
  if (source.kind === "v3") return `${meta.fee / 10_000}%`;
  if (source.kind === "solidly") return meta.stable ? "stable" : "volatile";
  if (source.kind === "slipstream") return `CL${meta.tickSpacing}`;
  return "dynamic fee";
}

/**
 * Finds pools for token pairs across a network's sources and keeps the ones holding liquidity.
 * Results are cached per pair, so repeat quotes for popular pairs cost no discovery calls.
 */
export function createPoolIndex(network, rpc) {
  const cache = new Map();
  const reader = createReader(rpc);

  async function discover(pairs) {
    const now = Date.now();
    const partial = new Map();
    const pending = [];
    for (const [a, b] of pairs) {
      const [token0, token1] = sortPair(a, b);
      const key = `${token0}:${token1}`;
      const hit = cache.get(key);
      if (hit && now - hit.at < (hit.pools.length ? FOUND_TTL : MISSING_TTL)) continue;
      if (!pending.some((row) => row.key === key)) pending.push({ key, token0, token1 });
    }
    if (pending.length) {
      const calls = pending.flatMap((pair) =>
        network.sources.flatMap((source) => lookups(source, pair.token0, pair.token1).map((call) => ({ ...call, pair })))
      );
      const answers = await reader.readMany(calls.map((call) => ({ to: call.source.factory, data: call.data })));
      const failed = new Set();
      const found = [];
      const seen = new Set();
      answers.forEach((answer, i) => {
        if (answer.error) failed.add(calls[i].pair.key);
        if (!answer.ok || answer.data.length < 66) return;
        const address = `0x${answer.data.slice(-40)}`.toLowerCase();
        if (address === ZERO || seen.has(address)) return;
        seen.add(address);
        found.push({ ...calls[i], address });
      });

      const checks = await reader.readMany(
        found.map((pool) => {
          const abi = HOP_KIND[pool.source.kind] === 2 ? POOL.liquidity : POOL.reserves;
          return { to: pool.address, data: encodeFunctionData({ abi, functionName: abi[0].name }) };
        })
      );
      const byPair = new Map(pending.map((pair) => [pair.key, []]));
      found.forEach((pool, i) => {
        const check = checks[i];
        if (check.error) failed.add(pool.pair.key);
        if (!check.ok) return;
        const concentrated = HOP_KIND[pool.source.kind] === 2;
        let live = false;
        try {
          if (concentrated) {
            live = decodeFunctionResult({ abi: POOL.liquidity, functionName: "liquidity", data: check.data }) > 0n;
          } else {
            const [r0, r1] = decodeFunctionResult({ abi: POOL.reserves, functionName: "getReserves", data: check.data });
            live = r0 > 1000n && r1 > 1000n;
          }
        } catch {
          live = false;
        }
        if (!live) return;
        byPair.get(pool.pair.key).push({
          address: pool.address,
          token0: pool.pair.token0,
          token1: pool.pair.token1,
          kind: HOP_KIND[pool.source.kind],
          fee: pool.source.kind === "v2" ? pool.source.fee : 0,
          source: pool.source.id,
          sourceName: pool.source.name,
          label: label(pool.source, pool.meta),
        });
      });
      // A pair whose lookups hit RPC errors is not cached, so the next quote looks again instead of missing pools.
      for (const [key, pools] of byPair) if (!failed.has(key)) cache.set(key, { at: now, pools });
      for (const key of failed) partial.set(key, byPair.get(key));
    }
    return (a, b) => {
      const [token0, token1] = sortPair(a, b);
      const key = `${token0}:${token1}`;
      return cache.get(key)?.pools || partial.get(key) || [];
    };
  }

  return { discover, clear: () => cache.clear(), size: () => cache.size };
}
