// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../../contracts/SubBotCredits.sol";

interface CreditsVm {
    function prank(address) external;
    function etch(address, bytes calldata) external;
    function expectRevert(bytes calldata) external;
}

contract CreditsMockGD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setFailTransfers(bool fail) external { failTransfers = fail; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract SubBotCreditsTest {
    CreditsVm constant vm = CreditsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SubBotCredits credits;
    CreditsMockGD gd;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address agent = address(0xA9E);
    string constant USER = "w3a:google:alice";

    function setUp() public {
        credits = new SubBotCredits(agent);
        gd = CreditsMockGD(address(credits.GD()));
        vm.etch(address(gd), address(new CreditsMockGD()).code);
        gd.mint(alice, 100 ether);
        gd.mint(bob, 100 ether);
        vm.prank(alice); gd.approve(address(credits), type(uint256).max);
        vm.prank(bob); gd.approve(address(credits), type(uint256).max);
        vm.prank(agent); credits.bindDepositor(USER, alice);
    }

    function balance() internal view returns (uint256 amount) {
        (amount,,,) = credits.getCredits(USER);
    }

    function test_tinyDepositCannotStealExistingCredits() public {
        vm.prank(alice); credits.deposit(USER, 10 ether);
        vm.prank(bob); vm.expectRevert(bytes("Not your credits")); credits.deposit(USER, 1);
        vm.prank(bob); vm.expectRevert(bytes("Not your credits")); credits.withdraw(USER, 0);
        require(credits.depositors(keccak256(bytes(USER))) == alice, "owner changed");
        require(balance() == 10 ether, "balance changed");
        require(gd.balanceOf(bob) == 100 ether, "rejected deposit charged");
        vm.prank(alice); credits.withdraw(USER, 0);
        require(gd.balanceOf(alice) == 100 ether, "owner cannot recover funds");
    }

    function test_ownerCanTopUpSpendAndWithdraw() public {
        vm.prank(alice); credits.deposit(USER, 10 ether);
        vm.prank(alice); credits.deposit(USER, 5 ether);
        vm.prank(agent); credits.spendCredits(USER, "audit");
        vm.prank(agent); credits.spendAmount(USER, 1 ether, "custom");
        vm.prank(alice); credits.withdraw(USER, 2 ether);
        require(balance() == 11.95 ether, "incorrect remaining credits");
        vm.prank(alice); credits.withdraw(USER, 0);
        require(balance() == 0, "withdraw all");
        require(gd.balanceOf(agent) == 1.05 ether, "agent payment");
        require(gd.balanceOf(alice) == 98.95 ether, "owner payment");
    }

    function test_ownershipSurvivesEmptyBalance() public {
        vm.prank(alice); credits.deposit(USER, 10 ether);
        vm.prank(alice); credits.withdraw(USER, 0);
        vm.prank(bob); vm.expectRevert(bytes("Not your credits")); credits.deposit(USER, 1);
        vm.prank(alice); credits.deposit(USER, 3 ether);
        require(balance() == 3 ether, "owner cannot refill");
    }

    function test_publicDepositorCannotPreclaimUnusedIdentity() public {
        vm.prank(bob); vm.expectRevert(bytes("Not your credits")); credits.deposit("unclaimed", 1);
        vm.prank(bob); vm.expectRevert(bytes("Unauthorized")); credits.bindDepositor("unclaimed", bob);
        require(credits.depositors(keccak256("unclaimed")) == address(0), "preclaimed");
        vm.prank(agent); credits.bindDepositor("unclaimed", alice);
        vm.prank(alice); credits.deposit("unclaimed", 1 ether);
        vm.prank(agent); vm.expectRevert(bytes("Already bound")); credits.bindDepositor("unclaimed", bob);
    }

    function test_failedDepositDoesNotBindOwnerOrMintCredits() public {
        gd.setFailTransfers(true);
        vm.prank(alice); vm.expectRevert(bytes("G$ transfer failed")); credits.deposit(USER, 10 ether);
        require(balance() == 0 && credits.totalDeposits() == 0, "unbacked credits");
        require(credits.depositors(keccak256(bytes(USER))) == alice, "registered owner changed");
    }

    function test_failedWithdrawalPreservesBalance() public {
        vm.prank(alice); credits.deposit(USER, 10 ether);
        gd.setFailTransfers(true);
        vm.prank(alice); vm.expectRevert(bytes("G$ transfer failed")); credits.withdraw(USER, 0);
        require(balance() == 10 ether && credits.totalDeposits() == 10 ether, "failed withdrawal debited");
    }

    function test_failedSpendsPreserveBalance() public {
        vm.prank(alice); credits.deposit(USER, 10 ether);
        gd.setFailTransfers(true);
        vm.prank(agent); vm.expectRevert(bytes("G$ transfer failed")); credits.spendCredits(USER, "audit");
        vm.prank(agent); vm.expectRevert(bytes("G$ transfer failed")); credits.spendAmount(USER, 1 ether, "custom");
        require(balance() == 10 ether && credits.totalSpent() == 0, "failed spend debited");
    }
}
