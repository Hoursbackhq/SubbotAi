#!/usr/bin/env node
/**
 * Deploy SubBotCredits to Celo Mainnet
 * Run: node deploy-credits.js
 * Requires: .env with AGENT_PRIVATE_KEY, wallet funded with CELO for gas
 */

require('./load-env');
const { ethers } = require('ethers');
const fs   = require('fs');
const path = require('path');

const CELO_RPC = 'https://forno.celo.org';

async function main() {
  const privateKey = process.env.AGENT_PRIVATE_KEY;
  if (!privateKey) { console.error('AGENT_PRIVATE_KEY not set in .env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(CELO_RPC);
  const wallet   = new ethers.Wallet(privateKey, provider);
  const balance  = await provider.getBalance(wallet.address);

  console.log(`Network:  Celo mainnet`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} CELO`);

  const abi      = JSON.parse(fs.readFileSync('build/SubBotCredits.abi.json', 'utf8'));
  const bytecode = fs.readFileSync('build/SubBotCredits.bytecode.txt', 'utf8').trim();

  console.log(`\nDeploying SubBotCredits...`);
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  // ethers reserves 2x the base fee; Celo's base fee is flat, so 1.3x is plenty and needs far less CELO up front
  const { baseFeePerGas } = await provider.getBlock('latest');
  const maxPriorityFeePerGas = ethers.parseUnits('2.5', 'gwei');
  const maxFeePerGas = baseFeePerGas * 13n / 10n + maxPriorityFeePerGas;
  console.log(`Max fee:  ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei`);
  const contract = await factory.deploy(wallet.address, { maxFeePerGas, maxPriorityFeePerGas }); // agent = deployer
  console.log(`  Tx: ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`  ✅ SubBotCredits → ${address}`);
  console.log(`     CeloScan: https://celoscan.io/address/${address}`);

  // Save to .env
  const envFile = path.join(__dirname, '.env');
  let env = fs.readFileSync(envFile, 'utf8');
  if (env.includes('CREDITS_CONTRACT_ADDRESS=')) {
    env = env.replace(/CREDITS_CONTRACT_ADDRESS=.*/, `CREDITS_CONTRACT_ADDRESS=${address}`);
  } else {
    env += `\nCREDITS_CONTRACT_ADDRESS=${address}\n`;
  }
  fs.writeFileSync(envFile, env);

  console.log(`\n✅ Done. CREDITS_CONTRACT_ADDRESS saved to .env`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
