import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const PER_CALL = 120;

/**
 * Reads many contract calls at once. Uses Multicall3 when the chain has it (one eth_call per 120 reads, which keeps
 * public RPCs from rate-limiting), otherwise a JSON-RPC batch.
 * Each result is { ok: true, data } for a successful call, { ok: false } for a revert, or { error } when the RPC failed.
 */
export function createReader(rpc) {
  let multicall = null;

  async function hasMulticall() {
    if (multicall === null) {
      try {
        const code = await rpc.call("eth_getCode", [MULTICALL3, "latest"]);
        multicall = typeof code === "string" && code.length > 2;
      } catch {
        return false;
      }
    }
    return multicall;
  }

  async function viaBatch(calls) {
    const answers = await rpc.batch(calls.map((call) => ["eth_call", [{ to: call.to, data: call.data }, "latest"]]));
    return answers.map((answer) => {
      if (answer.result !== undefined) return answer.result === "0x" ? { ok: false } : { ok: true, data: answer.result };
      return /revert/i.test(answer.error || "") ? { ok: false } : { error: answer.error };
    });
  }

  async function readMany(calls) {
    if (!calls.length) return [];
    if (!(await hasMulticall())) return viaBatch(calls);
    const chunks = [];
    for (let i = 0; i < calls.length; i += PER_CALL) chunks.push(calls.slice(i, i + PER_CALL));
    const answers = await rpc.batch(
      chunks.map((chunk) => [
        "eth_call",
        [
          {
            to: MULTICALL3,
            data: encodeFunctionData({
              abi: ABI,
              functionName: "aggregate3",
              args: [chunk.map((call) => ({ target: call.to, allowFailure: true, callData: call.data }))],
            }),
          },
          "latest",
        ],
      ])
    );
    const out = [];
    for (let c = 0; c < chunks.length; c++) {
      const answer = answers[c];
      if (!answer.result) {
        out.push(...(await viaBatch(chunks[c])));
        continue;
      }
      const rows = decodeFunctionResult({ abi: ABI, functionName: "aggregate3", data: answer.result });
      rows.forEach((row) => out.push(row.success && row.returnData !== "0x" ? { ok: true, data: row.returnData } : { ok: false }));
    }
    return out;
  }

  return { readMany, hasMulticall };
}
