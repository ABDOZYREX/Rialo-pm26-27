// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Lite {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract RialoUsdcSwap {
    IERC20Lite public immutable usdc;
    uint256 public constant FEE_BPS = 30;
    uint256 private unlocked = 1;

    event PoolSeeded(address indexed provider, uint256 usdcAmount, uint256 rloAmount);
    event RloLiquidityAdded(address indexed provider, uint256 rloAmount);
    event SwapExecuted(address indexed user, bool usdcToRlo, uint256 amountIn, uint256 amountOut);

    modifier nonReentrant() {
        require(unlocked == 1, "reentrancy");
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address usdcAddress_) {
        require(usdcAddress_ != address(0), "zero token");
        usdc = IERC20Lite(usdcAddress_);
    }

    function usdcAddress() external view returns (address) { return address(usdc); }

    function getReserves() public view returns (uint256 usdcReserve, uint256 rloReserve) {
        return (usdc.balanceOf(address(this)), address(this).balance);
    }

    function previewUsdcToRlo(uint256 usdcAmount) public view returns (uint256) {
        (uint256 stableReserve, uint256 nativeReserve) = getReserves();
        return _quote(usdcAmount, stableReserve, nativeReserve);
    }

    function previewRloToUsdc(uint256 rloAmount) public view returns (uint256) {
        (uint256 stableReserve, uint256 nativeReserve) = getReserves();
        return _quote(rloAmount, nativeReserve, stableReserve);
    }

    function seedPool(uint256 usdcAmount) external payable nonReentrant {
        require(usdcAmount > 0 && msg.value > 0, "empty seed");
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "USDC transfer failed");
        emit PoolSeeded(msg.sender, usdcAmount, msg.value);
    }

    function addRloLiquidity() external payable {
        require(msg.value > 0, "empty liquidity");
        emit RloLiquidityAdded(msg.sender, msg.value);
    }

    function swapUsdcForRlo(uint256 usdcAmount, uint256 minRloOut, uint256 deadline) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        uint256 amountOut = previewUsdcToRlo(usdcAmount);
        require(amountOut >= minRloOut && amountOut > 0, "slippage");
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "USDC transfer failed");
        (bool sent,) = payable(msg.sender).call{value: amountOut}("");
        require(sent, "RLO transfer failed");
        emit SwapExecuted(msg.sender, true, usdcAmount, amountOut);
    }

    function swapRloForUsdc(uint256 minUsdcOut, uint256 deadline) external payable nonReentrant {
        require(block.timestamp <= deadline, "expired");
        uint256 nativeReserveBefore = address(this).balance - msg.value;
        uint256 stableReserve = usdc.balanceOf(address(this));
        uint256 amountOut = _quote(msg.value, nativeReserveBefore, stableReserve);
        require(amountOut >= minUsdcOut && amountOut > 0, "slippage");
        require(usdc.transfer(msg.sender, amountOut), "USDC transfer failed");
        emit SwapExecuted(msg.sender, false, msg.value, amountOut);
    }

    function _quote(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountAfterFee = amountIn * (10_000 - FEE_BPS);
        return (amountAfterFee * reserveOut) / (reserveIn * 10_000 + amountAfterFee);
    }

    receive() external payable { emit RloLiquidityAdded(msg.sender, msg.value); }
}
