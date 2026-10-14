import { parseAbi } from "viem";

export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const ROUTER = parseAbi([
  "struct Hop { uint8 kind; address pool; address tokenIn; address tokenOut; uint32 fee; }",
  "function quote(Hop[][] paths, uint256[][] amounts) returns (uint256[][] outs)",
  "function feeBps() view returns (uint16)",
  "function surplusShareBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function wrappedNative() view returns (address)",
]);

export const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** Factory lookups, one ABI per source kind because getPool is overloaded across protocols. */
export const LOOKUP = {
  v2: parseAbi(["function getPair(address, address) view returns (address)"]),
  v3: parseAbi(["function getPool(address, address, uint24) view returns (address)"]),
  slipstream: parseAbi(["function getPool(address, address, int24) view returns (address)"]),
  solidly: parseAbi(["function getPool(address, address, bool) view returns (address)"]),
  algebra: parseAbi(["function poolByPair(address, address) view returns (address)"]),
};

export const POOL = {
  reserves: parseAbi(["function getReserves() view returns (uint256 reserve0, uint256 reserve1)"]),
  liquidity: parseAbi(["function liquidity() view returns (uint128)"]),
};

/** Router hop kinds (see NadcabAggregationRouter.KIND_*). */
export const HOP_KIND = { v2: 0, "v2-dynamic": 1, solidly: 1, v3: 2, slipstream: 2, algebra: 2 };
