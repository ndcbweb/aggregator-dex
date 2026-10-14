#!/usr/bin/env node
// Writes artifacts/aggregator.json (ABIs, creation and runtime bytecode) from the Foundry build, for the server and the Console.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file, name) => JSON.parse(readFileSync(join(root, "contracts/out", file, `${name}.json`), "utf8"));

const contracts = {};
for (const [file, name] of [
  ["NadcabAggregationRouter.sol", "NadcabAggregationRouter"],
  ["WrappedNative.sol", "WrappedNative"],
]) {
  const artifact = read(file, name);
  contracts[name] = { abi: artifact.abi, bytecode: artifact.bytecode.object, deployedBytecode: artifact.deployedBytecode.object };
}

const payload = {
  name: "Nadcab Aggregation Router",
  compiler: "0.8.24",
  evmVersion: "paris",
  contracts,
};
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(join(root, "artifacts/aggregator.json"), `${JSON.stringify(payload)}\n`);
console.log(`artifacts/aggregator.json: ${Object.keys(contracts).join(", ")}`);
