import { formatUnits } from "viem";

/** Human number with sensible precision: 1,234.56 · 0.004812 · 1.2e-9. */
export function num(value, { max = 6 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1e-6) return n.toExponential(2);
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 2 : 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: max + 4 });
}

export function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) < 1000) return num(n);
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/** Value quoted in the native coin, shown in USD when a stablecoin price is known. */
export function money(nativeValue, nativeUsd, symbol) {
  if (nativeValue == null) return "–";
  if (nativeUsd) return `$${compact(nativeValue * nativeUsd)}`;
  return `${compact(nativeValue)} ${symbol}`;
}

export function units(raw, decimals, max = 6) {
  if (raw == null) return "–";
  return num(formatUnits(BigInt(raw), decimals), { max });
}

export function pct(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "–";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

export function short(address = "") {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

export function ago(time) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(time)));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Trims a decimal string to `decimals` places so parseUnits never throws on long inputs. */
export function clampDecimals(text, decimals) {
  const clean = String(text).replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const [whole, ...rest] = clean.split(".");
  if (!rest.length) return whole;
  return `${whole}.${rest.join("").slice(0, decimals)}`;
}
