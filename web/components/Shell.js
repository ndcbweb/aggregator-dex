"use client";

import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { AggProvider, NATIVE, useAgg, useBalances } from "@/lib/agg";
import { num, short } from "@/lib/format";
import { ChainLogo, Toasts } from "./ui";

function useOutside(ref, onOutside) {
  useEffect(() => {
    const handler = (event) => ref.current && !ref.current.contains(event.target) && onOutside();
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onOutside]);
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("agg-theme", next ? "dark" : "light");
    } catch {
      /* private mode */
    }
  };
  return (
    <button type="button" onClick={toggle} className="btn-ghost h-10 w-10 !rounded-2xl !p-0" aria-label="Toggle theme">
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function ChainSwitcher() {
  const { networks, network, selectNetwork } = useAgg();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false));
  if (!network) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-ghost h-10 !rounded-2xl" onClick={() => setOpen((v) => !v)}>
        <ChainLogo network={network} size={20} />
        <span className="hidden sm:inline">{network.name}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="card absolute right-0 top-full z-40 mt-2 w-64 p-2">
          <p className="label px-3 pb-1 pt-2">Select network</p>
          {networks.map((n) => (
            <button
              key={n.chainId}
              type="button"
              onClick={() => {
                selectNetwork(n.chainId);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${
                n.chainId === network.chainId ? "bg-black/5 dark:bg-white/5" : ""
              }`}
            >
              <ChainLogo network={n} size={22} />
              <span className="flex-1 font-medium">{n.name}</span>
              {n.nadcab ? <span className="chip !text-[10px]">Nadcab</span> : null}
              {!n.router?.deployed ? <span className="text-[10px] text-muted">soon</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WalletButton() {
  const { account, connect, disconnect, wrongNetwork, switchNetwork, hasWallet, network, tokens } = useAgg();
  const native = tokens.find((token) => token.address === NATIVE);
  const balances = useBalances(native ? [native] : []);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false));

  if (!account) {
    return (
      <div className="relative">
        <button
          type="button"
          className="btn-primary h-10"
          onClick={() => connect().catch((err) => setError(hasWallet ? err.message : "Install MetaMask or another browser wallet"))}
        >
          Connect wallet
        </button>
        {error ? <p className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-down px-3 py-2 text-xs text-white">{error}</p> : null}
      </div>
    );
  }
  if (wrongNetwork) {
    return (
      <button type="button" className="btn h-10 bg-down text-white" onClick={() => switchNetwork().catch((err) => setError(err.message))}>
        Switch to {network?.name}
      </button>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-ghost h-10 !rounded-2xl" onClick={() => setOpen((v) => !v)}>
        {balances[NATIVE] != null ? (
          <span className="hidden text-muted md:inline">
            {num(formatUnits(balances[NATIVE], 18))} {native?.symbol}
          </span>
        ) : null}
        <span className="h-2 w-2 rounded-full bg-up" />
        <span className="mono">{short(account)}</span>
      </button>
      {open ? (
        <div className="card absolute right-0 top-full z-40 mt-2 w-56 p-2">
          <button
            type="button"
            className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => {
              navigator.clipboard?.writeText(account);
              setOpen(false);
            }}
          >
            Copy address
          </button>
          <button
            type="button"
            className="w-full rounded-xl px-3 py-2 text-left text-sm text-down hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Brand() {
  const { config } = useAgg();
  const settings = config?.settings;
  return (
    <a href="/" className="flex shrink-0 items-center gap-2.5">
      {settings?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={settings.logoUrl} alt="" className="h-9 w-9 rounded-xl object-contain" />
      ) : (
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-base font-bold text-brand-ink">{(settings?.name || "S").slice(0, 1)}</span>
      )}
      <span className="hidden text-base font-semibold sm:block">{settings?.name || "Swap"}</span>
    </a>
  );
}

function Frame({ children }) {
  const { config, configError, network, explorerAddress } = useAgg();
  const settings = config?.settings;
  const router = network?.router;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/80 backdrop-blur dark:border-white/5 dark:bg-night/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Brand />
          <div className="flex-1" />
          <ChainSwitcher />
          <ThemeToggle />
          <WalletButton />
        </div>
      </header>
      {configError ? <div className="bg-down/15 px-4 py-2 text-center text-xs font-medium">Cannot reach the aggregator server: {configError}</div> : null}
      {config && !config.networks.length ? (
        <div className="bg-brand/15 px-4 py-2 text-center text-xs font-medium">No networks are enabled yet.</div>
      ) : null}
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      <footer className="border-t border-black/5 py-8 text-xs text-muted dark:border-white/5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4">
          <div>
            <p className="font-medium text-ink dark:text-white">{settings?.name}</p>
            {settings?.tagline ? <p className="mt-1">{settings.tagline}</p> : null}
            {config ? <p className="mt-1">Aggregating {config.networks.reduce((sum, n) => sum + n.sources.length, 0)} liquidity sources on {config.networks.length} networks</p> : null}
          </div>
          <div className="flex flex-wrap gap-4">
            {router?.deployed ? (
              explorerAddress(router.address) ? (
                <a href={explorerAddress(router.address)} target="_blank" rel="noreferrer" className="hover:underline">
                  Router on {network.name} {short(router.address)}
                </a>
              ) : (
                <span className="mono">Router {short(router.address)}</span>
              )
            ) : null}
            {Object.entries(settings?.links || {})
              .filter(([, url]) => url)
              .map(([key, url]) => (
                <a key={key} href={url} target="_blank" rel="noreferrer" className="capitalize hover:underline">
                  {key}
                </a>
              ))}
          </div>
        </div>
      </footer>
      <Toasts />
    </>
  );
}

export default function Shell({ children }) {
  return (
    <AggProvider>
      <Frame>{children}</Frame>
    </AggProvider>
  );
}
