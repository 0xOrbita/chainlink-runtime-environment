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

Target environments and RPC URLs are configured in `/Users/danuste/Desktop/hackaton/cre/custom-data-feed/project.yaml`.

## 4. Local Simulation
The CRE simulator allows you to mock network interactions against local logic. We use it to verify the workflow functionality offline.

Ensure you are at the project root `custom-data-feed` when running the simulation so it picks up the correct config values out of `project.yaml`.

Run a local simulation using `cre workflow simulate`:

```bash
cd /Users/danuste/Desktop/hackaton/cre/custom-data-feed
cre workflow simulate ./data-feed-workflow --target local-simulation
```

## 5. Deploying to Testnet
When you are ready, you can deploy the finalized workflow script to the Testnet DON (Decentralized Oracle Network).

```bash
cd /Users/danuste/Desktop/hackaton/cre/custom-data-feed
cre workflow deploy ./data-feed-workflow --target production-settings
```
