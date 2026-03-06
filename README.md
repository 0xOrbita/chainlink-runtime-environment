# Orbita Custom Data Feed & Liquidation Keeper 🤖

This project contains the Chainlink CRE (Custom Runtime Environment) Workflows powering the Orbita decentralized lending protocol. It handles real-world Oracle price Discovery and autonomous position Liquidations.

## Repository Structure

The project is split into two primary Chainlink CRE workflows:

1. **`data-feed-workflow/`**: Responsible for polling off-chain API prices (such as Binance) and pushing updates to the on-chain Oracle smart contracts. 
2. **`liqudate-workflow/`**: Responsible for scanning the Orbita Lending Pools, verifying borrower Health Factors (`isLiquidatable`), and executing smart contract Liquidations.

## Prerequisites

Before running any script locally, make sure you have:
1. Installed [Bun](https://bun.sh/).
2. Copied your Ethereum Private Key into a `.env` file at the root of the project:
   ```env
   CRE_ETH_PRIVATE_KEY=0x...
   ```

## Installation
Run `bun install` individually inside each workflow folder fully resolve their dependencies:
```bash
cd data-feed-workflow && bun install
cd ../liqudate-workflow && bun install
```

## Running the Workflows

### 🏎️ Sequential Script (Recommended)
You can directly simulate both workflows interacting with the blockchain locally without needing to spin up the official Chainlink DON mock sandbox. 

Simply run the parallel bash script from the root directory:
```bash
chmod +x run-local.sh
./run-local.sh
```
This script will sequentially:
1. Update Oracle Prices (using Real API or Mocks).
2. Scan Active Borrowers in the Lending Pools.
3. Automatically execute liquidations against undercollateralized accounts.
4. Provide a beautifully formatted Terminal Logging Table summarizing the outcome.

### 📝 Individual Scripts
If you want to evaluate workflows individually, navigate into their specific folders and run the direct `viem` execution driver:

```bash
cd data-feed-workflow
bun run simulate:direct
```
*or*

```bash
cd liqudate-workflow
bun run simulate:direct
```

## Official Documentation
For advanced configurations such as `USE_BINANCE_PRICES`, or steps for deploying scripts onto the live Decentralized Oracle Network, please review the specific README inside each respective workflow subdirectory:
- [Data Feed Docs](./docs.md)
- [Liquidation Docs](./liqudate-workflow/docs.md)
