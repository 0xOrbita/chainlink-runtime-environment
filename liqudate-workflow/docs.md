# Liquidation Workflow

Cron-triggered CRE workflow that monitors Nuro-Fi lending pools, detects undercollateralized positions, and executes liquidations.

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
CRE_ETH_PRIVATE_KEY=0x... bun run simulate:direct
```

- `DRY_RUN = true` (default) → reads + logs only, no TX sent
- Set `DRY_RUN = false` in `simulate.ts` to execute approve + liquidation

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
1. bun run simulate:direct       <- dry run, check health logs
2. set DRY_RUN = false           <- in simulate.ts
3. bun run simulate:direct       <- execute on-chain directly
4. bun run deploy                <- hand off to DON for automation
```
