// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockToken {
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    /// @dev Basis points burned on every transfer, to model fee-on-transfer tokens.
    uint256 public transferFeeBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_, uint256 transferFeeBps_) {
        symbol = symbol_;
        transferFeeBps = transferFeeBps_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        uint256 burn = (amount * transferFeeBps) / 10_000;
        balanceOf[to] += amount - burn;
        totalSupply -= burn;
    }
}

/// @dev Constant-product pair that enforces the invariant like Uniswap V2, with a fee in parts per million. Its
/// getAmountOut(amountIn, tokenIn) also makes it stand in for Solidly-style pools.
contract MockV2Pair {
    address public token0;
    address public token1;
    uint256 public feePpm;
    uint112 internal reserve0;
    uint112 internal reserve1;

    constructor(address a, address b, uint256 feePpm_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feePpm = feePpm_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }

    function sync() public {
        reserve0 = uint112(MockToken(token0).balanceOf(address(this)));
        reserve1 = uint112(MockToken(token1).balanceOf(address(this)));
    }

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256) {
        (uint256 rIn, uint256 rOut) = tokenIn == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 withFee = amountIn * (1e6 - feePpm);
        return (withFee * rOut) / (rIn * 1e6 + withFee);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (amount0Out > 0) MockToken(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockToken(token1).transfer(to, amount1Out);
        uint256 b0 = MockToken(token0).balanceOf(address(this));
        uint256 b1 = MockToken(token1).balanceOf(address(this));
        uint256 in0 = b0 > reserve0 - amount0Out ? b0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = b1 > reserve1 - amount1Out ? b1 - (reserve1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "INSUFFICIENT_INPUT");
        uint256 adj0 = b0 * 1e6 - in0 * feePpm;
        uint256 adj1 = b1 * 1e6 - in1 * feePpm;
        require(adj0 * adj1 >= uint256(reserve0) * reserve1 * 1e12, "K");
        sync();
    }
}

interface ISwapCallback {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
    function algebraSwapCallback(int256, int256, bytes calldata) external;
}

/// @dev Concentrated-liquidity stand-in: fixed price (out = in * priceNum / priceDen), pays first and collects in the
/// callback the way Uniswap V3 does. `flavor` picks the callback name (0 Uniswap, 1 Pancake, 2 Algebra).
contract MockV3Pool {
    address public token0;
    address public token1;
    uint8 public flavor;
    uint256 public priceNum;
    uint256 public priceDen;
    /// @dev When non-zero, only this much input is consumed, as if the price limit was hit.
    uint256 public partialFill;
    /// @dev When non-zero, output shrinks as depth / (depth + amountIn), giving the pool price impact.
    uint256 public depth;

    constructor(address a, address b, uint8 flavor_, uint256 priceNum_, uint256 priceDen_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        flavor = flavor_;
        priceNum = priceNum_;
        priceDen = priceDen_;
    }

    function setPartialFill(uint256 amount) external {
        partialFill = amount;
    }

    function setDepth(uint256 depth_) external {
        depth = depth_;
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 amountIn = partialFill > 0 ? partialFill : uint256(amountSpecified);
        // Price is quoted as token1 per token0.
        uint256 out = zeroForOne ? (amountIn * priceNum) / priceDen : (amountIn * priceDen) / priceNum;
        if (depth > 0) out = (out * depth) / (depth + amountIn);
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        MockToken(tokenOut).transfer(recipient, out);
        uint256 before = MockToken(tokenIn).balanceOf(address(this));
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        if (flavor == 0) ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        else if (flavor == 1) ISwapCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        else ISwapCallback(msg.sender).algebraSwapCallback(amount0, amount1, data);
        require(MockToken(tokenIn).balanceOf(address(this)) >= before + amountIn, "IIA");
    }
}

/// @dev Tries to pull tokens out of the router through the swap callback.
contract CallbackThief {
    function steal(address router, int256 amount) external {
        ISwapCallback(router).uniswapV3SwapCallback(amount, 0, "");
    }
}

/// @dev Factories so the off-chain engine can discover the mock pools the same way it finds real ones.
contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function register(address pair) external {
        address a = MockV2Pair(pair).token0();
        address b = MockV2Pair(pair).token1();
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function register(address pool, uint24 fee) external {
        address a = MockV3Pool(pool).token0();
        address b = MockV3Pool(pool).token1();
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

contract MockAlgebraFactory {
    mapping(address => mapping(address => address)) public poolByPair;

    function register(address pool) external {
        address a = MockV3Pool(pool).token0();
        address b = MockV3Pool(pool).token1();
        poolByPair[a][b] = pool;
        poolByPair[b][a] = pool;
    }
}
