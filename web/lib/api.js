"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export async function api(path) {
  const response = await fetch(`/api${path}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/** Fetches `path` and refreshes every `refreshMs` while the tab is visible. */
export function useApi(path, { refreshMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: "", loading: Boolean(path) });
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api(path);
      if (current.current === path) setState({ data, error: "", loading: false });
    } catch (error) {
      if (current.current === path) setState((prev) => ({ data: prev.data, error: error.message, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    setState((prev) => ({ data: null, error: "", loading: Boolean(path) }));
    load();
    if (!refreshMs) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [load, path, refreshMs]);

  return { ...state, reload: load };
}