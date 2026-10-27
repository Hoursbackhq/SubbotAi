// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title SubBotCredits
 * @notice Simple G$ credit system for SubBot agent operations.
 *         No yield, no Aave, no swaps — just deposit G$ and the agent spends it.
 *
 * How it works:
 *   1. User claims free G$ daily from GoodDollar UBI.
 *   2. User deposits G$ into this contract — balance is tracked per user.
 *   3. Agent calls spendCredits() to pay for operations (scan, audit, etc.).
 *   4. User can withdraw unspent G$ at any time.
 *
 * At current costs, 1 G$ covers ~10 scans or ~20 audits.
 * One week of daily G$ claims funds a month of heavy usage.
 *
 * GoodDollar (G$) on Celo: 0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A
 */
contract SubBotCredits {
    function securityVersion() external pure returns (uint256) { return 2; }

    // ── Constants ────────────────────────────────────────────────────────────

    IERC20 public constant GD = IERC20(0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A);

    // Operation costs in G$ wei (G$ has 18 decimals, so 0.10 G$ = 0.1 ether)
    uint256 public constant COST_SCAN      = 0.10 ether;  // Gmail scan
    uint256 public constant COST_AUDIT     = 0.05 ether;  // LLM portfolio audit
    uint256 public constant COST_NEGOTIATE = 0.10 ether;  // Negotiation email
    uint256 public constant COST_EXPORT    = 0.05 ether;  // CSV export
    // Dashboard, daily digest, and renewal alerts are FREE.

    // ── State ────────────────────────────────────────────────────────────────

    struct UserCredits {
        uint256 balance;       // G$ available to spend
        uint256 totalDeposited; // lifetime G$ deposited
        uint256 totalSpent;    // lifetime G$ spent on operations
        uint256 firstDeposit;  // timestamp of first deposit
    }

    mapping(bytes32 => UserCredits) private credits;
    mapping(bytes32 => address)     public  depositors;

    uint256 public totalDeposits;
    uint256 public totalSpent;

    address public agent;
    address public owner;

    // ── Events ───────────────────────────────────────────────────────────────

    event Deposited(bytes32 indexed userKey, address indexed from, uint256 amount, uint256 newBalance);
    event Spent(bytes32 indexed userKey, uint256 amount, string action, uint256 remaining);
    event Withdrawn(bytes32 indexed userKey, address indexed to, uint256 amount);

    // ── Setup ────────────────────────────────────────────────────────────────

    constructor(address _agent) {
        agent = _agent;
        owner = msg.sender;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "Unauthorized");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── User: Deposit G$ ─────────────────────────────────────────────────────

    /// Bind an account only after the service verifies its linked wallet.
    /// Public deposits cannot reserve somebody else's social-login identifier.
    function bindDepositor(string calldata userId, address depositor) external onlyAgent {
        require(depositor != address(0), "Invalid depositor");
        bytes32 key = _key(userId);
        require(depositors[key] == address(0) || depositors[key] == depositor, "Already bound");
        depositors[key] = depositor;
    }

    /**
     * @notice Deposit G$ tokens as credits. User must approve this contract first.
     * @param userId  User identifier (hashed for privacy)
     * @param amount  G$ amount in wei (0.1 ether = 0.10 G$)
     */
    function deposit(string calldata userId, uint256 amount) external {
        require(amount > 0, "Amount must be > 0");

        bytes32 key = _key(userId);
        address depositor = depositors[key];
        require(depositor != address(0) && depositor == msg.sender, "Not your credits");

        require(GD.transferFrom(msg.sender, address(this), amount), "G$ transfer failed");

        UserCredits storage c = credits[key];
        if (c.firstDeposit == 0) c.firstDeposit = block.timestamp;

        c.balance        += amount;
        c.totalDeposited += amount;
        totalDeposits    += amount;

        emit Deposited(key, msg.sender, amount, c.balance);
    }

    // ── User: Withdraw G$ ────────────────────────────────────────────────────

    /**
     * @notice Withdraw unspent G$ back to your wallet.
     * @param userId  User identifier
     * @param amount  G$ to withdraw (0 = withdraw all)
     */
    function withdraw(string calldata userId, uint256 amount) external {
        bytes32 key = _key(userId);
        require(depositors[key] == msg.sender, "Not your credits");

        UserCredits storage c = credits[key];
        uint256 withdrawAmt = amount == 0 ? c.balance : amount;
        require(c.balance >= withdrawAmt, "Insufficient balance");

        c.balance     -= withdrawAmt;
        totalDeposits -= withdrawAmt;

        require(GD.transfer(msg.sender, withdrawAmt), "G$ transfer failed");

        emit Withdrawn(key, msg.sender, withdrawAmt);
    }

    // ── Agent: Spend Credits ─────────────────────────────────────────────────

    /**
     * @notice Deduct G$ credits for an agent operation.
     *         Reverts if user has insufficient balance.
     * @param userId  User identifier
     * @param action  Operation: "scan", "audit", "negotiate", "export"
     */
    function spendCredits(
        string calldata userId,
        string calldata action
    ) external onlyAgent {
        bytes32 key  = _key(userId);
        uint256 cost = _actionCost(action);

        UserCredits storage c = credits[key];
        require(c.balance >= cost, "Insufficient credits");

        c.balance    -= cost;
        c.totalSpent += cost;
        totalSpent   += cost;

        // Transfer G$ to agent wallet to cover operational costs
        require(GD.transfer(agent, cost), "G$ transfer failed");

        emit Spent(key, cost, action, c.balance);
    }

    /**
     * @notice Spend an arbitrary amount (for custom operations).
     */
    function spendAmount(
        string calldata userId,
        uint256 amount,
        string calldata action
    ) external onlyAgent {
        bytes32 key = _key(userId);

        UserCredits storage c = credits[key];
        require(c.balance >= amount, "Insufficient credits");

        c.balance    -= amount;
        c.totalSpent += amount;
        totalSpent   += amount;

        require(GD.transfer(agent, amount), "G$ transfer failed");

        emit Spent(key, amount, action, c.balance);
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    /**
     * @notice Get a user's credit state.
     * @return balance        G$ available to spend right now
     * @return totalDeposited_ lifetime G$ deposited
     * @return totalSpent_     lifetime G$ spent
     * @return opsRemaining   estimated operations remaining at scan cost
     */
    function getCredits(string calldata userId) external view returns (
        uint256 balance,
        uint256 totalDeposited_,
        uint256 totalSpent_,
        uint256 opsRemaining
    ) {
        bytes32 key = _key(userId);
        UserCredits storage c = credits[key];

        return (
            c.balance,
            c.totalDeposited,
            c.totalSpent,
            c.balance / COST_SCAN  // how many scans can they afford
        );
    }

    /**
     * @notice Check if user can afford a specific action.
     */
    function canAfford(string calldata userId, string calldata action) external view returns (bool) {
        return credits[_key(userId)].balance >= _actionCost(action);
    }

    /**
     * @notice Get the G$ cost for a given operation.
     */
    function actionCost(string calldata action) external pure returns (uint256) {
        return _actionCost(action);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _key(string memory userId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(userId));
    }

    function _actionCost(string memory action) internal pure returns (uint256) {
        bytes32 h = keccak256(abi.encodePacked(action));
        if (h == keccak256("scan"))      return COST_SCAN;
        if (h == keccak256("audit"))     return COST_AUDIT;
        if (h == keccak256("negotiate")) return COST_NEGOTIATE;
        if (h == keccak256("export"))    return COST_EXPORT;
        revert("Unknown action");
    }
}
