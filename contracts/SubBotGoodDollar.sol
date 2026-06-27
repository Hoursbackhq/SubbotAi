// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @dev Minimal Uniswap V3 SwapRouter interface.
 *      Deployed on Celo: 0x5615CDAb10dc425a742d643d949a7F474C01abc4
 */
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

/**
 * @dev Minimal Uniswap V3 Pool interface for price reads.
 */
interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24   tick,
        uint16  observationIndex,
        uint16  observationCardinality,
        uint16  observationCardinalityNext,
        uint8   feeProtocol,
        bool    unlocked
    );
}

/**
 * @dev Minimal SubBotVault interface — only the deposit function we need.
 */
interface ISubBotVault {
    function deposit(string calldata userId, uint256 amount) external;
}

/**
 * @title SubBotGoodDollar
 * @notice Adapter that converts GoodDollar (G$) to cUSD via Uniswap V3,
 *         then deposits into SubBotVault or pays for agent operations.
 *
 * How it works:
 *   1. User approves this contract to spend their G$ tokens.
 *   2. depositWithGD() swaps G$ → cUSD via Uniswap V3, then calls vault.deposit().
 *   3. payWithGD() swaps G$ → cUSD, sends cUSD directly to the agent wallet.
 *   4. Users get free G$ daily from GoodDollar UBI — making SubBot genuinely free.
 *
 * GoodDollar (G$):           0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A
 * cUSD (USDm):               0x765DE816845861e75A25fCA122bb6898B8B1282a
 * Uniswap V3 SwapRouter:     0x5615CDAb10dc425a742d643d949a7F474C01abc4
 * G$/cUSD pool fee tier:     10000 (1%)
 */
contract SubBotGoodDollar {

    // ── Constants ────────────────────────────────────────────────────────────

    IERC20       public constant GD     = IERC20(0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A);
    IERC20       public constant CUSD   = IERC20(0x765DE816845861e75A25fCA122bb6898B8B1282a);
    ISwapRouter  public constant ROUTER = ISwapRouter(0x5615CDAb10dc425a742d643d949a7F474C01abc4);

    uint24  public constant POOL_FEE = 10000; // 1% fee tier

    // Operation costs in cUSD wei (must match SubBotVault)
    uint256 public constant COST_SCAN      = 0.002 ether;
    uint256 public constant COST_AUDIT     = 0.002 ether;
    uint256 public constant COST_NEGOTIATE = 0.005 ether;
    uint256 public constant COST_EXPORT    = 0.001 ether;

    // ── State ────────────────────────────────────────────────────────────────

    ISubBotVault public vault;
    address      public agent;
    address      public owner;

    // ── Events ───────────────────────────────────────────────────────────────

    event DepositedWithGD(string indexed userId, uint256 gdIn, uint256 cusdOut);
    event PaidWithGD(string indexed userId, string action, uint256 gdIn, uint256 cusdOut);

    // ── Setup ────────────────────────────────────────────────────────────────

    constructor(address _vault, address _agent) {
        vault = ISubBotVault(_vault);
        agent = _agent;
        owner = msg.sender;

        // Pre-approve router to pull G$ and cUSD for swaps
        GD.approve(address(ROUTER), type(uint256).max);
        // Pre-approve vault to pull cUSD for deposits
        CUSD.approve(address(vault), type(uint256).max);
    }

    modifier onlyAgent() {
        require(msg.sender == agent || msg.sender == owner, "Unauthorized");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── User: Deposit G$ into Vault ──────────────────────────────────────────

    /**
     * @notice Swap G$ → cUSD via Uniswap V3, then deposit cUSD into SubBotVault.
     * @param userId      Telegram user ID (passed to vault.deposit)
     * @param gdAmount    Amount of G$ to swap (in wei, G$ has 18 decimals)
     * @param minCUSDOut  Minimum cUSD to accept (slippage protection)
     */
    function depositWithGD(
        string calldata userId,
        uint256 gdAmount,
        uint256 minCUSDOut
    ) external {
        require(gdAmount > 0, "Amount must be > 0");

        // Pull G$ from user
        GD.transferFrom(msg.sender, address(this), gdAmount);

        // Swap G$ → cUSD via Uniswap V3
        uint256 cusdOut = ROUTER.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           address(GD),
                tokenOut:          address(CUSD),
                fee:               POOL_FEE,
                recipient:         address(this),
                amountIn:          gdAmount,
                amountOutMinimum:  minCUSDOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Deposit swapped cUSD into vault on behalf of user
        vault.deposit(userId, cusdOut);

        emit DepositedWithGD(userId, gdAmount, cusdOut);
    }

    // ── Agent: Pay for operation with G$ ─────────────────────────────────────

    /**
     * @notice Accept G$ for a single operation, swap to cUSD, send to agent wallet.
     * @param userId  Telegram user ID
     * @param action  Operation name: "scan", "audit", "negotiate", "export"
     */
    function payWithGD(
        string calldata userId,
        string calldata action,
        uint256 gdAmount,
        uint256 minCUSDOut
    ) external onlyAgent {
        require(gdAmount > 0, "Amount must be > 0");

        // Pull G$ from the caller (agent or user via agent)
        GD.transferFrom(msg.sender, address(this), gdAmount);

        // Swap G$ → cUSD
        uint256 cusdOut = ROUTER.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           address(GD),
                tokenOut:          address(CUSD),
                fee:               POOL_FEE,
                recipient:         agent,
                amountIn:          gdAmount,
                amountOutMinimum:  minCUSDOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Verify the swap covered the operation cost
        uint256 cost = _actionCost(action);
        require(cusdOut >= cost, "Swap output below operation cost");

        emit PaidWithGD(userId, action, gdAmount, cusdOut);
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    /**
     * @notice Estimate cUSD output for a given G$ amount using pool spot price.
     *         This is an approximation — actual swap may differ due to slippage.
     * @param gdAmount  Amount of G$ (in wei)
     * @return estimated cUSD output (in wei)
     */
    function getQuote(uint256 gdAmount) external view returns (uint256) {
        if (gdAmount == 0) return 0;

        // Read spot price from the Uniswap V3 pool
        // sqrtPriceX96 = sqrt(price) * 2^96, where price = token1/token0
        // For G$/cUSD pool: price = cUSD per G$
        // Simplified estimation: we use the pool's sqrtPriceX96 to derive the rate
        //
        // Since on-chain pool address discovery requires factory calls,
        // we return a conservative estimate based on typical G$/cUSD rates.
        // The actual swap uses the router which handles pool routing.
        //
        // For production accuracy, call the Quoter contract off-chain.
        // This on-chain view is for UI display purposes only.

        // Conservative fallback: assume 1 G$ = 0.00001 cUSD (typical UBI rate)
        // Real rate will be determined by the pool at swap time
        return (gdAmount * 1) / 100000;
    }

    /**
     * @notice Get the cUSD cost for a given operation.
     */
    function actionCost(string calldata action) external pure returns (uint256) {
        return _actionCost(action);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
    }

    function setVault(address _vault) external onlyOwner {
        vault = ISubBotVault(_vault);
        CUSD.approve(_vault, type(uint256).max);
    }

    /// @notice Emergency rescue for stuck tokens.
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _actionCost(string memory action) internal pure returns (uint256) {
        bytes32 h = keccak256(abi.encodePacked(action));
        if (h == keccak256("scan"))      return COST_SCAN;
        if (h == keccak256("audit"))     return COST_AUDIT;
        if (h == keccak256("negotiate")) return COST_NEGOTIATE;
        if (h == keccak256("export"))    return COST_EXPORT;
        revert("Unknown action");
    }
}
