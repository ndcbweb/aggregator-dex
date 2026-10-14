"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, maxUint256, parseUnits } from "viem";
import { RouteView, SourceComparison } from "@/components/RouteView";
import { AmountField, CountdownRing, SettingsModal, Spinner, TokenSelect } from "@/components/ui";
import { api } from "@/lib/api";
import { ERC20, NATIVE, ROUTER, WNATIVE, deadline, useAgg, useBalances } from "@/lib/agg";
import { clampDecimals, num, pct } from "@/lib/format";

const REFRESH_MS = 15_000;

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function safeParse(text, decimals) {
  try {
    const value = parseUnits(text || "0", decimals);
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

const big = (value) => BigInt(value ?? 0);

function SwapCard() {
  const agg = useAgg();
  const { network, chainId, tokens, tokenByAddress, publicClient, account, send, slippageBps, deadlineMin, refreshKey, excludedSources, wrongNetwork } = agg;
  const [tokenIn, setTokenIn] = useState(null);
  const [tokenOut, setTokenOut] = useState(null);
  const [typed, setTyped] = useState("");
  const [picker, setPicker] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quote, setQuote] = useState({ status: "idle" });
  const [tick, setTick] = useState(0);
  const [allowance, setAllowance] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [impactAck, setImpactAck] = useState(false);
  const [invert, setInvert] = useState(false);
  const [tab, setTab] = useState("route");

  // Fresh pair whenever the network changes: coin → first listed token, unless the link names a pair (?in=&out=&amount=).
  useEffect(() => {
    if (!network || !tokens.length) return;
    const params = new URLSearchParams(window.location.search);
    const fromLink = (key) => {
      const raw = (params.get(key) || "").toLowerCase();
      return raw ? tokenByAddress(raw === "native" ? NATIVE : raw) : null;
    };
    const linkIn = fromLink("in");
    const linkOut = fromLink("out");
    const first = !tokenIn;
    const nextIn = (first && linkIn) || tokenByAddress(NATIVE);
    const nextOut = (first && linkOut && linkOut.address !== nextIn.address && linkOut) || tokens.find((t) => !t.native && t.address !== network.wrappedNative && t.address !== nextIn.address) || null;
    setTokenIn(nextIn);
    setTokenOut(nextOut);
    setTyped(first && params.get("amount") ? clampDecimals(params.get("amount"), nextIn.decimals) : "");
    setQuote({ status: "idle" });
  }, [chainId, tokens.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const balances = useBalances([tokenIn, tokenOut]);
  const debouncedTyped = useDebounced(typed, 350);
  const router = network?.router;
  const wnative = network?.wrappedNative;
  const wrapMode =
    tokenIn && tokenOut && ((tokenIn.native && tokenOut.address === wnative) || (tokenIn.address === wnative && tokenOut.native)) ? (tokenIn.native ? "wrap" : "unwrap") : "";
  const amountIn = tokenIn ? safeParse(debouncedTyped, tokenIn.decimals) : 0n;

  useEffect(() => {
    if (!tokenIn || !tokenOut || !amountIn || !network) {
      setQuote({ status: "idle" });
      return undefined;
    }
    if (wrapMode) {
      setQuote({ status: "ok", wrap: true, amountIn, amountOut: amountIn, amountOutNet: amountIn, at: Date.now() });
      return undefined;
    }
    let alive = true;
    setQuote((prev) => ({ ...prev, status: prev.status === "ok" ? "refreshing" : "loading" }));
    const params = new URLSearchParams({
      chainId: String(network.chainId),
      tokenIn: tokenIn.native ? "native" : tokenIn.address,
      tokenOut: tokenOut.native ? "native" : tokenOut.address,
      amount: amountIn.toString(),
    });
    if (excludedSources.length) params.set("exclude", excludedSources.join(","));
    api(`/quote?${params}`)
      .then((data) => alive && setQuote({ status: "ok", ...data, at: Date.now() }))
      .catch((err) => alive && setQuote({ status: /no liquidity/i.test(err.message) ? "none" : "error", error: err.message }));
    return () => {
      alive = false;
    };
  }, [tokenIn, tokenOut, amountIn, network, wrapMode, excludedSources, tick, refreshKey]);

  // Requote every 15 s while a quote is on screen, like 1inch's refresh ring.
  useEffect(() => {
    if (quote.status !== "ok" || quote.wrap) return undefined;
    const timer = setTimeout(() => document.visibilityState === "visible" && setTick((t) => t + 1), REFRESH_MS);
    return () => clearTimeout(timer);
  }, [quote]);

  useEffect(() => setImpactAck(false), [quote.amountOut]);

  useEffect(() => {
    if (!tokenIn || tokenIn.native || !account || !publicClient || wrapMode || !router?.deployed) {
      setAllowance(null);
      return;
    }
    publicClient
      .readContract({ address: tokenIn.address, abi: ERC20, functionName: "allowance", args: [account, router.address] })
      .then(setAllowance)
      .catch(() => setAllowance(null));
  }, [tokenIn, account, publicClient, router, wrapMode, refreshKey]);

  const ok = quote.status === "ok" || quote.status === "refreshing";
  const typedRaw = tokenIn ? safeParse(typed, tokenIn.decimals) : 0n;
  const stale = typedRaw !== amountIn;
  const amountOutNet = ok ? big(quote.amountOutNet) : 0n;
  const minReturn = ok ? (amountOutNet * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  const balanceIn = tokenIn ? balances[tokenIn.address] : null;
  const insufficient = balanceIn != null && typedRaw > balanceIn;
  const needsApproval = !wrapMode && tokenIn && !tokenIn.native && allowance != null && typedRaw > 0n && allowance < typedRaw;
  const impact = ok && !quote.wrap ? quote.priceImpact : null;
  const highImpact = impact != null && impact > 0.05;
  const extreme = impact != null && impact > 0.15;
  const savings = ok && !quote.wrap ? big(quote.amountOut) - big(quote.bestSingle?.amountOut) : 0n;
  const gasCost = ok && quote.gas ? big(quote.gas) * big(quote.gasPrice) : null;

  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    if (ok && tokenOut) setTyped(clampDecimals(formatUnits(amountOutNet, tokenOut.decimals), 8));
  };

  const pick = (token) => {
    if (picker === "in") {
      if (tokenOut?.address === token.address) setTokenOut(tokenIn);
      setTokenIn(token);
    } else {
      if (tokenIn?.address === token.address) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setPicker(null);
  };

  const approve = useCallback(async () => {
    setBusy("approve");
    setError("");
    try {
      await send(`Approve ${tokenIn.symbol}`, (wallet, from) =>
        wallet.writeContract({ address: tokenIn.address, abi: ERC20, functionName: "approve", args: [router.address, maxUint256], account: from })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }, [send, tokenIn, router]);

  async function swap() {
    setBusy("swap");
    setError("");
    try {
      if (wrapMode) {
        await send(`${wrapMode === "wrap" ? "Wrap" : "Unwrap"} ${num(typed)} ${tokenIn.symbol}`, (wallet, from) =>
          wrapMode === "wrap"
            ? wallet.writeContract({ address: wnative, abi: WNATIVE, functionName: "deposit", value: amountIn, account: from })
            : wallet.writeContract({ address: wnative, abi: WNATIVE, functionName: "withdraw", args: [amountIn], account: from })
        );
      } else {
        const label = `Swap ${num(formatUnits(amountIn, tokenIn.decimals))} ${tokenIn.symbol} for ${num(formatUnits(amountOutNet, tokenOut.decimals))} ${tokenOut.symbol}`;
        await send(label, (wallet, from) =>
          wallet.writeContract({
            address: router.address,
            abi: ROUTER,
            functionName: "swap",
            account: from,
            value: tokenIn.native ? amountIn : 0n,
            args: [
              {
                tokenIn: tokenIn.native ? NATIVE : tokenIn.address,
                tokenOut: tokenOut.native ? NATIVE : tokenOut.address,
                amountIn,
                minReturn,
                quotedOut: big(quote.amountOut),
                recipient: from,
                deadline: deadline(deadlineMin),
              },
              quote.paths.map((path) => ({
                shareBps: path.shareBps,
                hops: path.hops.map((hop) => ({ kind: hop.kind, pool: hop.pool, tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, fee: hop.fee })),
              })),
            ],
          })
        );
      }
      setTyped("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  let action = { label: "Swap", onClick: swap };
  if (!router?.deployed && !wrapMode) action = { label: `Swaps on ${network?.name} open soon`, disabled: true };
  else if (router?.paused && !wrapMode) action = { label: "Swaps are paused", disabled: true };
  else if (!account) action = { label: "Connect wallet", onClick: () => agg.connect().catch((err) => setError(err.message)) };
  else if (wrongNetwork) action = { label: `Switch to ${network.name}`, onClick: () => agg.switchNetwork().catch((err) => setError(err.message)) };
  else if (!tokenIn || !tokenOut) action = { label: "Select a token", disabled: true };
  else if (!typed || !typedRaw) action = { label: "Enter an amount", disabled: true };
  else if (quote.status === "loading" || stale) action = { label: "Finding the best route…", disabled: true };
  else if (quote.status === "none") action = { label: "No liquidity for this pair", disabled: true };
  else if (!ok) action = { label: quote.error || "Enter an amount", disabled: true };
  else if (insufficient) action = { label: `Insufficient ${tokenIn.symbol} balance`, disabled: true };
  else if (needsApproval) action = { label: `Approve ${tokenIn.symbol}`, onClick: approve };
  else if (extreme && !impactAck) action = { label: "Price impact too high", disabled: true };
  else if (highImpact) action = { label: "Swap anyway", onClick: swap, danger: true };
  else if (wrapMode) action = { label: wrapMode === "wrap" ? "Wrap" : "Unwrap", onClick: swap };

  const rate = ok && amountIn > 0n && tokenOut ? Number(formatUnits(amountOutNet, tokenOut.decimals)) / Number(formatUnits(amountIn, tokenIn.decimals)) : null;
  const hopCount = ok && quote.paths ? quote.paths.reduce((sum, p) => sum + p.hops.length, 0) : 0;

  return (
    <div className="mx-auto grid w-full max-w-5xl items-start gap-6 lg:grid-cols-[460px_1fr]">
      <div className="card p-3">
        <div className="flex items-center justify-between px-2 pb-3 pt-1">
          <h1 className="text-lg font-semibold">Swap</h1>
          <div className="flex items-center gap-2">
            {ok && !quote.wrap ? (
              <button type="button" className="btn-ghost h-9 !rounded-xl" onClick={() => setTick((t) => t + 1)} title="Refresh quote">
                {quote.status === "refreshing" ? <Spinner size={16} /> : <CountdownRing started={quote.at} total={REFRESH_MS} />}
              </button>
            ) : null}
            <button type="button" className="btn-ghost h-9 gap-1.5 !rounded-xl" onClick={() => setSettingsOpen(true)}>
              <span className="text-xs text-muted">{slippageBps / 100}%</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
              </svg>
            </button>
          </div>
        </div>

        <AmountField
          label="You pay"
          token={tokenIn}
          value={typed}
          onChange={(value) => setTyped(clampDecimals(value, tokenIn?.decimals ?? 18))}
          onToken={() => setPicker("in")}
          balance={balanceIn}
          onMax={() => {
            if (balanceIn == null) return;
            const reserve = tokenIn.native ? parseUnits("0.01", 18) : 0n;
            setTyped(formatUnits(balanceIn > reserve ? balanceIn - reserve : 0n, tokenIn.decimals));
          }}
        />
        <div className="relative z-10 -my-3 flex justify-center">
          <button type="button" onClick={flip} className="grid h-10 w-10 place-items-center rounded-xl border-4 border-white bg-black/5 transition hover:rotate-180 dark:border-panel dark:bg-field" aria-label="Flip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        </div>
        <AmountField
          label="You receive"
          token={tokenOut}
          value={ok && tokenOut && !stale ? clampDecimals(formatUnits(amountOutNet, tokenOut.decimals), 8) : ""}
          readOnly
          loading={quote.status === "loading" || (stale && Boolean(typed))}
          onToken={() => setPicker("out")}
          balance={tokenOut ? balances[tokenOut.address] : null}
          footer={savings > 0n && tokenOut ? <span className="text-up">+{num(formatUnits(savings, tokenOut.decimals))} {tokenOut.symbol} vs best single DEX</span> : null}
        />

        {ok && rate != null && !quote.wrap ? (
          <div className="mt-3 space-y-2 rounded-2xl border border-black/5 px-4 py-3 text-sm dark:border-white/5">
            <button type="button" className="flex w-full justify-between font-medium" onClick={() => setInvert((v) => !v)}>
              <span>
                1 {invert ? tokenOut.symbol : tokenIn.symbol} = {num(invert ? 1 / rate : rate)} {invert ? tokenIn.symbol : tokenOut.symbol}
              </span>
              <span className="text-xs text-muted">
                {quote.paths.length > 1 ? `${quote.paths.length} splits · ` : ""}
                {hopCount} hops
              </span>
            </button>
            <Row label="Price impact" value={impact == null ? "–" : impact < 0.0001 ? "<0.01%" : pct(-impact)} tone={highImpact ? "down" : ""} />
            <Row label={`Minimum received (${slippageBps / 100}% slippage)`} value={`${num(formatUnits(minReturn, tokenOut.decimals))} ${tokenOut.symbol}`} />
            {quote.feeBps > 0 ? <Row label={`Platform fee (${quote.feeBps / 100}%)`} value={`${num(formatUnits(big(quote.fee), tokenOut.decimals))} ${tokenOut.symbol}`} /> : null}
            {gasCost != null ? <Row label="Network cost (est.)" value={`${num(formatUnits(gasCost, 18))} ${network.native.symbol}`} /> : null}
          </div>
        ) : null}

        {extreme ? (
          <label className="mt-3 flex items-start gap-2 rounded-2xl bg-down/10 px-4 py-3 text-xs text-down">
            <input type="checkbox" checked={impactAck} onChange={(event) => setImpactAck(event.target.checked)} className="mt-0.5" />
            This trade moves the price by {pct(impact)}. I understand I may receive much less.
          </label>
        ) : null}

        <button
          type="button"
          className={`mt-3 h-14 w-full text-base ${action.danger ? "btn bg-down text-white" : "btn-primary"}`}
          disabled={action.disabled || Boolean(busy)}
          onClick={action.onClick}
        >
          {busy ? <Spinner /> : null}
          {busy === "approve" ? `Approving ${tokenIn.symbol}…` : busy === "swap" ? "Swapping…" : action.label}
        </button>
        {error ? <p className="mt-3 break-words px-2 text-sm text-down">{error}</p> : null}
        {quote.status === "error" && !error ? <p className="mt-3 px-2 text-sm text-down">{quote.error}</p> : null}
      </div>

      <div className="card min-h-[320px] p-5">
        {ok && !quote.wrap && tokenOut ? (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div className="inline-flex gap-1 rounded-2xl bg-black/5 p-1 dark:bg-white/5">
                {[
                  ["route", "Route"],
                  ["compare", "Compare DEXes"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`rounded-xl px-3.5 py-1.5 text-sm font-medium transition ${tab === id ? "bg-white shadow-sm dark:bg-field" : "text-muted"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted">Best of {quote.candidates} routes</span>
            </div>
            {tab === "route" ? <RouteView quote={quote} tokenIn={tokenIn} tokenOut={tokenOut} /> : <SourceComparison quote={quote} tokenOut={tokenOut} />}
          </>
        ) : (
          <div className="grid h-full min-h-[280px] place-items-center text-center">
            <div>
              <p className="text-base font-semibold">Best price across {network?.sources.length || 0} DEXes</p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
                Enter an amount and the router splits your trade across {network?.sources.map((s) => s.name).slice(0, 4).join(", ")}
                {network?.sources.length > 4 ? " and more" : ""} to get you the most {tokenOut?.symbol || "tokens"}.
              </p>
            </div>
          </div>
        )}
      </div>

      {picker ? <TokenSelect onSelect={pick} onClose={() => setPicker(null)} exclude={picker === "in" ? tokenIn?.address : tokenOut?.address} /> : null}
      {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

function Row({ label, value, tone }) {
  return (
    <div className="flex justify-between gap-4 text-muted">
      <span>{label}</span>
      <span className={`text-right ${tone === "down" ? "text-down" : "text-ink dark:text-white"}`}>{value}</span>
    </div>
  );
}

export default function SwapPage() {
  const { config, network } = useAgg();
  const ready = useMemo(() => Boolean(config && network), [config, network]);
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  if (!ready) return <p className="py-20 text-center text-muted">No networks are enabled yet.</p>;
  return <SwapCard />;
}
