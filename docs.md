# Running the Custom Data Feed Workflow

This guide explains how to install dependencies, run the Chainlink CRE node simulator, and manage the Custom Data Feed workflows in `data-feed-workflow`.

## Prerequisites
Ensure you have [Bun](https://bun.sh/) installed locally. The project uses Bun as the primary package manager and runtime compiler.
```bash
curl -fsSL https://bun.sh/install | bash
```

You also need the Chainlink CRE CLI installed via `cre-setup`. This will happen automatically on dependency fetch.

## 1. Installation

From the `data-feed-workflow` directory, install the project dependencies. This will trigger the postinstall script to download the Chainlink `cre-setup` tools automatically.

```bash
cd data-feed-workflow
bun install
```

## 2. Compiling

Make sure the TypeScript workflow script has no type errors and compiles correctly.

```bash
bun run tsc --noEmit
```

## 3. Configuration

Data feeds are managed by the `config.staging.json` and `config.production.json` files depending on your CLI target flags.
They configure:
- The `chainSelectorName` (Where the EVM writes are sent)
- `priceConsumerAddress` (Target consumer EVM wallet)
- `stalenessThresholdSeconds` and `deviationThresholdBps` (Price deviation rules)
- The array of `oracles` configurations (Source addresses and feed IDs)


## 4. Local Simulation (Single Workflow)
To test either the Data Feed or Liquidation workflows directly against the blockchain (without using the Chainlink DON simulator), you can run the direct on-chain script. 

Make sure `.env` is configured with your `CRE_ETH_PRIVATE_KEY` at the root of the project.

**To run only the Data Feed Evaluator:**
```bash
cd data-feed-workflow
bun run simulate:direct
```
*Note: The Data Feed script (`simulate.ts`) is configured with a `USE_BINANCE_PRICES` toggle. If true, it pulls real-time BTC/ETH prices from Binance. If false (or if the API fails), it gracefully falls back to mock prices like $60k for WBTC.*

**To run only the Liquidation Evaluator:**
```bash
cd liqudate-workflow
bun run simulate:direct
```

## 5. Sequential Simulation (Both Workflows)
You can run both workflows sequentially in a single command from the root directory. This will first update the Oracle prices and then evaluate liquidations based on the fresh data.

```bash
# Ensure it is executable first
chmod +x run-local.sh 

# Run from the root directory
./run-local.sh
```

## 6. Official CRE Simulator & Deployment
If you wish to test the scripts strictly within the official sandboxed CRE simulator environment or deploy them to the active Testnet DON:

```bash
# Run local CRE sandbox simulation
cre workflow simulate ./data-feed-workflow --target local-simulation

# Deploy to Production Testnet
cre workflow deploy ./data-feed-workflow --target production-settings
```