#!/usr/bin/env node
/**
 * Batch-swap the G$ collected from bill payments into cUSD, which then funds
 * the VTpass wallet. Run on a schedule (e.g. daily), never per payment, so
 * small bills don't each pay gas and slippage.
 *
 *   node scripts/treasury-swap.js            # dry run: shows the quote only
 *   node scripts/treasury-swap.js --execute  # approve + swap
 *
 * Env:
 *   TREASURY_PRIVATE_KEY   key of BILLS_TREASURY_ADDRESS
 *   SWAP_ROUTER            UniswapV2-compatible router with a G$→cUSD route on Celo
 *   SWAP_PATH              comma-separated token path, default G$,cUSD
 *   SWAP_KEEP_GD           G$ to leave in the treasury (default 0)
 *   SWAP_MAX_SLIPPAGE_BPS  default 100 (1%)
 */
require('../load-env');
const { ethers } = require('ethers');

const GD   = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A';
const CUSD = '0x765DE816845861e75A25fCA122bb6898B8B1282a';
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const ROUTER = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
];

async function main() {
  const execute = process.argv.includes('--execute');
  const { TREASURY_PRIVATE_KEY, SWAP_ROUTER } = process.env;
  if (!TREASURY_PRIVATE_KEY || !SWAP_ROUTER) throw new Error('Set TREASURY_PRIVATE_KEY and SWAP_ROUTER');

  const provider = new ethers.JsonRpcProvider('https://forno.celo.org');
  const wallet   = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
  const gd       = new ethers.Contract(GD, ERC20, wallet);
  const router   = new ethers.Contract(SWAP_ROUTER, ROUTER, wallet);
  const swapPath = (process.env.SWAP_PATH || `${GD},${CUSD}`).split(',').map(a => ethers.getAddress(a.trim()));
  const keep     = ethers.parseUnits(process.env.SWAP_KEEP_GD || '0', 18);
  const slipBps  = BigInt(process.env.SWAP_MAX_SLIPPAGE_BPS || 100);

  const balance = await gd.balanceOf(wallet.address);
  const amountIn = balance > keep ? balance - keep : 0n;
  if (amountIn === 0n) { console.log('Nothing to swap.'); return; }

  const amounts = await router.getAmountsOut(amountIn, swapPath);
  const quoted  = amounts[amounts.length - 1];
  const minOut  = quoted * (10000n - slipBps) / 10000n;
  console.log(`Treasury ${wallet.address}`);
  console.log(`Swap ${ethers.formatUnits(amountIn, 18)} G$ → ~${ethers.formatUnits(quoted, 18)} cUSD (min ${ethers.formatUnits(minOut, 18)})`);
  if (!execute) { console.log('Dry run — pass --execute to swap.'); return; }

  if ((await gd.allowance(wallet.address, SWAP_ROUTER)) < amountIn) {
    await (await gd.approve(SWAP_ROUTER, amountIn)).wait();
  }
  const tx = await router.swapExactTokensForTokens(amountIn, minOut, swapPath, wallet.address, Math.floor(Date.now() / 1000) + 600);
  const receipt = await tx.wait();
  console.log(`Swapped in ${receipt.hash}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
