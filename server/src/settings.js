import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV } from "./config.js";

const FILE = join(ENV.dataDir, "settings.json");
export const BRANDING_DIR = join(ENV.dataDir, "branding");
mkdirSync(BRANDING_DIR, { recursive: true });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOURCE_KINDS = new Set(["v2", "v2-dynamic", "solidly", "v3", "slipstream", "algebra"]);
const MAX_NETWORKS = 12;
const text = (value, max) => String(value ?? "").replace(/[\r\n<>]+/g, " ").trim().slice(0, max);
const address = (value) => (ADDRESS.test(String(value || "").trim()) ? String(value).trim().toLowerCase() : "");
const int = (value, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const url = (value, { allowBranding = false } = {}) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (allowBranding && raw.startsWith("/branding/")) return raw.slice(0, 200);
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString().replace(/\/+$/, "").slice(0, 500) : "";
  } catch {
    return "";
  }
};

function sanitizeSource(input) {
  const kind = String(input?.kind || "");
  const factory = address(input?.factory);
  if (!SOURCE_KINDS.has(kind) || !factory) return null;
  const source = {
    id: text(input.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, "-") || `custom-${factory.slice(2, 8)}`,
    name: text(input.name, 40) || "Custom DEX",
    kind,
    factory,
  };
  if (kind === "v2") {
    const fee = int(input.fee, 0, 100_000);
    if (fee === null) return null;
    source.fee = fee;
  }
  if (kind === "v3") {
    source.fees = [...new Set((Array.isArray(input.fees) ? input.fees : []).map((f) => int(f, 1, 1_000_000)).filter((f) => f !== null))].slice(0, 8);
    if (!source.fees.length) return null;
  }
  if (kind === "slipstream") {
    source.tickSpacings = [...new Set((Array.isArray(input.tickSpacings) ? input.tickSpacings : []).map((t) => int(t, 1, 100_000)).filter((t) => t !== null))].slice(0, 8);
    if (!source.tickSpacings.length) return null;
  }
  return source;
}

function sanitizeToken(input) {
  const token = address(input?.address);
  const decimals = int(input?.decimals, 0, 36);
  if (!token || decimals === null) return null;
  return {
    address: token,
    symbol: text(input.symbol, 16) || "TOKEN",
    name: text(input.name, 60) || text(input.symbol, 16) || "Token",
    decimals,
    logoURI: url(input.logoURI),
    connector: Boolean(input.connector),
  };
}

function sanitizeNetwork(input) {
  const chainId = int(input?.chainId, 1, 2 ** 53 - 1);
  const rpcUrl = url(input?.rpcUrl);
  const wrappedNative = address(input?.wrappedNative);
  if (!chainId || !rpcUrl || !wrappedNative) return null;
  const sources = [];
  for (const raw of Array.isArray(input.sources) ? input.sources : []) {
    const source = sanitizeSource(raw);
    if (source && !sources.some((s) => s.id === source.id)) sources.push(source);
    if (sources.length >= 24) break;
  }
  const tokens = [];
  for (const raw of Array.isArray(input.tokens) ? input.tokens : []) {
    const token = sanitizeToken(raw);
    if (token && !tokens.some((t) => t.address === token.address)) tokens.push(token);
    if (tokens.length >= 300) break;
  }
  return {
    chainId,
    key: text(input.key, 24).toLowerCase().replace(/[^a-z0-9-]/g, "") || `chain-${chainId}`,
    name: text(input.name, 40) || `Chain ${chainId}`,
    native: {
      symbol: text(input.native?.symbol, 12) || "ETH",
      name: text(input.native?.name, 40) || text(input.native?.symbol, 12) || "Ether",
      decimals: 18,
      logoURI: url(input.native?.logoURI),
    },
    rpcUrl,
    publicRpcUrl: url(input.publicRpcUrl) || "",
    explorerUrl: url(input.explorerUrl),
    wrappedNative,
    router: address(input.router),
    color: /^#[0-9a-fA-F]{6}$/.test(String(input.color || "")) ? input.color : "",
    nadcab: Boolean(input.nadcab),
    sources,
    tokens,
  };
}

/** Normalises settings pushed by the Console or an admin; unknown keys are dropped. */
export function sanitizeSettings(input = {}) {
  const networks = [];
  for (const raw of Array.isArray(input.networks) ? input.networks : []) {
    const network = sanitizeNetwork(raw);
    if (network && !networks.some((n) => n.chainId === network.chainId)) networks.push(network);
    if (networks.length >= MAX_NETWORKS) break;
  }
  const slippage = int(input.defaultSlippageBps, 1, 5000);
  const defaultChainId = int(input.defaultChainId, 1, 2 ** 53 - 1);
  return {
    name: text(input.name, 40) || "Nadcab Aggregator",
    tagline: text(input.tagline, 120),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(String(input.brandColor || "")) ? input.brandColor : "#1163fb",
    defaultTheme: input.defaultTheme === "light" ? "light" : "dark",
    logoUrl: url(input.logoUrl, { allowBranding: true }),
    defaultSlippageBps: slippage ?? 50,
    defaultChainId: networks.some((n) => n.chainId === defaultChainId) ? defaultChainId : networks[0]?.chainId || null,
    maxHops: int(input.maxHops, 1, 3) ?? 3,
    maxSplits: int(input.maxSplits, 1, 6) ?? 5,
    links: {
      website: url(input.links?.website),
      twitter: url(input.links?.twitter),
      telegram: url(input.links?.telegram),
      docs: url(input.links?.docs),
    },
    networks,
  };
}

let cached = null;
const listeners = new Set();

export function onSettingsChange(listener) {
  listeners.add(listener);
}

function readFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function getSettings() {
  if (cached) return cached;
  const raw = existsSync(FILE) ? readFile(FILE) : ENV.seedFile ? readFile(ENV.seedFile) : null;
  cached = sanitizeSettings(raw || {});
  return cached;
}

export function saveSettings(input) {
  const next = sanitizeSettings({ ...getSettings(), ...input });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
  cached = next;
  for (const listener of listeners) listener(next);
  return next;
}
