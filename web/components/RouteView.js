"use client";

import { formatUnits } from "viem";
import { useAgg } from "@/lib/agg";
import { num } from "@/lib/format";
import { SourceDot, TokenLogo } from "./ui";

/** 1inch-style route: input token, one lane per split path with its share and hops, output token. */
export function RouteView({ quote, tokenIn, tokenOut }) {
  const { tokenByAddress, network } = useAgg();
  const symbolOf = (address) => {
    if (address === network?.wrappedNative) return tokenByAddress(address)?.symbol || `W${network.native.symbol}`;
    return tokenByAddress(address)?.symbol || `${address.slice(0, 6)}…`;
  };
  const tokenOf = (address) => tokenByAddress(address) || { symbol: symbolOf(address), address };

  return (
    <div className="flex items-stretch gap-2">
      <div className="flex flex-col items-center justify-center">
        <TokenLogo token={tokenIn} size={30} />
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-2 border-x-2 border-dashed border-black/10 px-2 py-1 dark:border-white/10">
        {quote.paths.map((path, i) => (
          <div key={i} className="flex min-w-0 items-center gap-2">
            <span className="w-11 shrink-0 rounded-lg bg-brand/12 py-1 text-center text-xs font-semibold text-brand">{path.shareBps / 100}%</span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {path.hops.map((hop, h) => (
                <div key={h} className="flex shrink-0 items-center gap-1">
                  {h > 0 ? <span className="text-muted">›</span> : null}
                  <div className="flex items-center gap-1.5 rounded-xl border border-black/5 bg-white px-2 py-1 text-xs dark:border-white/5 dark:bg-field">
                    <TokenLogo token={tokenOf(hop.tokenOut)} size={14} />
                    <span className="font-semibold">{symbolOf(hop.tokenOut)}</span>
                    <span className="flex items-center gap-1 text-muted">
                      <SourceDot id={hop.source} size={6} />
                      {hop.sourceName}
                      <span className="opacity-70">{hop.label}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col items-center justify-center">
        <TokenLogo token={tokenOut} size={30} />
      </div>
    </div>
  );
}

/** Our routed output next to the best single-DEX output on each source. */
export function SourceComparison({ quote, tokenOut }) {
  const best = quote.amountOutNet;
  const rows = [{ id: "agg", name: "This route", amountOut: best, ours: true }, ...quote.sources.slice(0, 6)];
  const top = rows.reduce((max, row) => (BigInt(row.amountOut) > max ? BigInt(row.amountOut) : max), 0n);
  return (
    <div className="space-y-1.5">
      {rows.map((row) => {
        const amount = BigInt(row.amountOut);
        const diff = top > 0n ? Number(((amount - BigInt(best)) * 1_000_000n) / (BigInt(best) || 1n)) / 10_000 : 0;
        return (
          <div key={row.id} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${row.ours ? "bg-brand/10" : ""}`}>
            {row.ours ? <span className="h-2 w-2 rounded-full bg-brand" /> : <SourceDot id={row.id} />}
            <span className={`flex-1 ${row.ours ? "font-semibold" : ""}`}>{row.name}</span>
            <span className="tabular-nums">
              {num(formatUnits(amount, tokenOut.decimals))} {tokenOut.symbol}
            </span>
            <span className={`w-16 text-right text-xs tabular-nums ${row.ours ? "text-brand" : diff < 0 ? "text-down" : "text-muted"}`}>
              {row.ours ? "best" : `${diff.toFixed(2)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
