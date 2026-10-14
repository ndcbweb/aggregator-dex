#!/usr/bin/env node
// End-to-end on a local anvil chain: deploys mock DEXes (V2, V3 and Algebra factories) and the router, runs the
// bundled server against them, then quotes and executes swaps through the API and checks admin and RPC endpoints.
// Usage: node server/test/e2e.mjs   (expects dist/aggregator.tar.gz and contracts/out from forge build)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = new URL("../../", import.meta.url).pathname;
const RPC_PORT = 18645;
const APP_PORT = 14400;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const work = mkdtempSync(join(tmpdir(), "agg-e2e-"));
const children = [];
const cleanup = () => {
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
};
process.on("exit", cleanup);

const log = [];
function fail(message) {
  console.error(`FAIL: ${message}`);
  console.error(Buffer.concat(log).toString("utf8").slice(-4000));
  process.exit(1);
}

const artifact = (file, name) => JSON.parse(readFileSync(join(root, "contracts/out", file, `${name}.json`), "utf8"));
const waitFor = async (check, what, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`timed out waiting for ${what}`);
};

const anvil = spawn("anvil", ["--port", String(RPC_PORT), "--silent"], { stdio: "ignore" });
children.push(anvil);
await waitFor(() => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }).then((r) => r.ok), "anvil");

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const chain = { id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function deploy(file, name, args = []) {
  const { abi, bytecode } = artifact(file, name);
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  return { address: contractAddress, abi };
}
async function write(contract, functionName, args = [], value) {
  const hash = await wallet.writeContract({ address: contract.address, abi: contract.abi, functionName, args, value });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`${functionName} reverted`);
  return receipt;
}

// Liquidity: WETH/USDC on V2; USDC/DAI on V2, V3 (0.05%) and Algebra.
const weth = await deploy("WrappedNative.sol", "WrappedNative", ["Wrapped Ether", "WETH"]);
const usdc = await deploy("Mocks.sol", "MockToken", ["USDC", 0n]);
const dai = await deploy("Mocks.sol", "MockToken", ["DAI", 0n]);
const v2Factory = await deploy("Mocks.sol", "MockV2Factory");
const v3Factory = await deploy("Mocks.sol", "MockV3Factory");
const algebraFactory = await deploy("Mocks.sol", "MockAlgebraFactory");

await write(weth, "deposit", [], parseEther("1000"));
const wethUsdc = await deploy("Mocks.sol", "MockV2Pair", [weth.address, usdc.address, 3000n]);
await write(weth, "transfer", [wethUsdc.address, parseEther("1000")]);
await write(usdc, "mint", [wethUsdc.address, parseEther("2000000")]);
await write(wethUsdc, "sync");
await write(v2Factory, "register", [wethUsdc.address]);

const usdcDai = await deploy("Mocks.sol", "MockV2Pair", [usdc.address, dai.address, 3000n]);
await write(usdc, "mint", [usdcDai.address, parseEther("500000")]);
await write(dai, "mint", [usdcDai.address, parseEther("500000")]);
await write(usdcDai, "sync");
await write(v2Factory, "register", [usdcDai.address]);

for (const [factory, flavor, fee] of [
  [v3Factory, 0, 500n],
  [algebraFactory, 2, null],
]) {
  const pool = await deploy("Mocks.sol", "MockV3Pool", [usdc.address, dai.address, flavor, 998n, 1000n]);
  await write(usdc, "mint", [pool.address, parseEther("100000")]);
  await write(dai, "mint", [pool.address, parseEther("100000")]);
  await write(pool, "setDepth", [parseEther("40000")]);
  await write(factory, "register", fee === null ? [pool.address] : [pool.address, fee]);
}

const treasury = "0x000000000000000000000000000000000000fee5";
const router = await deploy("NadcabAggregationRouter.sol", "NadcabAggregationRouter", [weth.address, account.address, treasury, 30, 5000]);

const settings = {
  name: "E2E Aggregator",
  networks: [
    {
      chainId: 31337,
      name: "Anvil",
      native: { symbol: "ETH", name: "Ether" },
      rpcUrl: RPC,
      wrappedNative: weth.address,
      router: router.address,
      sources: [
        { id: "mock-v2", name: "Mock V2", kind: "v2", factory: v2Factory.address, fee: 3000 },
        { id: "mock-v3", name: "Mock V3", kind: "v3", factory: v3Factory.address, fees: [500, 3000] },
        { id: "mock-algebra", name: "Mock Algebra", kind: "algebra", factory: algebraFactory.address },
      ],
      tokens: [
        { address: weth.address, symbol: "WETH", name: "Wrapped Ether", decimals: 18, connector: true },
        { address: usdc.address, symbol: "USDC", name: "USD Coin", decimals: 18, connector: true },
        { address: dai.address, symbol: "DAI", name: "Dai", decimals: 18 },
      ],
    },
  ],
};
writeFileSync(join(work, "seed.json"), JSON.stringify(settings));

execFileSync("tar", ["-xzf", join(root, "dist/aggregator.tar.gz"), "-C", work]);
const server = spawn("node", ["--no-warnings", "src/index.js"], {
  cwd: join(work, "aggregator/server"),
  env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: join(work, "data"), WEB_DIR: "../web/out", ADMIN_SECRET: "e2e-secret", SETTINGS_SEED: join(work, "seed.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(server);
server.stdout.on("data", (d) => log.push(d));
server.stderr.on("data", (d) => log.push(d));
await waitFor(() => fetch(`${BASE}/api/health`).then((r) => r.ok), "server");

const get = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const config = await get("/api/config");
const net = config.body?.networks?.[0];
if (!net?.router?.deployed || net.router.feeBps !== 30 || net.router.surplusShareBps !== 5000) fail(`router state not read: ${JSON.stringify(net?.router)}`);
if (JSON.stringify(config.body).includes(RPC)) fail("config leaks the private RPC URL");

// Coin in, two hops (ETH → USDC → DAI), executed on-chain.
const amount = parseEther("2");
const q1 = await get(`/api/quote?chainId=31337&tokenIn=native&tokenOut=${dai.address}&amount=${amount}`);
if (q1.status !== 200) fail(`quote ETH->DAI: ${JSON.stringify(q1.body)}`);
if (!q1.body.paths.every((p) => p.hops.length === 2)) fail("ETH->DAI should route through USDC");
const ROUTER_ABI = artifact("NadcabAggregationRouter.sol", "NadcabAggregationRouter").abi;
async function swapWith(quote, tokenIn, tokenOut, value) {
  const minReturn = (BigInt(quote.amountOutNet) * 995n) / 1000n;
  const block = await pub.getBlock();
  const hash = await wallet.writeContract({
    address: router.address,
    abi: ROUTER_ABI,
    functionName: "swap",
    value,
    args: [
      { tokenIn, tokenOut, amountIn: BigInt(quote.amountIn), minReturn, quotedOut: BigInt(quote.amountOut), recipient: account.address, deadline: block.timestamp + 300n },
      quote.paths.map((p) => ({ shareBps: p.shareBps, hops: p.hops.map((h) => ({ kind: h.kind, pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut, fee: h.fee })) })),
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail("swap reverted");
}
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)"]);
const balance = (token, who = account.address) => pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [who] });
const daiBefore = await balance(dai.address);
await swapWith(q1.body, NATIVE, dai.address, amount);
const gotDai = (await balance(dai.address)) - daiBefore;
if (gotDai !== BigInt(q1.body.amountOutNet)) fail(`ETH->DAI got ${gotDai}, quoted ${q1.body.amountOutNet}`);
console.log(`ok   ETH->DAI over ${q1.body.paths.length} path(s): ${gotDai} (exactly the quote after fee)`);

// Token in, large enough to split across V2, V3 and Algebra.
await write({ address: usdc.address, abi: ERC20 }, "approve", [router.address, 2n ** 256n - 1n]);
await write(usdc, "mint", [account.address, parseEther("60000")]);
const q2 = await get(`/api/quote?chainId=31337&tokenIn=${usdc.address}&tokenOut=${dai.address}&amount=${parseEther("60000")}`);
if (q2.status !== 200) fail(`quote USDC->DAI: ${JSON.stringify(q2.body)}`);
const sources = new Set(q2.body.paths.flatMap((p) => p.hops.map((h) => h.source)));
if (sources.size < 2) fail(`USDC->DAI did not split: ${[...sources]}`);
if (BigInt(q2.body.amountOut) < BigInt(q2.body.bestSingle.amountOut)) fail("split is worse than the best single path");
const before2 = await balance(dai.address);
await swapWith(q2.body, usdc.address, dai.address, 0n);
const got2 = (await balance(dai.address)) - before2;
if (got2 !== BigInt(q2.body.amountOutNet)) fail(`USDC->DAI got ${got2}, quoted ${q2.body.amountOutNet}`);
console.log(`ok   USDC->DAI split over ${[...sources].join(", ")}: ${got2}`);

// Excluding sources changes the route.
const q3 = await get(`/api/quote?chainId=31337&tokenIn=${usdc.address}&tokenOut=${dai.address}&amount=${parseEther("1000")}&exclude=mock-v3,mock-algebra`);
if (!q3.body.paths.every((p) => p.hops.every((h) => h.source === "mock-v2"))) fail("exclude was ignored");
console.log("ok   exclude=mock-v3,mock-algebra keeps the route on Mock V2");

if ((await balance(dai.address, treasury)) === 0n) fail("treasury received no fee");
console.log("ok   partner fee reached the treasury");

// API guards.
const badQuote = await get(`/api/quote?chainId=31337&tokenIn=native&tokenOut=${dai.address}&amount=0`);
if (badQuote.status !== 400) fail("zero amount should be rejected");
const unknownChain = await get(`/api/quote?chainId=5&tokenIn=native&tokenOut=${dai.address}&amount=1`);
if (unknownChain.status !== 404) fail("unknown chain should 404");
const token = await get(`/api/token/31337/${usdc.address}`);
if (token.body?.token?.symbol !== "USDC" || token.body.token.decimals !== 18) fail("token lookup");
const rpcOk = await get("/api/rpc/31337", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' });
if (rpcOk.body?.result !== "0x7a69") fail("rpc relay");
const rpcDenied = await get("/api/rpc/31337", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}' });
if (rpcDenied.status !== 403) fail("rpc relay must refuse writes");
console.log("ok   quote validation, token lookup and read-only RPC relay");

const unauthorized = await get("/api/admin/settings");
if (unauthorized.status !== 401) fail("admin without secret");
const auth = { authorization: "Bearer e2e-secret", "content-type": "application/json" };
const status = await get("/api/admin/status", { headers: auth });
if (!status.body?.networks?.[0]?.rpc?.ok || !status.body.networks[0].sources.every((s) => s.deployed)) fail(`admin status: ${JSON.stringify(status.body)}`);
const saved = await get("/api/admin/settings", { method: "PUT", headers: auth, body: JSON.stringify({ name: "Renamed", brandColor: "#ff0066" }) });
if (saved.body?.settings?.name !== "Renamed" || saved.body.settings.networks.length !== 1) fail("admin settings update");
const site = await fetch(`${BASE}/`);
if (!site.ok || !(await site.text()).includes("<html")) fail("site not served");
console.log("ok   admin auth, status and settings; site served");

console.log("\ne2e passed");
process.exit(0);
