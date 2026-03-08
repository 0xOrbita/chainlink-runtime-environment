/**
 * Liquidation Simulate Script
 *
 * Direct on-chain liquidation using viem (without Chainlink DON).
 * Run: bun run simulate:direct
 *
 * Set DRY_RUN = true  → approve + liquidation TX
 * Set DRY_RUN = false
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { worldchainSepolia } from "viem/chains";
import fs from "fs";
import {
  ERC20_ABI,
  HELPER_ABI,
  LENDING_POOL_ABI,
} from "../contracts/helperAbi.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = false; // Set true for dry run (read-only, no TX sent)

const RPC_URL = "https://worldchain-sepolia.g.alchemy.com/public";

// Load private key from env
const PK = process.env.CRE_ETH_PRIVATE_KEY as string;
if (!PK || PK === "your-eth-private-key") {
  throw new Error("Missing or invalid CRE_ETH_PRIVATE_KEY in environment");
}

const formattedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
const account = privateKeyToAccount(formattedPK as `0x${string}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Values from isLiquidatable() are scaled by 1e18
function formatUsd(value: bigint): string {
  const whole = value / 10n ** 18n;
  let frac = ((value % 10n ** 18n) * 100n) / 10n ** 18n;
  let fracStr = frac.toString().replace(/0+$/, "");
  if (fracStr.length < 2) fracStr = fracStr.padEnd(2, "0");
  return `$${whole}.${fracStr}`;
}

function calculateHealthFactor(
  collateralLimit: bigint,
  borrowValue: bigint,
): { hf: string; status: string } {
  if (borrowValue === 0n) return { hf: "∞", status: "✅ safe" };

  const colLimit = Number(collateralLimit) / 1e18;
  const bor = Number(borrowValue) / 1e18;

  // =========================================================================
  // MATCHING HEALTH FACTOR & BORROW LIMIT
  // =========================================================================
  // 1) Borrow Limit (Max debt) = Raw Collateral Value x Liquidation Threshold
  //    Example                  = $1900.00 (Total WETH) x 82.5% = $1567.50
  //
  //    * Smart Contract `isLiquidatable()` already returns this value
  //
  // 2) Health Factor (HF)        = Borrow Limit / Total Debt (Borrow Debt)
  //    Example                    = $1567.50 / $1360.00 = 1.1525 (⚠️ Risky)
  // =========================================================================

  const hf = colLimit / bor;

  if (hf > 10) return { hf: "∞", status: "✅ safe" };

  const hfStr = hf.toFixed(2);
  if (hf > 1.5) return { hf: hfStr, status: "✅ safe" };
  if (hf >= 1.0) return { hf: hfStr, status: "⚠️ risky" };
  return { hf: hfStr, status: "🔴 liquidation" };
}

// ---------------------------------------------------------------------------
// Fetch semua lending pools + borrowers dari Orbita indexer
// ---------------------------------------------------------------------------

interface PoolInfo {
  lendingPool: string;
  borrowToken: string;
}

interface BorrowDebt {
  user: string;
  lendingPoolAddress: string;
  amount: string;
}

async function graphql<T>(indexerUrl: string, query: string): Promise<T> {
  const resp = await fetch(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`Indexer HTTP error: ${resp.status}`);
  return resp.json() as Promise<T>;
}

async function fetchAllPools(
  indexerUrl: string,
): Promise<Map<string, PoolInfo>> {
  const json = await graphql<{
    data?: { lendingPoolCreateds?: { items?: PoolInfo[] } };
  }>(
    indexerUrl,
    `{ lendingPoolCreateds(limit: 500) { items { lendingPool borrowToken } } }`,
  );

  const pools = new Map<string, PoolInfo>();
  for (const item of json?.data?.lendingPoolCreateds?.items ?? []) {
    pools.set(item.lendingPool.toLowerCase(), item);
  }
  return pools;
}

async function fetchBorrowersByPool(
  indexerUrl: string,
): Promise<Map<string, string[]>> {
  const json = await graphql<{
    data?: { borrowDebts?: { items?: BorrowDebt[] } };
  }>(
    indexerUrl,
    `{ borrowDebts(limit: 1000) { items { user lendingPoolAddress amount } } }`,
  );

  const poolBorrowers = new Map<string, string[]>();
  for (const item of json?.data?.borrowDebts?.items ?? []) {
    if (BigInt(item.amount ?? "0") <= 0n) continue;
    const pool = item.lendingPoolAddress.toLowerCase();
    if (!poolBorrowers.has(pool)) poolBorrowers.set(pool, []);
    poolBorrowers.get(pool)!.push(item.user);
  }
  // deduplicate
  for (const [pool, users] of poolBorrowers) {
    poolBorrowers.set(pool, [...new Set(users)]);
  }
  return poolBorrowers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = JSON.parse(fs.readFileSync("./config.staging.json", "utf-8"));

  const publicClient = createPublicClient({
    chain: worldchainSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: worldchainSepolia,
    transport: http(RPC_URL),
  });

  console.log(`\nWallet: ${account.address}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`Helper: ${config.helperAddress}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`ETH balance: ${balance} wei\n`);

  const approvedPools = new Set<string>();
  const summaryTable: any[] = [];

  // 1. Fetch semua pools (lendingPool + borrowToken) dan borrowers dari indexer
  let pools: Map<string, PoolInfo>;
  let poolBorrowers: Map<string, string[]>;
  try {
    [pools, poolBorrowers] = await Promise.all([
      fetchAllPools(config.indexerUrl),
      fetchBorrowersByPool(config.indexerUrl),
    ]);
  } catch (e: any) {
    console.log(`[ERROR] Indexer fetch failed: ${e.message}`);
    return;
  }

  console.log(`\nDiscovered ${pools.size} lending pools from indexer`);

  const width = 80;
  const borderLine = "─".repeat(width);
  const logRow = (text: string) => {
    console.log(`│ ${text.padEnd(width - 2, " ")} │`);
  };

  for (const [poolKey, borrowers] of poolBorrowers) {
    const pool = pools.get(poolKey);
    if (!pool) {
      console.log(`[WARN] No pool info for ${poolKey}, skipping`);
      continue;
    }

    if (borrowers.length === 0) continue;

    console.log(`\n┌${borderLine}┐`);
    logRow(`POOL SUMMARY`);
    console.log(`├${borderLine}┤`);
    logRow(`Lending Pool: ${pool.lendingPool}`);
    logRow(`Borrow Token: ${pool.borrowToken}`);
    console.log(`└${borderLine}┘`);

    let activeBorrowersCount = 0;

    for (const borrower of borrowers) {
      // 2. Check health on-chain
      let liquidatable: boolean;
      let borrowValue: bigint;
      let collateralValue: bigint;

      try {
        [liquidatable, borrowValue, collateralValue] =
          (await publicClient.readContract({
            address: config.helperAddress as Address,
            abi: HELPER_ABI,
            functionName: "isLiquidatable",
            args: [borrower as Address, pool.lendingPool as Address],
          })) as [boolean, bigint, bigint, bigint];
      } catch (e: any) {
        console.log(
          `[ERROR] isLiquidatable failed: ${e.shortMessage || e.message}`,
        );
        continue;
      }

      if (borrowValue === 0n && collateralValue === 0n) continue;

      activeBorrowersCount++;

      const { hf, status: hfStatus } = calculateHealthFactor(
        collateralValue,
        borrowValue,
      );

      console.log(`\n┌${borderLine}┐`);
      logRow(`Borrower:     ${borrower}`);
      logRow(`Health Factor:${hf} (${hfStatus})`);
      logRow(`Borrow Debt:  ${formatUsd(borrowValue)}`);
      logRow(`Borrow Limit: ${formatUsd(collateralValue)}`);
      console.log(`├${borderLine}┤`);

      if (!liquidatable) {
        logRow(`Status:       HEALTHY, skipping execution`);
        console.log(`└${borderLine}┘`);
        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: hf,
          Borrow: formatUsd(borrowValue),
          "Limit (Col)": formatUsd(collateralValue),
          Action: "SKIPPED",
          Tx: "-",
        });
        continue;
      }

      logRow(`Status:       LIQUIDATABLE`);

      if (DRY_RUN) {
        logRow(`Action:       DRY_RUN=true, skipping tx broadcast`);
        console.log(`└${borderLine}┘`);
        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: hf,
          Borrow: formatUsd(borrowValue),
          "Limit (Col)": formatUsd(collateralValue),
          Action: "DRY RUN",
          Tx: "-",
        });
        continue;
      }

      // 3. Approve borrow token (sekali per pool)
      if (!approvedPools.has(pool.lendingPool)) {
        logRow(`[APPROVE]     ${pool.borrowToken} -> ${pool.lendingPool}...`);
        try {
          const approveTx = await walletClient.writeContract({
            address: pool.borrowToken as Address,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [
              pool.lendingPool as Address,
              BigInt(
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              ),
            ],
          });

          process.stdout.write(
            `│ [APPROVE]     Waiting for tx confirmation...`.padEnd(width, " ") + `│\r`,
          );
          await publicClient.waitForTransactionReceipt({ hash: approveTx });
          logRow(`[APPROVE]     Confirmed: ${approveTx}`);
          approvedPools.add(pool.lendingPool);
        } catch (e: any) {
          logRow(`[ERROR]       approve failed: ${e.shortMessage || e.message}`);
          console.log(`└${borderLine}┘`);
          break;
        }
      }

      // 4. Execute liquidation
      try {
        const liquidateTx = await walletClient.writeContract({
          address: pool.lendingPool as Address,
          abi: LENDING_POOL_ABI,
          functionName: "liquidation",
          args: [borrower as Address],
        });

        process.stdout.write(
          `│ [LIQUIDATE]   Waiting for tx confirmation...`.padEnd(width, " ") + `│\r`,
        );

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: liquidateTx,
        });
        logRow(`[LIQUIDATED]  Tx: ${liquidateTx}`);
        logRow(`[LIQUIDATED]  Block: ${receipt.blockNumber} (Status: ${receipt.status})`);
        console.log(`└${borderLine}┘`);

        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: hf,
          Borrow: formatUsd(borrowValue),
          "Limit (Col)": formatUsd(collateralValue),
          Action: "LIQUIDATED",
          Tx: liquidateTx,
        });
      } catch (e: any) {
        logRow(`[ERROR]       liquidation failed: ${e.shortMessage || e.message}`);
        console.log(`└${borderLine}┘`);

        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: hf,
          Borrow: formatUsd(borrowValue),
          "Limit (Col)": formatUsd(collateralValue),
          Action: "ERROR",
          Tx: e.shortMessage || e.message,
        });
      }
    }

    console.log(`\nActive borrowers processed for pool: ${activeBorrowersCount}`);
  }

  console.log(`\n\n======================================`);
  console.log(`      📊 EXECUTION SUMMARY`);
  console.log(`======================================\n`);
  if (summaryTable.length > 0) {
    console.table(summaryTable);
  } else {
    console.log("No active borrowers found across any pools.");
  }
}

main().catch(console.error);
