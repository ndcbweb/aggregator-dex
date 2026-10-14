// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {NadcabAggregationRouter} from "../src/NadcabAggregationRouter.sol";
import {WrappedNative} from "../src/WrappedNative.sol";
import {CallbackThief, MockToken, MockV2Pair, MockV3Pool} from "./Mocks.sol";

contract NadcabAggregationRouterTest is Test {
    NadcabAggregationRouter router;
    WrappedNative wnative;
    MockToken usdc;
    MockToken dai;
    MockToken taxed;
    MockV2Pair v2UsdcDai;
    MockV2Pair solidlyUsdcDai;
    MockV2Pair v2WnUsdc;
    MockV2Pair v2TaxedUsdc;
    MockV3Pool v3Uni;
    MockV3Pool v3Pancake;
    MockV3Pool v3Algebra;

    address trader = makeAddr("trader");
    address treasury = makeAddr("treasury");
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function setUp() public {
        wnative = new WrappedNative("Wrapped Ether", "WETH");
        usdc = new MockToken("USDC", 0);
        dai = new MockToken("DAI", 0);
        taxed = new MockToken("TAX", 100);
        router = new NadcabAggregationRouter(address(wnative), address(this), treasury, 30, 5_000);

        v2UsdcDai = _v2(usdc, dai, 1_000_000e18, 1_000_000e18, 3000);
        solidlyUsdcDai = _v2(usdc, dai, 500_000e18, 500_000e18, 2000);
        v2TaxedUsdc = _v2(taxed, usdc, 1_000_000e18, 1_000_000e18, 3000);

        vm.deal(address(this), 1_000 ether);
        wnative.deposit{value: 500 ether}();
        v2WnUsdc = new MockV2Pair(address(wnative), address(usdc), 3000);
        wnative.transfer(address(v2WnUsdc), 500 ether);
        usdc.mint(address(v2WnUsdc), 1_000_000e18);
        v2WnUsdc.sync();

        // One token1 per token0 at a 0.5% discount, so every flavor quotes the same.
        v3Uni = _v3(usdc, dai, 0);
        v3Pancake = _v3(usdc, dai, 1);
        v3Algebra = _v3(usdc, dai, 2);

        usdc.mint(trader, 100_000e18);
        taxed.mint(trader, 100_000e18);
        vm.deal(trader, 100 ether);
        vm.startPrank(trader);
        usdc.approve(address(router), type(uint256).max);
        taxed.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _v2(MockToken a, MockToken b, uint256 ra, uint256 rb, uint256 fee) internal returns (MockV2Pair pair) {
        pair = new MockV2Pair(address(a), address(b), fee);
        a.mint(address(pair), ra);
        b.mint(address(pair), rb);
        pair.sync();
    }

    function _v3(MockToken a, MockToken b, uint8 flavor) internal returns (MockV3Pool pool) {
        pool = new MockV3Pool(address(a), address(b), flavor, 995, 1000);
        a.mint(address(pool), 1_000_000e18);
        b.mint(address(pool), 1_000_000e18);
    }

    function _hop(uint8 kind, address pool, address tokenIn, address tokenOut, uint32 fee)
        internal
        pure
        returns (NadcabAggregationRouter.Hop memory)
    {
        return NadcabAggregationRouter.Hop({kind: kind, pool: pool, tokenIn: tokenIn, tokenOut: tokenOut, fee: fee});
    }

    function _single(uint16 share, NadcabAggregationRouter.Hop memory hop) internal pure returns (NadcabAggregationRouter.Path memory path) {
        path.shareBps = share;
        path.hops = new NadcabAggregationRouter.Hop[](1);
        path.hops[0] = hop;
    }

    function _params(address tokenIn, address tokenOut, uint256 amountIn, uint256 minReturn, uint256 quotedOut)
        internal
        view
        returns (NadcabAggregationRouter.SwapParams memory)
    {
        return NadcabAggregationRouter.SwapParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minReturn: minReturn,
            quotedOut: quotedOut,
            recipient: trader,
            deadline: block.timestamp + 60
        });
    }

    function test_SingleV2PathTakesPartnerFee() public {
        uint256 amountIn = 1_000e18;
        uint256 expected = v2UsdcDai.getAmountOut(amountIn, address(usdc));
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));

        vm.prank(trader);
        uint256 out = router.swap(_params(address(usdc), address(dai), amountIn, 0, expected), paths);

        uint256 fee = (expected * 30) / 10_000;
        assertEq(out, expected - fee);
        assertEq(dai.balanceOf(trader), expected - fee);
        assertEq(dai.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(dai.balanceOf(address(router)), 0);
    }

    function test_SplitAcrossEveryPoolKind() public {
        uint256 amountIn = 50_000e18;
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](5);
        paths[0] = _single(3_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));
        paths[1] = _single(2_000, _hop(1, address(solidlyUsdcDai), address(usdc), address(dai), 0));
        paths[2] = _single(2_000, _hop(2, address(v3Uni), address(usdc), address(dai), 0));
        paths[3] = _single(1_500, _hop(2, address(v3Pancake), address(usdc), address(dai), 0));
        paths[4] = _single(1_500, _hop(2, address(v3Algebra), address(usdc), address(dai), 0));

        vm.prank(trader);
        uint256 out = router.swap(_params(address(usdc), address(dai), amountIn, 1, 0), paths);

        assertGt(out, 49_000e18);
        assertEq(dai.balanceOf(trader), out);
        assertEq(usdc.balanceOf(trader), 50_000e18);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(dai.balanceOf(address(router)), 0);
    }

    function test_MultiHopNativeInThroughV2ThenV3() public {
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0].shareBps = 10_000;
        paths[0].hops = new NadcabAggregationRouter.Hop[](2);
        paths[0].hops[0] = _hop(0, address(v2WnUsdc), address(wnative), address(usdc), 3000);
        paths[0].hops[1] = _hop(2, address(v3Uni), address(usdc), address(dai), 0);

        uint256 balanceBefore = trader.balance;
        vm.prank(trader);
        uint256 out = router.swap{value: 1 ether}(_params(NATIVE, address(dai), 1 ether, 1, 0), paths);

        assertEq(trader.balance, balanceBefore - 1 ether);
        assertGt(out, 1_900e18);
        assertEq(dai.balanceOf(trader), out);
        assertEq(wnative.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_NativeOutPaysTreasuryInCoin() public {
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2WnUsdc), address(usdc), address(wnative), 3000));
        uint256 expected = v2WnUsdc.getAmountOut(2_000e18, address(usdc));

        uint256 balanceBefore = trader.balance;
        vm.prank(trader);
        uint256 out = router.swap(_params(address(usdc), NATIVE, 2_000e18, 0, expected), paths);

        assertEq(trader.balance - balanceBefore, out);
        assertEq(treasury.balance, expected - out);
        assertEq(address(router).balance, 0);
    }

    function test_FeeOnTransferInput() public {
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2TaxedUsdc), address(taxed), address(usdc), 3000));

        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        uint256 out = router.swap(_params(address(taxed), address(usdc), 1_000e18, 1, 0), paths);

        // 1% is burned on the way into the router and 1% more on the way into the pair.
        assertGt(out, 970e18);
        assertLt(out, 980e18);
        assertEq(usdc.balanceOf(trader) - before, out);
    }

    function test_PositiveSlippageIsShared() public {
        uint256 amountIn = 1_000e18;
        uint256 gross = v2UsdcDai.getAmountOut(amountIn, address(usdc));
        uint256 quoted = gross - 10e18;
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));

        vm.prank(trader);
        uint256 out = router.swap(_params(address(usdc), address(dai), amountIn, 0, quoted), paths);

        uint256 surplus = 5e18;
        uint256 fee = ((gross - surplus) * 30) / 10_000;
        assertEq(out, gross - surplus - fee);
        assertEq(dai.balanceOf(treasury), surplus + fee);
    }

    function test_RevertsBelowMinReturn() public {
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));
        vm.prank(trader);
        vm.expectRevert();
        router.swap(_params(address(usdc), address(dai), 1_000e18, 1_000e18, 0), paths);
    }

    function test_RevertsOnBadRoutes() public {
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);

        paths[0] = _single(9_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));
        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.BadPath.selector);
        router.swap(_params(address(usdc), address(dai), 1e18, 0, 0), paths);

        paths[0] = _single(10_000, _hop(0, address(v2UsdcDai), address(dai), address(usdc), 3000));
        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.BadPath.selector);
        router.swap(_params(address(usdc), address(dai), 1e18, 0, 0), paths);

        paths[0] = _single(10_000, _hop(7, address(v2UsdcDai), address(usdc), address(dai), 3000));
        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.BadHop.selector);
        router.swap(_params(address(usdc), address(dai), 1e18, 0, 0), paths);

        paths[0].shareBps = 10_000;
        paths[0].hops = new NadcabAggregationRouter.Hop[](2);
        paths[0].hops[0] = _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000);
        paths[0].hops[1] = _hop(0, address(v2WnUsdc), address(wnative), address(dai), 3000);
        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.BadPath.selector);
        router.swap(_params(address(usdc), address(dai), 1e18, 0, 0), paths);
    }

    function test_RevertsWhenExpiredOrPaused() public {
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));
        NadcabAggregationRouter.SwapParams memory p = _params(address(usdc), address(dai), 1e18, 0, 0);

        p.deadline = block.timestamp - 1;
        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.Expired.selector);
        router.swap(p, paths);

        router.setPaused(true);
        p.deadline = block.timestamp + 1;
        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.IsPaused.selector);
        router.swap(p, paths);
    }

    function test_PartialConcentratedFillReverts() public {
        v3Uni.setPartialFill(1e18);
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(2, address(v3Uni), address(usdc), address(dai), 0));
        vm.prank(trader);
        vm.expectRevert();
        router.swap(_params(address(usdc), address(dai), 10e18, 0, 0), paths);
    }

    function test_CallbackCannotBeCalledOutsideASwap() public {
        usdc.mint(address(router), 5e18);
        CallbackThief thief = new CallbackThief();
        vm.expectRevert(NadcabAggregationRouter.UnexpectedCallback.selector);
        thief.steal(address(router), 5e18);
        assertEq(usdc.balanceOf(address(router)), 5e18);
    }

    function test_OwnerControls() public {
        vm.expectRevert(NadcabAggregationRouter.BadParams.selector);
        router.setFees(treasury, 301, 0);
        vm.expectRevert(NadcabAggregationRouter.BadParams.selector);
        router.setFees(address(0), 10, 0);
        router.setFees(address(0), 0, 0);
        assertEq(router.feeBps(), 0);

        vm.prank(trader);
        vm.expectRevert(NadcabAggregationRouter.NotOwner.selector);
        router.setPaused(true);

        address next = makeAddr("next");
        router.transferOwnership(next);
        assertEq(router.owner(), address(this));
        vm.prank(next);
        router.acceptOwnership();
        assertEq(router.owner(), next);

        usdc.mint(address(router), 3e18);
        vm.prank(next);
        router.rescue(address(usdc), next, 3e18);
        assertEq(usdc.balanceOf(next), 3e18);
    }

    function test_ZeroFeeSendsEverythingToTrader() public {
        router.setFees(address(0), 0, 0);
        uint256 expected = v2UsdcDai.getAmountOut(1_000e18, address(usdc));
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0] = _single(10_000, _hop(0, address(v2UsdcDai), address(usdc), address(dai), 3000));
        vm.prank(trader);
        uint256 out = router.swap(_params(address(usdc), address(dai), 1_000e18, expected, expected - 1), paths);
        assertEq(out, expected);
    }

    function test_QuoteMatchesExecution() public {
        NadcabAggregationRouter.Hop[] memory hops = new NadcabAggregationRouter.Hop[](2);
        hops[0] = _hop(0, address(v2WnUsdc), address(wnative), address(usdc), 3000);
        hops[1] = _hop(2, address(v3Algebra), address(usdc), address(dai), 0);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 0.1 ether;
        amounts[1] = 1 ether;
        amounts[2] = 0;
        uint256[] memory outs = _quote(hops, amounts);
        assertEq(outs[2], 0);
        assertGt(outs[1], outs[0] * 9);

        router.setFees(address(0), 0, 0);
        NadcabAggregationRouter.Path[] memory paths = new NadcabAggregationRouter.Path[](1);
        paths[0].shareBps = 10_000;
        paths[0].hops = hops;
        vm.prank(trader);
        uint256 out = router.swap{value: 1 ether}(_params(NATIVE, address(dai), 1 ether, outs[1], 0), paths);
        assertEq(out, outs[1]);
    }

    function test_QuoteReturnsZeroWhenAPoolCannotFill() public {
        NadcabAggregationRouter.Hop[] memory hops = new NadcabAggregationRouter.Hop[](1);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 5e18;

        v3Pancake.setPartialFill(1e18);
        hops[0] = _hop(2, address(v3Pancake), address(usdc), address(dai), 0);
        assertEq(_quote(hops, amounts)[0], 0);

        hops[0] = _hop(0, address(usdc), address(usdc), address(dai), 3000);
        assertEq(_quote(hops, amounts)[0], 0);

        hops[0] = _hop(1, address(v2UsdcDai), address(usdc), address(dai), 0);
        assertEq(_quote(hops, amounts)[0], v2UsdcDai.getAmountOut(5e18, address(usdc)));
    }

    function _quote(NadcabAggregationRouter.Hop[] memory hops, uint256[] memory amounts) internal returns (uint256[] memory) {
        NadcabAggregationRouter.Hop[][] memory paths = new NadcabAggregationRouter.Hop[][](1);
        paths[0] = hops;
        uint256[][] memory batch = new uint256[][](1);
        batch[0] = amounts;
        return router.quote(paths, batch)[0];
    }

    receive() external payable {}
}
