require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("hardhat-gas-reporter");

// Baseline and optimized contracts are compiled with IDENTICAL settings so the
// gas comparison in docs/GAS-EVALUATION.md is a like-for-like measurement.
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "storageLayout"] },
      },
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Ganache GUI, matching the lab setup (its default port is 7545, not 8545)
    ganache: { url: "http://127.0.0.1:7545", chainId: 1337 },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 1,
    showTimeSpent: true,
    noColors: true,
    outputFile: process.env.GAS_OUT || undefined,
  },
  mocha: { timeout: 60000 },
};
