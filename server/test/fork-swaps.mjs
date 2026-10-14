#!/usr/bin/env node
// Forks preset chains with anvil, deploys the router and executes real swaps through every liquidity source:
// one single-hop swap per source, then engine-routed split swaps (coin in, token in, coin out). Quotes come from the
// live chain, so each swap must land within 0.5% of its quote.
// Usage: node test/fork-swaps.mjs [chainKey...]   (FORK_RPC_<KEY> overrides the fork URL)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NATIVE } from "../src/engine/abi.js";
import { createPoolIndex } from "../src/engine/pools.js";
import { createRouteFinder } from "../src/engine/route.js";
import { createRpc } from "../src/engine/rpc.js";

const presets = JSON.parse(readFileSync(new URL("../../presets/chains.json", import.meta.url)));
const artifacts = JSON.parse(readFileSync(new URL("../../artifacts/aggregator.json", import.meta.url)));
const ROUTER = artifacts.contracts.NadcabAggregationRouter;
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const FORK_RPC = {
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://polygon.drpc.org",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc: "https://bsc-dataseed.bnbchain.org",
};
/** Coin amount to trade per chain, roughly a few hundred dollars. */
const TRADE = { ethereum: "0.2", bsc: "1", polygon: "2000", arbitrum: "0.2", base: "0.2", optimism: "0.2", avalanche: "20" };
// A fresh key: well-known anvil keys carry EIP-7702 delegations on mainnets that sweep incoming coin.
const account = privateKeyToAccount(generatePrivateKey());
const treasury = "0x000000000000000000000000000000000000fee5";
const only = process.argv.slice(2);
let failures = 0;

async function startAnvil(forkUrl, port) {
  const child = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent", "--no-storage-caching"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' });
      if (res.ok) return { child, url };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("anvil did not start");
}

for (const [n, chain] of presets.chains.entries()) {
  if (only.length && !only.includes(chain.key)) continue;
  const forkUrl = process.env[`FORK_RPC_${chain.key.toUpperCase()}`] || FORK_RPC[chain.key] || chain.rpcUrl;
  console.log(`\n=== ${chain.name} (fork of ${forkUrl})`);
  let child;
  let url;
  try {
    ({ child, url } = await startAnvil(forkUrl, 19545 + n));
  } catch (error) {
    failures++;
    console.log(`  FAIL ${chain.name}: ${error.message}`);
    continue;
  }
  try {
    const viemChain = { id: chain.id, name: chain.name, nativeCurrency: chain.native, rpcUrls: { default: { http: [url] } } };
    const publicClient = createPublicClient({ chain: viemChain, transport: http(url, { timeout: 120_000 }) });
    const wallet = createWalletClient({ account, chain: viemChain, transport: http(url, { timeout: 120_000 }) });
    await publicClient.request({ method: "anvil_setBalance", params: [account.address, "0x52b7d2dcc80cd2e4000000"] });

    const deployHash = await wallet.deployContract({
      abi: ROUTER.abi,
      bytecode: ROUTER.bytecode,
      args: [chain.wrappedNative, account.address, treasury, 30, 5000],
    });
    const router = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress;

    // Routes are found against the live chain (fast) and executed on the fork, which only loads the slots a swap touches.
    const rpc = createRpc(process.env[`RPC_${chain.key.toUpperCase()}`] || chain.rpcUrl);
    const network = {
      wrappedNative: chain.wrappedNative,
      connectors: chain.tokens.filter((t) => t.connector).map((t) => t.address),
      sources: chain.sources,
    };
    const index = createPoolIndex(network, rpc);
    const finder = createRouteFinder({ network, index, rpc, runtimeCode: ROUTER.deployedBytecode });
    const tokenOf = (address) => chain.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
    const balanceOf = (token) =>
      token === NATIVE ? publicClient.getBalance({ address: account.address }) : publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [account.address] });

    async function execute(label, route, tokenIn, tokenOut) {
      const minReturn = (route.amountOut * 9970n * 99n) / (10_000n * 100n);
      const before = await balanceOf(tokenOut);
      const block = await publicClient.getBlock();
      const args = [
        { tokenIn, tokenOut, amountIn: route.amountIn, minReturn, quotedOut: route.amountOut, recipient: account.address, deadline: block.timestamp + 600n },
        route.paths.map((path) => ({ shareBps: path.shareBps, hops: path.hops.map(({ kind, pool, tokenIn: a, tokenOut: b, fee }) => ({ kind, pool, tokenIn: a, tokenOut: b, fee })) })),
      ];
      try {
        const hash = await wallet.writeContract({ address: router, abi: ROUTER.abi, functionName: "swap", args, value: tokenIn === NATIVE ? route.amountIn : 0n, gas: 3_000_000n });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("reverted");
        const got = (await balanceOf(tokenOut)) - before + (tokenOut === NATIVE ? receipt.gasUsed * receipt.effectiveGasPrice : 0n);
        const expected = (route.amountOut * 9970n) / 10_000n;
        const drift = Number(got - expected) / Number(expected);
        const ok = got >= minReturn && Math.abs(drift) < 0.005;
        if (!ok) failures++;
        const out = tokenOut === NATIVE ? chain.native : tokenOf(tokenOut);
        console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: got ${formatUnits(got, out.decimals)} ${out.symbol} (quote after fee ${formatUnits(expected, out.decimals)}, drift ${(drift * 100).toFixed(4)}%, gas ${receipt.gasUsed})`);
      } catch (error) {
        failures++;
        console.log(`  FAIL ${label}: ${error.shortMessage || error.message}`);
      }
    }

    // One single-hop coin swap through each source's deepest pool against a connector.
    const amount = parseEther(TRADE[chain.key] || "1");
    const wrapped = chain.wrappedNative.toLowerCase();
    const targets = network.connectors.map((t) => t.toLowerCase()).filter((t) => t !== wrapped);
    const edges = await index.discover(targets.map((t) => [wrapped, t]));
    for (const source of chain.sources) {
      const pools = targets.flatMap((t) => edges(wrapped, t).filter((p) => p.source === source.id).map((p) => ({ ...p, tokenIn: wrapped, tokenOut: t })));
      if (!pools.length) {
        console.log(`  --   ${source.name}: no pool against a connector`);
        continue;
      }
      const outs = await finder.quoteJobs(pools.map((p) => ({ hops: [p], amounts: [amount] })));
      const bestIndex = outs.reduce((bestI, out, i) => (out[0] > outs[bestI][0] ? i : bestI), 0);
      const pool = pools[bestIndex];
      if (!outs[bestIndex][0]) {
        console.log(`  --   ${source.name}: pools found but none fills ${TRADE[chain.key]} ${chain.native.symbol}`);
        continue;
      }
      const route = {
        amountIn: amount,
        amountOut: outs[bestIndex][0],
        paths: [{ shareBps: 10_000, hops: [{ kind: pool.kind, pool: pool.address, tokenIn: pool.tokenIn, tokenOut: pool.tokenOut, fee: pool.fee }] }],
      };
      await execute(`${source.name} ${pool.label} ${chain.native.symbol}->${tokenOf(pool.tokenOut).symbol}`, route, NATIVE, pool.tokenOut);
    }

    // Engine-routed trades: a large coin trade (split), token in with approval, coin out.
    const stable = chain.tokens.find((t) => t.stable);
    const last = chain.tokens[chain.tokens.length - 1];
    const big = await finder.find({ tokenIn: NATIVE, tokenOut: stable.address, amountIn: amount * 50n });
    if (big) await execute(`split ${formatUnits(amount * 50n, 18)} ${chain.native.symbol}->${stable.symbol} over ${big.paths.length} paths`, big, NATIVE, stable.address.toLowerCase());
    const stableBalance = await balanceOf(stable.address);
    await wallet.writeContract({ address: stable.address, abi: ERC20, functionName: "approve", args: [router, 2n ** 256n - 1n] });
    const tokenTrade = await finder.find({ tokenIn: stable.address, tokenOut: last.address, amountIn: stableBalance / 2n });
    if (tokenTrade) await execute(`${stable.symbol}->${last.symbol} over ${tokenTrade.paths.length} paths`, tokenTrade, stable.address.toLowerCase(), last.address.toLowerCase());
    const back = await finder.find({ tokenIn: stable.address, tokenOut: NATIVE, amountIn: stableBalance / 4n });
    if (back) await execute(`${stable.symbol}->${chain.native.symbol} (coin out) over ${back.paths.length} paths`, back, stable.address.toLowerCase(), NATIVE);
    const fees = await balanceOf(stable.address).then(() => publicClient.readContract({ address: stable.address, abi: ERC20, functionName: "balanceOf", args: [treasury] }));
    console.log(`  treasury holds ${formatUnits(fees, stable.decimals)} ${stable.symbol} in fees`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${chain.name}: ${error.shortMessage || error.message}`);
  } finally {
    child.kill();
  }
}

console.log(failures ? `\n${failures} failure(s)` : "\nall swaps executed");
process.exit(failures ? 1 : 0);
