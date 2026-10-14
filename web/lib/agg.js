"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { api } from "./api";

export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);
export const WNATIVE = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);
export const ROUTER = parseAbi([
  "struct Hop { uint8 kind; address pool; address tokenIn; address tokenOut; uint32 fee; }",
  "struct Path { uint16 shareBps; Hop[] hops; }",
  "struct SwapParams { address tokenIn; address tokenOut; uint256 amountIn; uint256 minReturn; uint256 quotedOut; address recipient; uint256 deadline; }",
  "function swap(SwapParams p, Path[] paths) payable returns (uint256 amountOut)",
]);

const Ctx = createContext(null);
export const useAgg = () => useContext(Ctx);

const lower = (value) => String(value || "").toLowerCase();

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

function contrastInk(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#111318" : "#ffffff";
}

export function AggProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [chainId, setChainId] = useState(null);
  const [account, setAccount] = useState("");
  const [walletChainId, setWalletChainId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [prefs, setPrefs] = useState({ slippageBps: null, deadlineMin: 20 });
  const [imported, setImported] = useState({});
  const [excluded, setExcluded] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api("/config"));
      setConfigError("");
    } catch (error) {
      setConfigError(error.message);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    const timer = setInterval(loadConfig, 60_000);
    return () => clearInterval(timer);
  }, [loadConfig]);

  useEffect(() => {
    setPrefs((prev) => ({ ...prev, ...readJson("agg:prefs", {}) }));
    setImported(readJson("agg:imported", {}));
    setExcluded(readJson("agg:excluded", {}));
  }, []);

  // The network comes from ?chain=, then the last one used, then the operator's default.
  useEffect(() => {
    if (!config || chainId) return;
    const ids = config.networks.map((n) => n.chainId);
    const fromUrl = Number(new URLSearchParams(window.location.search).get("chain"));
    const remembered = Number(readJson("agg:chain", 0));
    setChainId([fromUrl, remembered, config.settings.defaultChainId, ids[0]].find((id) => ids.includes(id)) || null);
  }, [config, chainId]);

  useEffect(() => {
    const settings = config?.settings;
    if (!settings) return;
    const root = document.documentElement;
    root.style.setProperty("--brand", settings.brandColor);
    root.style.setProperty("--brand-ink", contrastInk(settings.brandColor));
    document.title = `${settings.name} · Swap`;
    try {
      if (!localStorage.getItem("agg-theme")) root.classList.toggle("dark", settings.defaultTheme !== "light");
    } catch {
      /* private mode */
    }
  }, [config?.settings]);

  const network = useMemo(() => config?.networks.find((n) => n.chainId === chainId) || null, [config, chainId]);

  const selectNetwork = useCallback((id) => {
    setChainId(id);
    writeJson("agg:chain", id);
    const url = new URL(window.location.href);
    url.searchParams.set("chain", String(id));
    window.history.replaceState(null, "", url);
  }, []);

  const viemChain = useMemo(() => {
    if (!network) return null;
    return {
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: network.native.name, symbol: network.native.symbol, decimals: 18 },
      rpcUrls: { default: { http: [network.publicRpcUrl || `${window.location.origin}/api/rpc/${network.chainId}`] } },
      blockExplorers: network.explorerUrl ? { default: { name: "Explorer", url: network.explorerUrl } } : undefined,
    };
  }, [network]);

  const publicClient = useMemo(() => {
    if (!viemChain || typeof window === "undefined") return null;
    return createPublicClient({
      chain: viemChain,
      transport: http(`${window.location.origin}/api/rpc/${viemChain.id}`, { batch: { wait: 16, batchSize: 50 } }),
    });
  }, [viemChain]);

  /* ---------- wallet ---------- */

  useEffect(() => {
    if (!hasWallet) return undefined;
    const eth = window.ethereum;
    const onAccounts = (accounts) => setAccount(lower(accounts?.[0]));
    const onChain = (id) => setWalletChainId(Number(id));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    if (readJson("agg:connected", false)) eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet]);

  const connect = useCallback(async () => {
    if (!window.ethereum) throw new Error("Install MetaMask or another browser wallet to continue");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    setAccount(lower(accounts?.[0]));
    writeJson("agg:connected", true);
    return lower(accounts?.[0]);
  }, []);

  const disconnect = useCallback(() => {
    setAccount("");
    writeJson("agg:connected", false);
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum || !network) return;
    const hexId = `0x${network.chainId.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (error) {
      if (error?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(error?.message || "")) throw error;
      if (!network.publicRpcUrl) throw new Error(`Add ${network.name} to your wallet first`);
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: network.name,
            nativeCurrency: { name: network.native.name, symbol: network.native.symbol, decimals: 18 },
            rpcUrls: [network.publicRpcUrl],
            ...(network.explorerUrl ? { blockExplorerUrls: [network.explorerUrl] } : {}),
          },
        ],
      });
    }
    setWalletChainId(network.chainId);
  }, [network]);

  const wrongNetwork = Boolean(account && walletChainId && chainId && walletChainId !== chainId);

  /* ---------- transactions ---------- */

  const pushToast = useCallback((toast) => {
    setToasts((rows) => [...rows.filter((row) => row.id !== toast.id), toast].slice(-4));
    if (toast.status !== "pending" && toast.status !== "wallet") setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== toast.id)), 9000);
  }, []);

  /** Runs a wallet write: connects, switches network, sends with a gas margin, waits for the receipt and reports. */
  const send = useCallback(
    async (label, write) => {
      const from = account || (await connect());
      if (Number(await window.ethereum.request({ method: "eth_chainId" })) !== chainId) await switchNetwork();
      const client = createWalletClient({ account: from, chain: viemChain, transport: custom(window.ethereum) });
      const wallet = {
        writeContract: async (request) => {
          if (request.gas) return client.writeContract(request);
          const gas = await publicClient.estimateContractGas(request);
          return client.writeContract({ ...request, gas: (gas * 125n) / 100n });
        },
      };
      const id = `${Date.now()}-${Math.random()}`;
      pushToast({ id, label, status: "wallet", chainId });
      let hash;
      try {
        hash = await write(wallet, from);
      } catch (error) {
        setToasts((rows) => rows.filter((row) => row.id !== id));
        throw new Error(error?.shortMessage || error?.details || error?.message || "Transaction cancelled");
      }
      pushToast({ id, label, status: "pending", hash, chainId });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 300_000 });
      pushToast({ id, label, status: receipt.status === "success" ? "success" : "failed", hash, chainId });
      setRefreshKey((key) => key + 1);
      if (receipt.status !== "success") throw new Error(`${label} failed on-chain`);
      return receipt;
    },
    [account, chainId, connect, publicClient, pushToast, switchNetwork, viemChain]
  );

  /* ---------- tokens, preferences ---------- */

  const tokens = useMemo(() => {
    if (!network) return [];
    const map = new Map();
    map.set(NATIVE, { address: NATIVE, native: true, ...network.native, logoURI: network.native.logoURI || "" });
    for (const token of network.tokens) map.set(lower(token.address), { ...token, address: lower(token.address), source: "list" });
    for (const token of imported[network.chainId] || []) {
      if (!map.has(lower(token.address))) map.set(lower(token.address), { ...token, address: lower(token.address), source: "imported" });
    }
    return [...map.values()];
  }, [network, imported]);

  const importToken = useCallback(
    (token) => {
      setImported((prev) => {
        const list = [...(prev[chainId] || []).filter((t) => lower(t.address) !== lower(token.address)), token].slice(-100);
        const next = { ...prev, [chainId]: list };
        writeJson("agg:imported", next);
        return next;
      });
    },
    [chainId]
  );

  const savePrefs = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      writeJson("agg:prefs", next);
      return next;
    });
  }, []);

  const excludedSources = useMemo(() => excluded[chainId] || [], [excluded, chainId]);
  const toggleSource = useCallback(
    (id) => {
      setExcluded((prev) => {
        const list = prev[chainId] || [];
        const next = { ...prev, [chainId]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
        writeJson("agg:excluded", next);
        return next;
      });
    },
    [chainId]
  );

  const tokenByAddress = useCallback((address) => tokens.find((token) => token.address === lower(address)) || null, [tokens]);
  const explorerTx = useCallback(
    (hash, id = chainId) => {
      const net = config?.networks.find((n) => n.chainId === id);
      return net?.explorerUrl ? `${net.explorerUrl}/tx/${hash}` : "";
    },
    [config, chainId]
  );
  const explorerAddress = useCallback((address) => (network?.explorerUrl ? `${network.explorerUrl}/address/${address}` : ""), [network]);

  const value = {
    config,
    configError,
    networks: config?.networks || [],
    network,
    chainId,
    selectNetwork,
    publicClient,
    hasWallet,
    account,
    walletChainId,
    wrongNetwork,
    connect,
    disconnect,
    switchNetwork,
    send,
    toasts,
    tokens,
    tokenByAddress,
    importToken,
    excludedSources,
    toggleSource,
    slippageBps: prefs.slippageBps ?? config?.settings.defaultSlippageBps ?? 50,
    deadlineMin: prefs.deadlineMin,
    savePrefs,
    refreshKey,
    refresh: () => setRefreshKey((key) => key + 1),
    explorerTx,
    explorerAddress,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Balances of `list` for the connected account on the selected network; native coin via eth_getBalance. */
export function useBalances(list) {
  const { publicClient, account, refreshKey } = useAgg();
  const [balances, setBalances] = useState({});
  const key = list.map((token) => token?.address).filter(Boolean).join(",");
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    if (!publicClient || !account) {
      setBalances({});
      return undefined;
    }
    let alive = true;
    const load = async () => {
      const targets = listRef.current.filter(Boolean);
      const results = await Promise.all(
        targets.map((token) =>
          (token.native
            ? publicClient.getBalance({ address: account })
            : publicClient.readContract({ address: token.address, abi: ERC20, functionName: "balanceOf", args: [account] })
          ).catch(() => null)
        )
      );
      if (!alive) return;
      const next = {};
      targets.forEach((token, i) => {
        if (results[i] != null) next[token.address] = results[i];
      });
      setBalances(next);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [publicClient, account, key, refreshKey]);

  return balances;
}

export function deadline(minutes) {
  return BigInt(Math.floor(Date.now() / 1000) + Math.max(1, Number(minutes) || 20) * 60);
}
