// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../../contracts/SubBotJars.sol";

// Minimal cheatcode surface — avoids pulling in forge-std.
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
}

contract MockGD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MockForwarder {
    mapping(address => int96) public rates;
    function setRate(address sender, int96 r) external { rates[sender] = r; }
    function getFlowrate(address, address sender, address) external view returns (int96) { return rates[sender]; }
}

contract SubBotJarsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockGD gd; MockForwarder fwd; SubBotJars jars;
    address agent = address(0xA9E);
    address treasury = address(0x7EA);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_700_000_000);
        gd = new MockGD(); fwd = new MockForwarder();
        jars = new SubBotJars(address(gd), address(fwd), agent, treasury);
        gd.mint(alice, 1000 ether);
        vm.prank(alice); gd.approve(address(jars), type(uint256).max);
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory x) { x = new uint256[](2); x[0] = a; x[1] = b; }
    function _amts(uint256 a, uint256 b) internal pure returns (uint256[] memory x) { x = new uint256[](2); x[0] = a; x[1] = b; }
    function _bal(address who, uint256 id) internal view returns (uint256 b) { (b,,,) = jars.jarOf(who, id); }

    function test_depositSplitsAcrossJars() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(30 ether, 70 ether));
        require(_bal(alice, 1) == 30 ether && _bal(alice, 2) == 70 ether, "split");
        require(gd.balanceOf(address(jars)) == 100 ether, "custody");
    }

    function test_onlyOwnerOfJarCanWithdraw() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(30 ether, 0));
        vm.prank(bob); vm.expectRevert(bytes("Insufficient balance")); jars.withdraw(1, 10 ether);
        vm.prank(alice); jars.withdraw(1, 0);
        require(gd.balanceOf(alice) == 1000 ether, "refund all");
    }

    function test_agentNeedsCapToPay() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(50 ether, 0));
        vm.prank(agent); vm.expectRevert(bytes("Over jar cap")); jars.payBill(alice, 1, 10 ether, "q1");
        vm.prank(alice); jars.setCap(1, 20 ether);
        vm.prank(agent); jars.payBill(alice, 1, 15 ether, "q1");
        require(gd.balanceOf(treasury) == 15 ether && _bal(alice, 1) == 35 ether, "paid");
        vm.prank(agent); vm.expectRevert(bytes("Over jar cap")); jars.payBill(alice, 1, 10 ether, "q2");
    }

    function test_capResetsAfterPeriod() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(50 ether, 0));
        vm.prank(alice); jars.setCap(1, 20 ether);
        vm.prank(agent); jars.payBill(alice, 1, 20 ether, "q1");
        vm.warp(block.timestamp + 25 days);
        vm.prank(agent); jars.payBill(alice, 1, 20 ether, "q2");
        require(gd.balanceOf(treasury) == 40 ether, "second cycle");
    }

    function test_onlyAgentPays() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(50 ether, 0));
        vm.prank(alice); jars.setCap(1, 50 ether);
        vm.prank(bob); vm.expectRevert(bytes("Unauthorized")); jars.payBill(alice, 1, 1 ether, "x");
    }

    function test_cannotPayMoreThanBalance() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(5 ether, 0));
        vm.prank(alice); jars.setCap(1, 50 ether);
        vm.prank(agent); vm.expectRevert(bytes("Insufficient balance")); jars.payBill(alice, 1, 6 ether, "x");
    }


    function test_streamFundingIsDisabled() public {
        uint16[] memory bps = new uint16[](1); bps[0] = 10000;
        uint256[] memory ids = new uint256[](1); ids[0] = 1;
        fwd.setRate(bob, 1e15);
        vm.prank(bob); vm.expectRevert(bytes("Streaming is disabled")); jars.setStreamSplit(ids, bps);
    }

    function test_stoppingAndRestartingFlowCannotMintCredits() public {
        vm.prank(alice); jars.deposit(_ids(1, 2), _amts(100 ether, 0));
        fwd.setRate(bob, 1e15);
        jars.settle(bob);
        vm.warp(block.timestamp + 1);
        fwd.setRate(bob, 0);
        vm.warp(block.timestamp + 1000);
        fwd.setRate(bob, 1e15);
        jars.settle(bob);
        require(_bal(bob, 1) == 0 && jars.unallocated(bob) == 0, "unbacked credits");
        vm.prank(bob); vm.expectRevert(bytes("Insufficient balance")); jars.withdraw(1, 0);
        vm.prank(alice); jars.withdraw(1, 0);
        require(gd.balanceOf(alice) == 1000 ether, "victim funds depleted");
    }
}
