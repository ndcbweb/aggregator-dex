"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { api } from "@/lib/api";
import { useAgg, useBalances } from "@/lib/agg";
import { num, short } from "@/lib/format";

const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
const hashColor = (text) => PALETTE[[...String(text)].reduce((sum, c) => sum + c.charCodeAt(0), 0) % PALETTE.length];

export function TokenLogo({ token, size = 28 }) {
  const [broken, setBroken] = useState(false);
  const symbol = token?.symbol || "?";
  if (token?.logoURI && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={token.logoURI} alt="" width={size} height={size} onError={() => setBroken(true)} className="shrink-0 rounded-full bg-white object-cover" style={{ width: size, height: size }} />
    );
  }
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-bold text-white" style={{ width: size, height: size, background: hashColor(symbol), fontSize: size * 0.38 }}>
      {symbol.slice(0, symbol.length > 3 ? 1 : 2)}
    </span>
  );
}

export function ChainLogo({ network, size = 22 }) {
  const [broken, setBroken] = useState(false);
  const label = network?.native?.symbol || network?.name || "?";
  if (network?.native?.logoURI && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={network.native.logoURI} alt="" onError={() => setBroken(true)} className="shrink-0 rounded-full bg-white object-cover" style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: network?.color || hashColor(network?.name || label), fontSize: size * 0.4 }}
    >
      {label.slice(0, 1)}
    </span>
  );
}

export function SourceDot({ id, size = 8 }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: hashColor(id) }} />;
}

export function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={`card w-full p-5 ${wide ? "max-w-xl" : "max-w-md"}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="btn-ghost h-8 w-8 !p-0" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function TokenSelect({ onSelect, onClose, exclude }) {
  const { tokens, importToken, chainId } = useAgg();
  const balances = useBalances(tokens);
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState({ status: "idle", token: null, error: "" });
  const trimmed = query.trim().toLowerCase();

  const list = useMemo(() => {
    const matches = tokens.filter(
      (token) => !trimmed || token.symbol.toLowerCase().includes(trimmed) || token.name.toLowerCase().includes(trimmed) || token.address === trimmed
    );
    return matches.sort((a, b) => {
      const ba = balances[a.address] ?? 0n;
      const bb = balances[b.address] ?? 0n;
      if (a.native !== b.native) return a.native ? -1 : 1;
      if ((ba > 0n) !== (bb > 0n)) return ba > 0n ? -1 : 1;
      return 0;
    });
  }, [tokens, trimmed, balances]);

  useEffect(() => {
    if (!/^0x[0-9a-f]{40}$/.test(trimmed) || tokens.some((token) => token.address === trimmed)) {
      setLookup({ status: "idle", token: null, error: "" });
      return undefined;
    }
    let alive = true;
    setLookup({ status: "loading", token: null, error: "" });
    api(`/token/${chainId}/${trimmed}`)
      .then((data) => alive && setLookup({ status: "found", token: data.token, error: "" }))
      .catch((error) => alive && setLookup({ status: "error", token: null, error: error.message }));
    return () => {
      alive = false;
    };
  }, [trimmed, tokens, chainId]);

  const bases = tokens.filter((t) => t.native || t.connector).slice(0, 6);

  return (
    <Modal title="Select a token" onClose={onClose}>
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search name, symbol or paste address"
        className="well h-11 w-full px-4 text-sm outline-none placeholder:text-muted focus:ring-2 focus:ring-brand/40"
        spellCheck={false}
      />
      {bases.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {bases.map((token) => (
            <button
              key={token.address}
              type="button"
              disabled={token.address === exclude}
              onClick={() => onSelect(token)}
              className="flex items-center gap-1.5 rounded-xl border border-black/10 px-2.5 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            >
              <TokenLogo token={token} size={18} />
              {token.symbol}
            </button>
          ))}
        </div>
      ) : null}
      <div className="-mx-2 mt-3 max-h-[52vh] overflow-y-auto">
        {lookup.status === "found" ? (
          <div className="mx-2 mb-2 rounded-2xl border border-brand/30 bg-brand/5 p-3">
            <div className="flex items-center gap-3">
              <TokenLogo token={lookup.token} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{lookup.token.symbol}</p>
                <p className="truncate text-xs text-muted">
                  {lookup.token.name} · {short(lookup.token.address)}
                </p>
              </div>
              <button
                type="button"
                className="btn-primary !rounded-xl !px-3 !py-1.5"
                onClick={() => {
                  importToken(lookup.token);
                  onSelect({ ...lookup.token, source: "imported" });
                }}
              >
                Import
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">Anyone can create a token with any name. Check the address before trading.</p>
          </div>
        ) : null}
        {lookup.status === "loading" ? <p className="px-4 py-3 text-sm text-muted">Looking up token…</p> : null}
        {lookup.status === "error" ? <p className="px-4 py-3 text-sm text-down">{lookup.error}</p> : null}
        {list.map((token) => {
          const balance = balances[token.address];
          return (
            <button
              key={token.address}
              type="button"
              disabled={token.address === exclude}
              onClick={() => onSelect(token)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
            >
              <TokenLogo token={token} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {token.symbol}
                  {token.source === "imported" ? <span className="chip ml-2 !text-[10px]">Imported</span> : null}
                </p>
                <p className="truncate text-xs text-muted">{token.name}</p>
              </div>
              {balance != null && balance > 0n ? <span className="text-sm tabular-nums">{num(formatUnits(balance, token.decimals))}</span> : null}
            </button>
          );
        })}
        {!list.length && lookup.status === "idle" ? <p className="px-4 py-6 text-center text-sm text-muted">No tokens found. Paste a contract address to import one.</p> : null}
      </div>
    </Modal>
  );
}

export function TokenButton({ token, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 shrink-0 items-center gap-2 rounded-full pl-1.5 pr-3 text-[15px] font-semibold transition ${
        token ? "bg-white shadow-sm hover:bg-black/5 dark:bg-field dark:hover:bg-white/10" : "bg-brand pl-4 text-brand-ink"
      }`}
    >
      {token ? <TokenLogo token={token} size={28} /> : null}
      {token ? token.symbol : "Select token"}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

export function AmountField({ label, token, value, onChange, onToken, balance, readOnly = false, onMax, loading = false, footer }) {
  return (
    <div className="well p-4">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {balance != null && token ? (
          <span className="flex items-center gap-2 text-xs text-muted">
            Balance: {num(formatUnits(balance, token.decimals))}
            {onMax && balance > 0n ? (
              <button type="button" className="font-semibold text-brand" onClick={onMax}>
                Max
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange?.(event.target.value)}
          inputMode="decimal"
          placeholder="0"
          className={`min-w-0 flex-1 bg-transparent text-3xl font-medium tabular-nums outline-none placeholder:text-muted/60 ${loading ? "animate-pulse opacity-60" : ""}`}
        />
        <TokenButton token={token} onClick={onToken} />
      </div>
      <div className="mt-1 h-4 text-xs text-muted">{footer}</div>
    </div>
  );
}

export function SettingsModal({ onClose }) {
  const { slippageBps, deadlineMin, savePrefs, network, excludedSources, toggleSource } = useAgg();
  const [custom, setCustom] = useState("");
  return (
    <Modal title="Swap settings" onClose={onClose}>
      <p className="label mb-2">Max slippage</p>
      <div className="flex gap-2">
        {[10, 50, 100].map((bps) => (
          <button
            key={bps}
            type="button"
            className={`btn !rounded-xl !py-2 ${slippageBps === bps ? "bg-brand text-brand-ink" : "bg-black/5 dark:bg-white/5"}`}
            onClick={() => savePrefs({ slippageBps: bps })}
          >
            {bps / 100}%
          </button>
        ))}
        <input
          value={custom}
          onChange={(event) => {
            setCustom(event.target.value);
            const bps = Math.round(Number(event.target.value) * 100);
            if (bps >= 1 && bps <= 5000) savePrefs({ slippageBps: bps });
          }}
          placeholder={`${slippageBps / 100}%`}
          className="well h-10 w-24 px-3 text-sm outline-none"
          inputMode="decimal"
        />
      </div>
      {slippageBps > 500 ? <p className="mt-2 text-xs text-down">High slippage: your trade may be front-run.</p> : null}
      <p className="label mb-2 mt-5">Transaction deadline</p>
      <div className="flex items-center gap-2">
        <input
          value={deadlineMin}
          onChange={(event) => savePrefs({ deadlineMin: Math.max(1, Math.min(180, Number(event.target.value) || 20)) })}
          className="well h-10 w-24 px-3 text-sm outline-none"
          inputMode="numeric"
        />
        <span className="text-sm text-muted">minutes</span>
      </div>
      {network?.sources.length ? (
        <>
          <p className="label mb-2 mt-5">
            Liquidity sources on {network.name} · {network.sources.length - excludedSources.length} of {network.sources.length} on
          </p>
          <div className="-mx-1 max-h-60 overflow-y-auto">
            {network.sources.map((source) => {
              const on = !excludedSources.includes(source.id);
              return (
                <label key={source.id} className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-black/5 dark:hover:bg-white/5">
                  <SourceDot id={source.id} size={10} />
                  <span className="flex-1 text-sm">{source.name}</span>
                  <span className="text-[11px] uppercase tracking-wide text-muted">{source.kind}</span>
                  <input type="checkbox" checked={on} onChange={() => toggleSource(source.id)} className="h-4 w-4 accent-[var(--brand)]" />
                </label>
              );
            })}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

export function Toasts() {
  const { toasts, explorerTx } = useAgg();
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="card flex items-start gap-3 p-4 text-sm">
          <span
            className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
              toast.status === "success" ? "bg-up" : toast.status === "failed" ? "bg-down" : "animate-pulse bg-brand"
            }`}
          />
          <div className="min-w-0">
            <p className="font-semibold">{toast.label}</p>
            <p className="text-xs text-muted">
              {toast.status === "wallet" ? "Confirm in your wallet" : toast.status === "pending" ? "Waiting for confirmation…" : toast.status === "success" ? "Confirmed" : "Failed"}
            </p>
            {toast.hash && explorerTx(toast.hash, toast.chainId) ? (
              <a href={explorerTx(toast.hash, toast.chainId)} target="_blank" rel="noreferrer" className="link text-xs">
                View transaction ↗
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Ring that empties over `total` ms, for the quote refresh timer. */
export function CountdownRing({ started, total, size = 18 }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, 1 - (now - started) / total);
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" className="-rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.2" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeDasharray={c} strokeDashoffset={c * (1 - left)} strokeLinecap="round" />
    </svg>
  );
}
