import { decodeFunctionResult, encodeFunctionData } from "viem";
import { NATIVE, ROUTER } from "./abi.js";

/** Address the router's runtime code is placed at (eth_call state override) before a router is deployed. */
export const QUOTER_OVERRIDE = "0x00000000000000000000000000000000004e4443";

const KEEP_PER_TOKEN = 2;
const MAX_CONNECTORS = 6;
const MAX_HUBS = 3;
/** Hop-quotes per eth_call; keeps every call far below RPC gas caps. */
const QUOTES_PER_CALL = 20;
const GAS = { base: 70_000n, path: 25_000n, hop: [65_000n, 85_000n, 115_000n] };

const lower = (value) => String(value || "").toLowerCase();

/**
 * Creates the quoting engine for one network.
 * `network`: { wrappedNative, router?, connectors[], sources[] }; `index`: pool index; `rpc`: JSON-RPC client;
 * `runtimeCode`: router deployedBytecode, used when the network has no router yet.
 */
export function createRouteFinder({ network, index, rpc, runtimeCode }) {
  const wrapped = lower(network.wrappedNative);
  const quoter = network.router || QUOTER_OVERRIDE;
  const overrides = network.router ? undefined : { [QUOTER_OVERRIDE]: { code: runtimeCode } };

  /** Quotes many (hops, amounts[]) jobs through router.quote, chunked into a JSON-RPC batch. */
  async function quoteJobs(jobs) {
    const chunks = [];
    let current = [];
    let weight = 0;
    for (const job of jobs) {
      const cost = job.hops.length * job.amounts.length;
      if (current.length && (job.single || weight + cost > QUOTES_PER_CALL)) {
        chunks.push(current);
        current = [];
        weight = 0;
      }
      current.push(job);
      weight += cost;
    }
    if (current.length) chunks.push(current);

    const calls = chunks.map((chunk) => {
      const data = encodeFunctionData({
        abi: ROUTER,
        functionName: "quote",
        args: [chunk.map((job) => job.hops.map(toHop)), chunk.map((job) => job.amounts)],
      });
      const params = [{ to: quoter, data }, "latest"];
      if (overrides) params.push(overrides);
      return ["eth_call", params];
    });
    const decode = (answer) => {
      if (!answer.result) return null;
      try {
        return decodeFunctionResult({ abi: ROUTER, functionName: "quote", data: answer.result });
      } catch {
        return null;
      }
    };
    const answers = await rpc.batch(calls);
    const results = [];
    for (let c = 0; c < chunks.length; c++) {
      const outs = decode(answers[c]);
      if (outs) {
        chunks[c].forEach((_, j) => results.push([...outs[j]]));
      } else if (chunks[c].length > 1) {
        // One heavy job can push a chunk over the node's gas cap; retry its jobs alone so the rest still quote.
        results.push(...(await quoteJobs(chunks[c].map((job) => ({ ...job, single: true })))));
      } else {
        results.push(chunks[c][0].amounts.map(() => 0n));
      }
    }
    return results;
  }

  /**
   * Finds the best split route for `amountIn` of tokenIn → tokenOut. Returns null when no pool path exists.
   * Options: maxHops (1-3), maxSplits (1-6), steps (split granularity), exclude (source ids to skip).
   */
  async function find({ tokenIn, tokenOut, amountIn, maxHops = 3, maxSplits = 5, steps = 10, exclude = [] }) {
    const A = lower(tokenIn) === NATIVE ? wrapped : lower(tokenIn);
    const B = lower(tokenOut) === NATIVE ? wrapped : lower(tokenOut);
    if (A === B) throw new Error("Pick two different tokens");
    const skip = new Set(exclude.map(lower));

    const connectors = network.connectors.map(lower).filter((t) => t !== A && t !== B).slice(0, MAX_CONNECTORS);
    const hubs = connectors.slice(0, MAX_HUBS);
    const pairs = [[A, B]];
    if (maxHops >= 2) {
      for (const c of connectors) pairs.push([A, c], [c, B]);
    }
    if (maxHops >= 3) {
      for (const h of hubs) for (const k of hubs) if (h < k) pairs.push([h, k]);
    }

    const [edgesOf, gasPriceHex] = await Promise.all([index.discover(pairs), rpc.call("eth_gasPrice").catch(() => "0x0")]);
    const edges = (x, y) => edgesOf(x, y).filter((pool) => !skip.has(pool.source));

    // Layered search: extend partial paths one hop at a time, quoting each extension at the amount it would carry.
    let frontier = new Map([[A, [{ hops: [], amount: amountIn, tokens: [A] }]]]);
    const complete = [];
    let wrappedLeg = A === wrapped ? amountIn : 0n;
    for (let depth = 1; depth <= maxHops && frontier.size; depth++) {
      const expansions = [];
      for (const [token, partials] of frontier) {
        const targets = depth === maxHops ? [B] : depth === 1 ? [B, ...connectors] : [B, ...hubs];
        for (const target of targets) {
          for (const partial of partials) {
            if (partial.tokens.includes(target)) continue;
            for (const pool of edges(token, target)) {
              expansions.push({ partial, target, hop: { ...pool, tokenIn: token, tokenOut: target } });
            }
          }
        }
      }
      if (!expansions.length) break;
      const outs = await quoteJobs(expansions.map((e) => ({ hops: [e.hop], amounts: [e.partial.amount] })));
      const next = new Map();
      expansions.forEach((e, i) => {
        const amount = outs[i][0];
        if (!amount) return;
        const path = { hops: [...e.partial.hops, e.hop], amount, tokens: [...e.partial.tokens, e.target] };
        if (e.target === B) complete.push(path);
        else {
          if (!next.has(e.target)) next.set(e.target, []);
          next.get(e.target).push(path);
        }
      });
      for (const [token, list] of next) {
        list.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
        if (depth === 1 && token === wrapped) wrappedLeg = list[0].amount;
        next.set(token, list.slice(0, KEEP_PER_TOKEN));
      }
      frontier = next;
    }
    if (!complete.length) return null;
    complete.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));

    // Candidates for splitting must not share pools, so their quotes stay independent.
    const chosen = [];
    const used = new Set();
    for (const path of complete) {
      if (chosen.length >= maxSplits) break;
      if (path.hops.some((hop) => used.has(hop.address))) continue;
      path.hops.forEach((hop) => used.add(hop.address));
      chosen.push(path);
    }

    const best = complete[0];
    const gasPrice = BigInt(gasPriceHex || "0x0");
    // Output-token units per wei of gas, so the split can weigh extra paths against what they cost to execute.
    const outPerNative = B === wrapped ? 1 : wrappedLeg > 0n ? Number(best.amount) / Number(wrappedLeg) : 0;
    const gasOf = (path) => GAS.path + path.hops.reduce((sum, hop) => sum + GAS.hop[hop.kind], 0n);
    const penalty = (path) => Number(gasOf(path) * gasPrice) * outPerNative;

    const fractions = Array.from({ length: steps }, (_, k) => (amountIn * BigInt(k + 1)) / BigInt(steps));
    const spotIn = amountIn / 1000n > 0n ? amountIn / 1000n : amountIn;
    const jobs = chosen.map((path) => ({ hops: path.hops, amounts: chosen.length > 1 ? fractions : [amountIn] }));
    jobs.push({ hops: best.hops, amounts: [spotIn] });
    const curves = await quoteJobs(jobs);
    const spotOut = curves.pop()[0];

    const allocation = chosen.length > 1 ? splitDp(curves, steps, chosen.map(penalty)) : [steps];
    let paths = [];
    let gross = 0n;
    let spent = 0n;
    const picked = chosen.map((path, i) => ({ path, k: allocation[i], i })).filter((row) => row.k > 0);
    picked.forEach((row, n) => {
      const last = n === picked.length - 1;
      const shareBps = last ? 10_000 - paths.reduce((sum, p) => sum + p.shareBps, 0) : Math.round((row.k * 10_000) / steps);
      const legIn = last ? amountIn - spent : (amountIn * BigInt(shareBps)) / 10_000n;
      spent += legIn;
      const legOut = chosen.length > 1 ? curves[row.i][row.k - 1] : curves[row.i][0];
      gross += legOut;
      paths.push({ shareBps, amountIn: legIn, amountOut: legOut, hops: row.path.hops.map(publicHop) });
    });
    // Split quotes can come back short when the RPC drops calls; never return less than the best single path.
    if (gross < best.amount) {
      gross = best.amount;
      paths = [{ shareBps: 10_000, amountIn, amountOut: best.amount, hops: best.hops.map(publicHop) }];
    }

    const bySource = new Map();
    for (const path of complete) {
      const ids = new Set(path.hops.map((hop) => hop.source));
      if (ids.size !== 1) continue;
      const hop = path.hops[0];
      const prev = bySource.get(hop.source);
      if (!prev || path.amount > prev.amountOut) bySource.set(hop.source, { id: hop.source, name: hop.sourceName, amountOut: path.amount });
    }

    const execution = Number(gross) / Number(amountIn);
    const spot = Number(spotOut) / Number(spotIn);
    const gas = GAS.base + paths.reduce((sum, path) => sum + GAS.path + path.hops.reduce((s, hop) => s + GAS.hop[hop.kind], 0n), 0n);
    return {
      tokenIn: lower(tokenIn),
      tokenOut: lower(tokenOut),
      amountIn,
      amountOut: gross,
      paths,
      priceImpact: spot > 0 ? Math.max(0, 1 - execution / spot) : null,
      gas,
      gasPrice,
      bestSingle: { amountOut: best.amount, hops: best.hops.map(publicHop) },
      sources: [...bySource.values()].sort((x, y) => (y.amountOut > x.amountOut ? 1 : -1)),
      candidates: complete.length,
    };
  }

  return { find, quoteJobs };
}

function toHop(hop) {
  return { kind: hop.kind, pool: hop.address, tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, fee: hop.fee };
}

function publicHop(hop) {
  return { ...toHop(hop), source: hop.source, sourceName: hop.sourceName, label: hop.label };
}

/**
 * Splits `steps` equal chunks of input across paths to maximise total output minus a fixed per-path cost.
 * `curves[i][k-1]` is path i's output for k chunks. Returns chunks per path.
 */
export function splitDp(curves, steps, penalties) {
  const n = curves.length;
  const value = (i, k) => (k === 0 ? 0 : Number(curves[i][k - 1]) - (Number(curves[i][k - 1]) > 0 ? penalties[i] : Infinity));
  let best = Array(steps + 1).fill(-Infinity);
  best[0] = 0;
  const choice = [];
  for (let i = 0; i < n; i++) {
    const next = Array(steps + 1).fill(-Infinity);
    const pick = Array(steps + 1).fill(0);
    for (let total = 0; total <= steps; total++) {
      for (let k = 0; k <= total; k++) {
        if (best[total - k] === -Infinity) continue;
        const v = value(i, k);
        if (v === -Infinity) continue;
        const candidate = best[total - k] + v;
        if (candidate > next[total]) {
          next[total] = candidate;
          pick[total] = k;
        }
      }
    }
    choice.push(pick);
    best = next;
  }
  const allocation = Array(n).fill(0);
  if (best[steps] === -Infinity) {
    allocation[0] = steps;
    return allocation;
  }
  let remaining = steps;
  for (let i = n - 1; i >= 0; i--) {
    allocation[i] = choice[i][remaining];
    remaining -= allocation[i];
  }
  return allocation;
}
