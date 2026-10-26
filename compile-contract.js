#!/usr/bin/env node
/**
 * Compile SubBotLog.sol and output ABI + bytecode
 * Usage: node compile-contract.js
 */
const solc = require('solc');
const fs   = require('fs');
const path = require('path');

const contracts = ['SubBotLog', 'SubBotCredits', 'SubBotJars'];
const sources   = {};
contracts.forEach(name => {
  sources[`${name}.sol`] = {
    content: fs.readFileSync(path.join(__dirname, `contracts/${name}.sol`), 'utf8')
  };
});

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  if (errors.length) { errors.forEach(e => console.error(e.formattedMessage)); process.exit(1); }
}

const buildDir = path.join(__dirname, 'build');
fs.mkdirSync(buildDir, { recursive: true });

contracts.forEach(name => {
  const contract  = output.contracts[`${name}.sol`][name];
  const abi       = contract.abi;
  const bytecode  = '0x' + contract.evm.bytecode.object;
  fs.writeFileSync(path.join(buildDir, `${name}.abi.json`),      JSON.stringify(abi, null, 2));
  fs.writeFileSync(path.join(buildDir, `${name}.bytecode.txt`),  bytecode);
  console.log(`✅ ${name} compiled — ${(bytecode.length / 2 / 1024).toFixed(1)} KB`);
  console.log(`   ABI      → build/${name}.abi.json`);
  console.log(`   Bytecode → build/${name}.bytecode.txt`);
});
