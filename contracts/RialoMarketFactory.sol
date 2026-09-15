// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RialoMarketToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply_, address factory) {
        name = name_; symbol = symbol_; totalSupply = supply_; balanceOf[factory] = supply_;
        emit Transfer(address(0), factory, supply_);
    }
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value; emit Approval(msg.sender, spender, value); return true;
    }
    function transfer(address to, uint256 value) external returns (bool) { _transfer(msg.sender, to, value); return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender]; require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value); return true;
    }
    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0) && balanceOf[from] >= value, "transfer");
        unchecked { balanceOf[from] -= value; } balanceOf[to] += value; emit Transfer(from, to, value);
    }
}

contract RialoMarketFactory {
    uint16 public constant DEFAULT_CREATOR_BPS = 2000;
    uint16 public constant DEFAULT_FEE_BPS = 100;

    struct Pool {
        address token;
        address creator;
        uint256 actualRloReserve;
        uint256 virtualRloReserve;
        uint256 virtualTokenReserve;
        uint16 feeBps;
        bool exists;
    }

    mapping(address => Pool) public pools;
    address[] public allTokens;
    mapping(address => address[]) public creatorTokens;
    uint256 private unlocked = 1;

    event TokenCreated(address indexed creator,address indexed token,string name,string symbol,uint256 totalSupply,uint256 creatorAllocation,uint256 poolTokenReserve,uint256 virtualRloReserve,uint256 seedLiquidity);
    event TradeExecuted(address indexed trader,address indexed token,bool indexed isBuy,uint256 amountRlo,uint256 amountToken,uint256 executionPrice,uint256 actualRloReserve,uint256 virtualRloReserve,uint256 virtualTokenReserve);

    modifier nonReentrant() { require(unlocked == 1, "reentrancy"); unlocked = 2; _; unlocked = 1; }

    function tokenCount() external view returns (uint256) { return allTokens.length; }
    function creatorTokenCount(address creator) external view returns (uint256) { return creatorTokens[creator].length; }
    function getCreatorTokens(address creator) external view returns (address[] memory) { return creatorTokens[creator]; }

    function createToken(string calldata tokenName,string calldata tokenSymbol,uint256 totalSupply_,uint256 initialPriceWad) external payable nonReentrant returns (address token) {
        require(bytes(tokenName).length > 0 && bytes(tokenSymbol).length > 0, "name");
        require(totalSupply_ > 0 && initialPriceWad > 0 && msg.value > 0, "invalid market");
        RialoMarketToken created = new RialoMarketToken(tokenName, tokenSymbol, totalSupply_, address(this));
        token = address(created);
        uint256 creatorAllocation = totalSupply_ * DEFAULT_CREATOR_BPS / 10_000;
        uint256 poolTokenReserve = totalSupply_ - creatorAllocation;
        require(created.transfer(msg.sender, creatorAllocation), "allocation");
        uint256 virtualRlo = initialPriceWad * poolTokenReserve / 1e18;
        if (virtualRlo < msg.value) virtualRlo = msg.value;
        pools[token] = Pool(token,msg.sender,msg.value,virtualRlo,poolTokenReserve,DEFAULT_FEE_BPS,true);
        allTokens.push(token); creatorTokens[msg.sender].push(token);
        emit TokenCreated(msg.sender,token,tokenName,tokenSymbol,totalSupply_,creatorAllocation,poolTokenReserve,virtualRlo,msg.value);
    }

    function getPool(address token) external view returns (address creator,uint256 actualRloReserve,uint256 virtualRloReserve,uint256 virtualTokenReserve,uint16 feeBps,uint256 spotPriceWad) {
        Pool storage p = pools[token]; require(p.exists, "pool");
        spotPriceWad = p.virtualTokenReserve == 0 ? 0 : p.virtualRloReserve * 1e18 / p.virtualTokenReserve;
        return (p.creator,p.actualRloReserve,p.virtualRloReserve,p.virtualTokenReserve,p.feeBps,spotPriceWad);
    }

    function buyToken(address token,uint256 minTokenOut,uint256 deadline) external payable nonReentrant returns (uint256 amountTokenOut) {
        require(block.timestamp <= deadline && msg.value > 0, "invalid buy");
        Pool storage p = pools[token]; require(p.exists, "pool");
        uint256 netIn = msg.value * (10_000 - p.feeBps) / 10_000;
        uint256 invariant = p.virtualRloReserve * p.virtualTokenReserve;
        uint256 newRlo = p.virtualRloReserve + netIn;
        amountTokenOut = p.virtualTokenReserve - invariant / newRlo;
        require(amountTokenOut >= minTokenOut && amountTokenOut > 0, "slippage");
        p.actualRloReserve += msg.value; p.virtualRloReserve = newRlo; p.virtualTokenReserve -= amountTokenOut;
        require(RialoMarketToken(token).transfer(msg.sender, amountTokenOut), "token out");
        emit TradeExecuted(msg.sender,token,true,msg.value,amountTokenOut,msg.value * 1e18 / amountTokenOut,p.actualRloReserve,p.virtualRloReserve,p.virtualTokenReserve);
    }

    function sellToken(address token,uint256 amountTokenIn,uint256 minRloOut,uint256 deadline) external nonReentrant returns (uint256 amountRloOut) {
        require(block.timestamp <= deadline && amountTokenIn > 0, "invalid sell");
        Pool storage p = pools[token]; require(p.exists, "pool");
        uint256 netTokens = amountTokenIn * (10_000 - p.feeBps) / 10_000;
        uint256 invariant = p.virtualRloReserve * p.virtualTokenReserve;
        uint256 newTokenReserve = p.virtualTokenReserve + netTokens;
        amountRloOut = p.virtualRloReserve - invariant / newTokenReserve;
        require(amountRloOut >= minRloOut && amountRloOut > 0 && amountRloOut <= p.actualRloReserve, "liquidity");
        require(RialoMarketToken(token).transferFrom(msg.sender,address(this),amountTokenIn), "token in");
        p.actualRloReserve -= amountRloOut; p.virtualRloReserve -= amountRloOut; p.virtualTokenReserve += amountTokenIn;
        (bool sent,) = payable(msg.sender).call{value: amountRloOut}(""); require(sent, "RLO out");
        emit TradeExecuted(msg.sender,token,false,amountRloOut,amountTokenIn,amountRloOut * 1e18 / amountTokenIn,p.actualRloReserve,p.virtualRloReserve,p.virtualTokenReserve);
    }
}
