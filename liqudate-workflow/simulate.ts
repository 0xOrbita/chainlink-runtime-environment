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

// Values dari isLiquidatable() di-scale 1e18
function formatUsd(value: bigint): string {
  const whole = value / 10n ** 18n;
  const frac = ((value % 10n ** 18n) * 100n) / 10n ** 18n;
  return `$${whole}.${frac.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Fetch borrowers dari Orbita indexer
// ---------------------------------------------------------------------------

interface BorrowDebt {
  user: string;
  lendingPoolAddress: string;
  amount: string;
}

async function fetchBorrowers(
  indexerUrl: string,
  lendingPool: string,
): Promise<string[]> {
  const query = `{
    borrowDebts(limit: 500) {
      items {
        user
        lendingPoolAddress
        amount
      }
    }
  }`;

  const resp = await fetch(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) throw new Error(`Indexer HTTP error: ${resp.status}`);

  const json = (await resp.json()) as {
    data?: { borrowDebts?: { items?: BorrowDebt[] } };
  };

  const lendingPoolLower = lendingPool.toLowerCase();
  return (json?.data?.borrowDebts?.items ?? [])
    .filter(
      (item) =>
        item.lendingPoolAddress.toLowerCase() === lendingPoolLower &&
        BigInt(item.amount ?? "0") > 0n,
    )
    .map((item) => item.user);
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

  // Track approved pools
  const approvedPools = new Set<string>();
  const summaryTable: any[] = [];

  for (const pool of config.pools) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`POOL: ${pool.lendingPool}`);
    console.log(`Borrow token: ${pool.borrowToken}`);

    // 1. Fetch borrowers from indexer
    let borrowers: string[];
    try {
      borrowers = await fetchBorrowers(config.indexerUrl, pool.lendingPool);
    } catch (e: any) {
      console.log(`[ERROR] Indexer fetch failed: ${e.message}`);
      continue;
    }

    console.log(`Active borrowers: ${borrowers.length}`);

    for (const borrower of borrowers) {
      console.log(`\n--- borrower: ${borrower}`);

      // 2. Check health on-chain
      let liquidatable: boolean;
      let borrowValue: bigint;
      let collateralValue: bigint;
      let bonus: bigint;

      try {
        [liquidatable, borrowValue, collateralValue, bonus] =
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

      console.log(`  liquidatable  : ${liquidatable}`);
      console.log(`  borrowValue   : ${formatUsd(borrowValue)}`);
      console.log(`  collateralValue: ${formatUsd(collateralValue)}`);
      console.log(`  bonus         : ${formatUsd(bonus)}`);

      if (!liquidatable) {
        console.log(`  → HEALTHY, skip`);
        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: "HEALTHY",
          Borrow: formatUsd(borrowValue),
          Collateral: formatUsd(collateralValue),
          Action: "SKIPPED",
          Tx: "-",
        });
        continue;
      }

      console.log(`  → LIQUIDATABLE`);

      if (DRY_RUN) {
        console.log(`  → DRY_RUN=true, tidak eksekusi TX`);
        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: "LIQUIDATABLE",
          Borrow: formatUsd(borrowValue),
          Collateral: formatUsd(collateralValue),
          Action: "DRY RUN",
          Tx: "-",
        });
        continue;
      }

      // 3. Approve borrow token (sekali per pool)
      if (!approvedPools.has(pool.lendingPool)) {
        console.log(
          `  [APPROVE] ${pool.borrowToken} -> ${pool.lendingPool}...`,
        );
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
          console.log(`  [APPROVE] TX: ${approveTx}`);
          await publicClient.waitForTransactionReceipt({ hash: approveTx });
          console.log(`  [APPROVE] Confirmed`);
          approvedPools.add(pool.lendingPool);
        } catch (e: any) {
          console.log(
            `  [ERROR] approve failed: ${e.shortMessage || e.message}`,
          );
          break;
        }
      }

      // 4. Execute liquidation
      console.log(`  [LIQUIDATE] calling liquidation(${borrower})...`);
      try {
        const liquidateTx = await walletClient.writeContract({
          address: pool.lendingPool as Address,
          abi: LENDING_POOL_ABI,
          functionName: "liquidation",
          args: [borrower as Address],
        });
        console.log(`  [LIQUIDATE] TX: ${liquidateTx}`);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: liquidateTx,
        });
        console.log(
          `  [LIQUIDATED] Block: ${receipt.blockNumber} Status: ${receipt.status}`,
        );

        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: "LIQUIDATABLE",
          Borrow: formatUsd(borrowValue),
          Collateral: formatUsd(collateralValue),
          Action: "LIQUIDATED",
          Tx: liquidateTx,
        });
      } catch (e: any) {
        console.log(
          `  [ERROR] liquidation failed: ${e.shortMessage || e.message}`,
        );
        summaryTable.push({
          Pool: pool.lendingPool,
          Borrower: borrower,
          Health: "LIQUIDATABLE",
          Borrow: formatUsd(borrowValue),
          Collateral: formatUsd(collateralValue),
          Action: "ERROR",
          Tx: e.shortMessage || e.message,
        });
      }
    }
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
