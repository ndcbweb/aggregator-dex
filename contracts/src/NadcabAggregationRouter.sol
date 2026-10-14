// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface ISolidlyPair {
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @dev Uniswap V3, PancakeSwap V3, Aerodrome Slipstream and Algebra pools share this swap signature.
interface IConcentratedPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @title Nadcab Aggregation Router
/// @notice Executes routes found off-chain by the Nadcab aggregator: the input is split across several paths, each path
/// hops through V2-style, Solidly-style or concentrated-liquidity pools, and the combined output is checked against the
/// trader's minimum. A partner fee and a share of positive slippage go to the fee recipient.
/// @dev The router keeps no balances between transactions. Every hop measures what it actually received, so tokens with
/// transfer fees work, and concentrated-liquidity callbacks only pay the pool the router is calling at that moment.
contract NadcabAggregationRouter {
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint16 public constant MAX_FEE_BPS = 300;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PPM = 1_000_000;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant QUOTE_HOP_GAS = 1_000_000;

    uint8 public constant KIND_UNISWAP_V2 = 0;
    uint8 public constant KIND_SOLIDLY = 1;
    uint8 public constant KIND_CONCENTRATED = 2;

    struct Hop {
        uint8 kind;
        address pool;
        address tokenIn;
        address tokenOut;
        /// @dev Pool fee in parts per million, used by V2-style hops (3000 = 0.30%). Ignored by the other kinds.
        uint32 fee;
    }

    struct Path {
        uint16 shareBps;
        Hop[] hops;
    }

    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        /// @dev Least the recipient accepts after fees.
        uint256 minReturn;
        /// @dev Output the route was quoted at before fees; anything above it is positive slippage.
        uint256 quotedOut;
        address recipient;
        uint256 deadline;
    }

    address public immutable wrappedNative;
    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    uint16 public feeBps;
    uint16 public surplusShareBps;
    bool public paused;

    uint256 private locked = 1;
    address private activePool;
    address private activeToken;
    uint256 private activeLimit;
    bool private quoting;

    event Swapped(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 surplusAmount
    );
    event FeesUpdated(address feeRecipient, uint16 feeBps, uint16 surplusShareBps);
    event Paused(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Expired();
    error IsPaused();
    error Reentrancy();
    error NotOwner();
    error BadParams();
    error BadPath();
    error BadHop();
    error InsufficientOutput(uint256 amountOut, uint256 minReturn);
    error UnexpectedCallback();
    error TransferFailed();
    error QuoteResult(uint256 amountOut);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev 2 means entered. Storage starts at 0, which also counts as free, so quote() works when the router's code
    /// is placed at an address with an eth_call state override.
    modifier nonReentrant() {
        if (locked == 2) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address wrappedNative_, address owner_, address feeRecipient_, uint16 feeBps_, uint16 surplusShareBps_) {
        if (wrappedNative_ == address(0) || owner_ == address(0)) revert BadParams();
        wrappedNative = wrappedNative_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        _setFees(feeRecipient_, feeBps_, surplusShareBps_);
    }

    receive() external payable {
        if (msg.sender != wrappedNative) revert BadParams();
    }

    /* -------------------------------------------------------------------------- */
    /*                                    Swap                                    */
    /* -------------------------------------------------------------------------- */

    /// @notice Swaps `amountIn` of `tokenIn` along `paths` and sends at least `minReturn` of `tokenOut` to `recipient`.
    /// Use NATIVE for the chain's coin on either side.
    function swap(SwapParams calldata p, Path[] calldata paths) external payable nonReentrant returns (uint256 amountOut) {
        if (paused) revert IsPaused();
        if (block.timestamp > p.deadline) revert Expired();
        if (p.amountIn == 0 || p.recipient == address(0) || p.tokenIn == p.tokenOut || paths.length == 0) revert BadParams();

        address routeIn = p.tokenIn == NATIVE ? wrappedNative : p.tokenIn;
        address routeOut = p.tokenOut == NATIVE ? wrappedNative : p.tokenOut;
        if (routeIn == routeOut) revert BadParams();

        uint256 received;
        if (p.tokenIn == NATIVE) {
            if (msg.value != p.amountIn) revert BadParams();
            IWrappedNative(wrappedNative).deposit{value: msg.value}();
            received = msg.value;
        } else {
            if (msg.value != 0) revert BadParams();
            uint256 before = _balance(routeIn);
            _transferFrom(routeIn, msg.sender, address(this), p.amountIn);
            received = _balance(routeIn) - before;
        }

        uint256 outBefore = _balance(routeOut);
        _runPaths(paths, routeIn, routeOut, received);
        uint256 gross = _balance(routeOut) - outBefore;

        uint256 surplus = gross > p.quotedOut && p.quotedOut > 0 ? ((gross - p.quotedOut) * surplusShareBps) / BPS : 0;
        uint256 fee = ((gross - surplus) * feeBps) / BPS;
        amountOut = gross - surplus - fee;
        if (amountOut < p.minReturn) revert InsufficientOutput(amountOut, p.minReturn);

        uint256 toTreasury = fee + surplus;
        if (p.tokenOut == NATIVE) {
            IWrappedNative(wrappedNative).withdraw(gross);
            if (toTreasury > 0) _sendNative(feeRecipient, toTreasury);
            _sendNative(p.recipient, amountOut);
        } else {
            if (toTreasury > 0) _transfer(routeOut, feeRecipient, toTreasury);
            _transfer(routeOut, p.recipient, amountOut);
        }

        emit Swapped(msg.sender, p.recipient, p.tokenIn, p.tokenOut, received, amountOut, fee, surplus);
    }

    function _runPaths(Path[] calldata paths, address routeIn, address routeOut, uint256 total) private {
        uint256 shares;
        uint256 spent;
        uint256 last = paths.length - 1;
        for (uint256 i; i <= last; ++i) {
            Path calldata path = paths[i];
            uint256 hopCount = path.hops.length;
            if (hopCount == 0 || path.shareBps == 0) revert BadPath();
            shares += path.shareBps;
            uint256 amount = i == last ? total - spent : (total * path.shareBps) / BPS;
            spent += amount;
            if (path.hops[0].tokenIn != routeIn || path.hops[hopCount - 1].tokenOut != routeOut) revert BadPath();
            for (uint256 h; h < hopCount; ++h) {
                Hop calldata hop = path.hops[h];
                if (h > 0 && hop.tokenIn != path.hops[h - 1].tokenOut) revert BadPath();
                amount = _hop(hop, amount);
            }
        }
        if (shares != BPS) revert BadPath();
    }

    /// @dev Swaps `amountIn` held by the router through one pool and returns what the router received.
    function _hop(Hop calldata hop, uint256 amountIn) private returns (uint256) {
        if (hop.tokenIn == hop.tokenOut || hop.pool == address(0) || amountIn == 0) revert BadHop();
        uint256 before = _balance(hop.tokenOut);
        bool zeroForOne = hop.tokenIn < hop.tokenOut;

        if (hop.kind == KIND_UNISWAP_V2 || hop.kind == KIND_SOLIDLY) {
            if (hop.kind == KIND_UNISWAP_V2 && hop.fee >= PPM) revert BadHop();
            _transfer(hop.tokenIn, hop.pool, amountIn);
            (uint256 reserve0, uint256 reserve1) = _reserves(hop.pool, hop.kind);
            (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
            uint256 paid = IERC20(hop.tokenIn).balanceOf(hop.pool) - reserveIn;
            uint256 out;
            if (hop.kind == KIND_UNISWAP_V2) {
                uint256 withFee = paid * (PPM - hop.fee);
                out = (withFee * reserveOut) / (reserveIn * PPM + withFee);
            } else {
                out = ISolidlyPair(hop.pool).getAmountOut(paid, hop.tokenIn);
            }
            if (out == 0) revert BadHop();
            (uint256 out0, uint256 out1) = zeroForOne ? (uint256(0), out) : (out, uint256(0));
            IUniswapV2Pair(hop.pool).swap(out0, out1, address(this), "");
        } else if (hop.kind == KIND_CONCENTRATED) {
            if (amountIn > uint256(type(int256).max)) revert BadHop();
            activePool = hop.pool;
            activeToken = hop.tokenIn;
            activeLimit = amountIn;
            IConcentratedPool(hop.pool).swap(
                address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, ""
            );
            if (activePool != address(0)) revert UnexpectedCallback();
        } else {
            revert BadHop();
        }

        uint256 received = _balance(hop.tokenOut) - before;
        if (received == 0) revert BadHop();
        return received;
    }

    function _reserves(address pool, uint8 kind) private view returns (uint256 reserve0, uint256 reserve1) {
        if (kind == KIND_UNISWAP_V2) {
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(pool).getReserves();
            return (r0, r1);
        }
        (reserve0, reserve1,) = ISolidlyPair(pool).getReserves();
    }

    /* -------------------------------------------------------------------------- */
    /*                    Concentrated-liquidity swap callbacks                   */
    /* -------------------------------------------------------------------------- */

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta, amount1Delta);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta, amount1Delta);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _pay(amount0Delta, amount1Delta);
    }

    /// @dev Pays the pool that is mid-swap, once. The pool must take the whole hop input: a swap that stops at the price
    /// limit would leave the rest stranded in the router, so it reverts instead.
    function _pay(int256 amount0Delta, int256 amount1Delta) private {
        if (msg.sender != activePool || activePool == address(0)) revert UnexpectedCallback();
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : amount1Delta > 0 ? uint256(amount1Delta) : 0;
        if (quoting) {
            int256 received = amount0Delta < 0 ? amount0Delta : amount1Delta;
            revert QuoteResult(owed == activeLimit && received < 0 ? uint256(-received) : 0);
        }
        if (owed != activeLimit) revert UnexpectedCallback();
        address token = activeToken;
        activePool = address(0);
        activeToken = address(0);
        activeLimit = 0;
        _transfer(token, msg.sender, owed);
    }

    /* -------------------------------------------------------------------------- */
    /*                                   Quoting                                  */
    /* -------------------------------------------------------------------------- */

    /// @notice Simulates each path at each of its amounts and returns the outputs, 0 where a path cannot fill.
    /// Call it with eth_call: concentrated pools are quoted by starting a real swap and reverting inside the callback.
    function quote(Hop[][] calldata paths, uint256[][] calldata amounts)
        external
        nonReentrant
        returns (uint256[][] memory outs)
    {
        if (paths.length != amounts.length) revert BadParams();
        outs = new uint256[][](paths.length);
        for (uint256 p; p < paths.length; ++p) {
            Hop[] calldata hops = paths[p];
            outs[p] = new uint256[](amounts[p].length);
            for (uint256 i; i < amounts[p].length; ++i) {
                uint256 amount = amounts[p][i];
                for (uint256 h; h < hops.length && amount > 0; ++h) {
                    if (h > 0 && hops[h].tokenIn != hops[h - 1].tokenOut) amount = 0;
                    else amount = _quoteHop(hops[h], amount);
                }
                outs[p][i] = amount;
            }
        }
    }

    function _quoteHop(Hop calldata hop, uint256 amountIn) private returns (uint256) {
        if (hop.tokenIn == hop.tokenOut || hop.pool == address(0) || amountIn == 0) return 0;
        bool zeroForOne = hop.tokenIn < hop.tokenOut;

        if (hop.kind == KIND_UNISWAP_V2) {
            if (hop.fee >= PPM) return 0;
            try IUniswapV2Pair(hop.pool).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                uint256 withFee = amountIn * (PPM - hop.fee);
                return (withFee * reserveOut) / (reserveIn * PPM + withFee);
            } catch {
                return 0;
            }
        }
        if (hop.kind == KIND_SOLIDLY) {
            try ISolidlyPair(hop.pool).getAmountOut(amountIn, hop.tokenIn) returns (uint256 out) {
                return out;
            } catch {
                return 0;
            }
        }
        if (hop.kind != KIND_CONCENTRATED || amountIn > uint256(type(int256).max)) return 0;

        activePool = hop.pool;
        activeToken = hop.tokenIn;
        activeLimit = amountIn;
        quoting = true;
        uint256 result;
        // A pool too thin for the amount walks through thousands of ticks; capping its gas turns that into a 0 quote
        // instead of exhausting the whole eth_call.
        try IConcentratedPool(hop.pool).swap{gas: QUOTE_HOP_GAS}(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, ""
        ) {} catch (bytes memory reason) {
            if (reason.length == 36 && bytes4(reason) == QuoteResult.selector) {
                assembly {
                    result := mload(add(reason, 36))
                }
            }
        }
        quoting = false;
        activePool = address(0);
        activeToken = address(0);
        activeLimit = 0;
        return result;
    }

    /* -------------------------------------------------------------------------- */
    /*                                    Owner                                   */
    /* -------------------------------------------------------------------------- */

    function setFees(address feeRecipient_, uint16 feeBps_, uint16 surplusShareBps_) external onlyOwner {
        _setFees(feeRecipient_, feeBps_, surplusShareBps_);
    }

    function _setFees(address feeRecipient_, uint16 feeBps_, uint16 surplusShareBps_) private {
        if (feeBps_ > MAX_FEE_BPS || surplusShareBps_ > BPS) revert BadParams();
        if ((feeBps_ > 0 || surplusShareBps_ > 0) && feeRecipient_ == address(0)) revert BadParams();
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        surplusShareBps = surplusShareBps_;
        emit FeesUpdated(feeRecipient_, feeBps_, surplusShareBps_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Recovers tokens or coin sent to the router by mistake; the router holds nothing between swaps.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert BadParams();
        if (token == NATIVE) _sendNative(to, amount);
        else _transfer(token, to, amount);
    }

    /* -------------------------------------------------------------------------- */
    /*                                   Helpers                                  */
    /* -------------------------------------------------------------------------- */

    function _balance(address token) private view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || (data.length == 0 && token.code.length == 0)) {
            revert TransferFailed();
        }
    }

    function _transferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || (data.length == 0 && token.code.length == 0)) {
            revert TransferFailed();
        }
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
