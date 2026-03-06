# Liquidation Workflow

Cron-triggered CRE workflow that monitors Orbita lending pools, detects undercollateralized positions, and executes liquidations.

## Prerequisites

- [Bun](https://bun.sh/) installed
- Wallet with borrow token (USDT/USDC) + ETH for gas
- Oracle price feed running (`data-feed-workflow` deployed)

## Install

```bash
cd liqudate-workflow
bun install
```

---

## Commands

### 1. Direct on-chain script (no DON required)

Reads health status and optionally executes liquidation directly via viem.

```bash
bun run simulate:direct
```
*(The script automatically pulls `CRE_ETH_PRIVATE_KEY` from the root `.env` file)*

- `DRY_RUN = false` (default) → execute approve + liquidation
- Set `DRY_RUN = true` in `simulate.ts` to log and read health without sending TX.

### 2. Sequential Project Run
If you want to run both the Data Feed and Liquidation evaluators sequentially, execute the shell script from the project root:

```bash
cd ..
./run-local.sh
```

---

### 2. CRE Simulate (local — no TX)

Runs the full CRE workflow logic against the real RPC but **mocks all writes**.
Use this to verify the workflow logic before deploying.

```bash
cre workflow simulate ./liqudate-workflow --target local-simulation
```

Or from inside `liqudate-workflow/`:

```bash
bun run simulate:local
```

---

### 3. CRE Simulate (staging)

Same as above but uses `staging-settings` target from `project.yaml`.

```bash
bun run simulate
```

---

### 4. Deploy to DON (production)

Deploys the workflow to the Chainlink Decentralized Oracle Network.
The DON will run the cron automatically every minute and execute liquidations on-chain.

Make sure `config.production.json` has `"enableLiquidation": true` before deploying.

```bash
cre workflow deploy ./liqudate-workflow --target production-settings
```

Or from inside `liqudate-workflow/`:

```bash
bun run deploy
```

---

## Config

| File | `enableLiquidation` | Purpose |
|------|--------------------:|---------|
| `config.staging.json` | `false` | Safe for testing — no TX |
| `config.production.json` | `true` | Live liquidation via DON |

Key addresses (hardcoded in config):

| Contract | Address |
|----------|---------|
| Helper Utils | `0xC72f2eb4A97F19ecD0C10b5201676a10B6D8bB67` |
| Borrow Token (USDT) | `0x04c37dc1b538e00b31e6bc883e16d97cd7937a10` |

---

## Recommended Flow

```
1. ./run-local.sh                <- update oracle prices + dry run health
2. bun run deploy                <- hand off to DON for automation
```
