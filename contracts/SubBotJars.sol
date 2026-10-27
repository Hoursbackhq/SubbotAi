// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Superfluid CFAv1Forwarder — the same address on every chain Superfluid runs on.
interface ICFAv1Forwarder {
    function getFlowrate(address token, address sender, address receiver) external view returns (int96);
}

/**
 * @title SubBotJars
 * @notice Bill jars: G$ set aside per bill ("GOtv, due on the 14th"), paid out
 *         when the bill is due. Evolved from SubBotCredits' deposit/spend model.
 *
 * How it works:
 *   1. The owner fills jars with G$: one-off deposits (e.g. right after the daily
 *      UBI claim, split across jars) and/or a G$ stream into this contract,
 *      split across jars by basis points.
 *   2. The owner sets a cap per jar: the most the agent may pay out of it per
 *      PERIOD. A cap of 0 means the agent can't touch the jar.
 *   3. When a bill is due, the agent calls payBill(), which moves G$ from the jar
 *      to the treasury; the backend then pays the bill in naira.
 *   4. The owner can withdraw any jar at any time.
 *
 * Jars are keyed by wallet address (not by an off-chain userId), so nobody can
 * claim someone else's jars by front-running a first deposit.
 *
 * Stream funding is disabled: sampling only the current rate cannot prove
 * how much a wallet actually streamed between settlements. One-off deposits
 * remain available. These entry points stay in the ABI for compatibility.
 */
contract SubBotJars {

    IERC20          public immutable GD;
    ICFAv1Forwarder public immutable forwarder;

    uint256 public constant PERIOD          = 25 days; // cap window: one bill cycle, with slack
    uint256 public constant MAX_STREAM_JARS = 10;

    struct Jar {
        uint256 balance;
        uint256 capPerPeriod;   // max the agent may pay out per PERIOD
        uint256 spentInPeriod;
        uint64  periodStart;
    }

    struct Stream {
        int96     rate;         // flow rate last seen, G$ wei per second
        uint64    lastSettled;
        uint256[] jarIds;
        uint16[]  bps;          // share of the stream per jar; remainder → unallocated
    }

    mapping(address => mapping(uint256 => Jar)) private jars;
    mapping(address => Stream)                  private streams;
    mapping(address => uint256)                 public  unallocated;

    address public agent;
    address public owner;
    address public treasury;

    uint256 private locked = 1;

    event Deposited(address indexed who, uint256 indexed jarId, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed who, uint256 indexed jarId, uint256 amount);
    event CapSet(address indexed who, uint256 indexed jarId, uint256 capPerPeriod);
    event BillPaid(address indexed who, uint256 indexed jarId, uint256 amount, string ref);
    event StreamSplitSet(address indexed who, uint256[] jarIds, uint16[] bps, int96 rate);
    event StreamSettled(address indexed who, uint256 accrued);

    constructor(address _gd, address _forwarder, address _agent, address _treasury) {
        GD        = IERC20(_gd);
        forwarder = ICFAv1Forwarder(_forwarder);
        agent     = _agent;
        treasury  = _treasury;
        owner     = msg.sender;
    }

    modifier onlyAgent() { require(msg.sender == agent, "Unauthorized"); _; }
    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    // G$ is a SuperToken (ERC777-style hooks), so transfers can call back in.
    modifier nonReentrant() { require(locked == 1, "Reentrant"); locked = 2; _; locked = 1; }

    // ── Owner of jars ────────────────────────────────────────────────────────

    /// Split one G$ deposit across jars. Approve this contract for the total first.
    function deposit(uint256[] calldata jarIds, uint256[] calldata amounts) external nonReentrant {
        require(jarIds.length == amounts.length && jarIds.length > 0, "Bad input");
        settle(msg.sender);
        uint256 total;
        for (uint256 i; i < jarIds.length; i++) {
            Jar storage j = jars[msg.sender][jarIds[i]];
            j.balance += amounts[i];
            total     += amounts[i];
            emit Deposited(msg.sender, jarIds[i], amounts[i], j.balance);
        }
        require(total > 0, "Amount must be > 0");
        require(GD.transferFrom(msg.sender, address(this), total), "Transfer failed");
    }

    function withdraw(uint256 jarId, uint256 amount) external nonReentrant {
        settle(msg.sender);
        Jar storage j = jars[msg.sender][jarId];
        uint256 amt = amount == 0 ? j.balance : amount;
        require(amt > 0 && j.balance >= amt, "Insufficient balance");
        j.balance -= amt;
        emit Withdrawn(msg.sender, jarId, amt);
        require(GD.transfer(msg.sender, amt), "Transfer failed");
    }

    function withdrawUnallocated() external nonReentrant {
        settle(msg.sender);
        uint256 amt = unallocated[msg.sender];
        require(amt > 0, "Nothing to withdraw");
        unallocated[msg.sender] = 0;
        emit Withdrawn(msg.sender, type(uint256).max, amt);
        require(GD.transfer(msg.sender, amt), "Transfer failed");
    }

    function setCap(uint256 jarId, uint256 capPerPeriod) external {
        jars[msg.sender][jarId].capPerPeriod = capPerPeriod;
        emit CapSet(msg.sender, jarId, capPerPeriod);
    }

    /// Disabled until stream receipts can be attributed without trusting callers.
    function setStreamSplit(uint256[] calldata, uint16[] calldata) external pure {
        revert("Streaming is disabled");
    }

    function settle(address) public pure {
        // Never mint withdrawable credits from a sampled flow rate.
    }

    // ── Agent ────────────────────────────────────────────────────────────────

    /// Pay a due bill out of a jar into the treasury, within the owner's cap.
    function payBill(address who, uint256 jarId, uint256 amount, string calldata ref) external onlyAgent nonReentrant {
        require(amount > 0, "Amount must be > 0");
        settle(who);
        Jar storage j = jars[who][jarId];
        if (block.timestamp >= j.periodStart + PERIOD) {
            j.periodStart   = uint64(block.timestamp);
            j.spentInPeriod = 0;
        }
        require(j.spentInPeriod + amount <= j.capPerPeriod, "Over jar cap");
        require(j.balance >= amount, "Insufficient balance");
        j.balance       -= amount;
        j.spentInPeriod += amount;
        emit BillPaid(who, jarId, amount, ref);
        require(GD.transfer(treasury, amount), "Transfer failed");
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    /// Balance includes stream accrual not yet settled, so the UI can show a jar filling live.
    function jarOf(address who, uint256 jarId) external view returns (
        uint256 balance, uint256 capPerPeriod, uint256 spentInPeriod, uint64 periodStart
    ) {
        Jar storage j = jars[who][jarId];
        balance = j.balance;
        return (balance, j.capPerPeriod, j.spentInPeriod, j.periodStart);
    }

    function streamOf(address who) external view returns (int96 rate, uint64 lastSettled, uint256[] memory jarIds, uint16[] memory bps) {
        Stream storage s = streams[who];
        return (s.rate, s.lastSettled, s.jarIds, s.bps);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setAgent(address _agent) external onlyOwner { agent = _agent; }
    function setTreasury(address _treasury) external onlyOwner { treasury = _treasury; }

}
