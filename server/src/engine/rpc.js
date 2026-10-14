export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** JSON-RPC client for one chain. Batches fall back to single calls when the node rejects them. */
export function createRpc(url, { timeoutMs = 20_000, batchSize = 20 } = {}) {
  let nextId = 1;
  let batching = true;

  async function post(body, ms = timeoutMs) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new RpcError(`RPC answered HTTP ${response.status} with non-JSON`, response.status);
    }
  }

  async function call(method, params = []) {
    const body = await post({ jsonrpc: "2.0", id: nextId++, method, params });
    if (body.error) throw new RpcError(body.error.message || "RPC error", body.error.code, body.error.data);
    return body.result;
  }

  /**
   * Runs `calls` ([method, params] pairs) and returns `{ result }` or `{ error }` for each, in order.
   * Calls the node rate-limited are retried with backoff.
   */
  async function batch(calls) {
    const out = await batchOnce(calls);
    for (const delay of [400, 1200, 2500]) {
      const retry = out.map((row, i) => (row.error && RATE_LIMITED.test(row.error) ? i : -1)).filter((i) => i >= 0);
      if (!retry.length) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const again = await batchOnce(retry.map((i) => calls[i]));
      retry.forEach((i, j) => {
        out[i] = again[j];
      });
    }
    return out;
  }

  async function batchOnce(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += batchSize) {
      const slice = calls.slice(i, i + batchSize);
      let answer = null;
      if (batching && slice.length > 1) {
        const base = nextId;
        nextId += slice.length;
        try {
          answer = await post(slice.map(([method, params], j) => ({ jsonrpc: "2.0", id: base + j, method, params })));
        } catch (error) {
          if (!(error instanceof RpcError)) throw error;
        }
        if (Array.isArray(answer)) {
          const byId = new Map(answer.map((row) => [row.id, row]));
          for (let j = 0; j < slice.length; j++) {
            const row = byId.get(base + j);
            out.push(row && !row.error ? { result: row.result } : { error: row?.error?.message || "missing batch answer" });
          }
          continue;
        }
        if (answer && !Array.isArray(answer)) batching = false;
      }
      const singles = await Promise.all(
        slice.map(([method, params]) =>
          call(method, params).then(
            (result) => ({ result }),
            (error) => ({ error: error.message })
          )
        )
      );
      out.push(...singles);
    }
    return out;
  }

  return { url, call, batch, post };
}

const RATE_LIMITED = /rate.?limit|too many requests|429|capacity|exceeded/i;
