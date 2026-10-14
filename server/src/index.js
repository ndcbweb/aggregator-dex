import { timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { NATIVE } from "./engine/abi.js";
import { ENV } from "./config.js";
import { allRuntimes, routerState, runtime, tokenMeta } from "./networks.js";
import { BRANDING_DIR, getSettings, saveSettings } from "./settings.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const READ_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
]);

const app = Fastify({ trustProxy: "127.0.0.1", logger: { level: "info" }, disableRequestLogging: true, bodyLimit: 3 * 1024 * 1024 });
app.setReplySerializer((payload) => JSON.stringify(payload, (key, value) => (typeof value === "bigint" ? value.toString() : value)));

app.addHook("onSend", async (request, reply, payload) => {
  reply.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  return payload;
});

await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: "1 minute",
  allowList: (request) => request.url === "/api/health",
});

app.setErrorHandler((error, request, reply) => {
  if (error.name === "TimeoutError" || error.message === "fetch failed") {
    return reply.code(503).send({ ok: false, error: "The chain RPC is not reachable right now" });
  }
  const status = error.statusCode || 500;
  if (status >= 500) request.log.error(error);
  reply.code(status).send({ ok: false, error: error.message || "Request failed" });
});

function authorized(request) {
  if (!ENV.adminSecret) return false;
  const given = Buffer.from(String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(ENV.adminSecret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/api/admin/") && !authorized(request)) {
    return reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
});

const fail = (reply, code, error) => reply.code(code).send({ ok: false, error });

function networkOr404(chainId, reply) {
  const rt = runtime(chainId);
  if (!rt) fail(reply, 404, "This network is not enabled");
  return rt;
}

app.get("/api/health", async () => ({
  ok: true,
  networks: allRuntimes().map((rt) => ({ chainId: rt.network.chainId, pools: rt.index.size() })),
}));

/** Public site configuration: branding plus each network without its private RPC URL. */
app.get("/api/config", async () => {
  const settings = getSettings();
  const networks = await Promise.all(
    allRuntimes().map(async (rt) => {
      const n = rt.network;
      return {
        chainId: n.chainId,
        key: n.key,
        name: n.name,
        native: n.native,
        explorerUrl: n.explorerUrl,
        publicRpcUrl: n.publicRpcUrl,
        wrappedNative: n.wrappedNative,
        color: n.color,
        nadcab: n.nadcab,
        router: await routerState(rt).catch(() => null),
        sources: n.sources.map(({ id, name, kind }) => ({ id, name, kind })),
        tokens: n.tokens,
      };
    })
  );
  const { networks: _private, ...branding } = settings;
  return { settings: branding, networks };
});

const quoteCache = new Map();

/**
 * Best route for a trade. Query: chainId, tokenIn, tokenOut (address or "native"), amount (base units),
 * exclude (comma-separated source ids).
 */
app.get("/api/quote", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (request, reply) => {
  const rt = networkOr404(request.query.chainId, reply);
  if (!rt) return reply;
  const token = (value) => {
    const raw = String(value || "").toLowerCase();
    return raw === "native" || raw === NATIVE ? NATIVE : ADDRESS.test(raw) ? raw : "";
  };
  const tokenIn = token(request.query.tokenIn);
  const tokenOut = token(request.query.tokenOut);
  if (!tokenIn || !tokenOut) return fail(reply, 400, "tokenIn and tokenOut must be token addresses or native");
  let amountIn;
  try {
    amountIn = BigInt(String(request.query.amount || "0"));
  } catch {
    amountIn = 0n;
  }
  if (amountIn <= 0n || amountIn > 2n ** 200n) return fail(reply, 400, "amount must be a positive integer in base units");
  const exclude = String(request.query.exclude || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 30);

  const key = `${rt.network.chainId}:${tokenIn}:${tokenOut}:${amountIn}:${exclude.sort().join(",")}`;
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < 4000) return hit.value;

  const settings = getSettings();
  const [route, router] = await Promise.all([
    rt.finder.find({ tokenIn, tokenOut, amountIn, exclude, maxHops: settings.maxHops, maxSplits: settings.maxSplits }),
    routerState(rt).catch(() => null),
  ]);
  if (!route) return fail(reply, 404, "No liquidity route for this pair");
  const feeBps = router?.deployed ? router.feeBps : 0;
  const fee = (route.amountOut * BigInt(feeBps)) / 10_000n;
  const value = { ...route, chainId: rt.network.chainId, router: rt.network.router || null, feeBps, fee, amountOutNet: route.amountOut - fee, at: Date.now() };
  quoteCache.set(key, { at: Date.now(), value });
  if (quoteCache.size > 500) quoteCache.delete(quoteCache.keys().next().value);
  return value;
});

app.get("/api/token/:chainId/:address", async (request, reply) => {
  const rt = networkOr404(request.params.chainId, reply);
  if (!rt) return reply;
  const address = String(request.params.address).toLowerCase();
  if (!ADDRESS.test(address)) return fail(reply, 400, "Enter a token contract address");
  const meta = await tokenMeta(rt, address);
  if (!meta) return fail(reply, 404, "No ERC-20 token at this address");
  return { token: meta };
});

/** Read-only JSON-RPC per network for the web app, so browsers never see private RPC URLs. */
app.post("/api/rpc/:chainId", { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } }, async (request, reply) => {
  const rt = networkOr404(request.params.chainId, reply);
  if (!rt) return reply;
  const body = request.body;
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > 50) return fail(reply, 400, "Send 1 to 50 calls");
  for (const item of items) {
    if (!item || typeof item !== "object" || !READ_METHODS.has(item.method)) {
      return reply.code(403).send({ jsonrpc: "2.0", id: item?.id ?? null, error: { code: -32601, message: `${item?.method} is not allowed` } });
    }
  }
  return rt.rpc.post(body);
});

/* ---------- admin (the Console pushes networks, sources, tokens and branding here) ---------- */

app.get("/api/admin/settings", async () => ({ settings: getSettings() }));

app.put("/api/admin/settings", async (request) => ({ settings: saveSettings(request.body || {}) }));

/** Checks each network's RPC, wrapped coin, router and sources, for the Console's health view. */
app.get("/api/admin/status", async () => {
  const networks = await Promise.all(
    allRuntimes().map(async (rt) => {
      const n = rt.network;
      const started = Date.now();
      let chainId = null;
      let rpcError = "";
      try {
        chainId = Number(await rt.rpc.call("eth_chainId"));
      } catch (error) {
        rpcError = error.message;
      }
      const codes = await rt.rpc
        .batch(n.sources.map((s) => ["eth_getCode", [s.factory, "latest"]]))
        .catch(() => n.sources.map(() => ({ error: "unreachable" })));
      return {
        chainId: n.chainId,
        name: n.name,
        rpc: { ok: chainId === n.chainId, chainId, latencyMs: Date.now() - started, error: rpcError || undefined },
        router: await routerState(rt).catch(() => null),
        sources: n.sources.map((s, i) => ({ id: s.id, name: s.name, deployed: Boolean(codes[i]?.result && codes[i].result.length > 2) })),
        pools: rt.index.size(),
        multicall: await rt.reader.hasMulticall(),
      };
    })
  );
  return { networks };
});

const LOGO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

app.post("/api/admin/logo", async (request, reply) => {
  const match = /^data:([a-z+/]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(request.body?.dataUrl || ""));
  const ext = match && LOGO_TYPES[match[1]];
  if (!ext) return fail(reply, 400, "Upload a PNG, JPG, WEBP or SVG");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 1024 * 1024) return fail(reply, 400, "Logo must be under 1 MB");
  if (ext === "svg" && /<script|on\w+=/i.test(bytes.toString("utf8"))) return fail(reply, 400, "SVG cannot contain scripts");
  for (const file of readdirSync(BRANDING_DIR)) if (file.startsWith("logo.")) rmSync(join(BRANDING_DIR, file));
  writeFileSync(join(BRANDING_DIR, `logo.${ext}`), bytes);
  return { settings: saveSettings({ logoUrl: `/branding/logo.${ext}?v=${Date.now()}` }) };
});

app.get("/api/*", async (request, reply) => fail(reply, 404, "Not found"));

await app.register(fastifyStatic, { root: BRANDING_DIR, prefix: "/branding/", decorateReply: false });
await app.register(fastifyStatic, { root: ENV.webDir, prefix: "/", redirect: true });
app.setNotFoundHandler((request, reply) => reply.code(404).sendFile("404.html"));

await app.listen({ port: ENV.port, host: "0.0.0.0" });
app.log.info(`${getSettings().name} aggregator on :${ENV.port} with ${allRuntimes().length} network(s)`);
