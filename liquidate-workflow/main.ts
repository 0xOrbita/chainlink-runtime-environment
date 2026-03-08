/**
 * Orbita CRE Liquidation Workflow
 *
 * Cron-triggered workflow that:
 * 1. Fetches active borrowers from the Orbita indexer
 * 2. Checks each borrower's health via Helper.isLiquidatable()
 * 3. If undercollateralized, approves borrow token and calls liquidation()
 */

import {
  bytesToHex,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  HTTPClient,
  type Runtime,
  type NodeRuntime,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  maxUint256,
  zeroAddress,
} from "viem";
import { z } from "zod";
import {
  ERC20_ABI,
  HELPER_ABI,
  LENDING_POOL_ABI,
} from "../contracts/helperAbi.js";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  schedule: z.string().default("*/30 * * * * *"),
  chainSelectorName: z
    .string()
    .default("ethereum-testnet-sepolia-worldchain-1"),
  helperAddress: z.string(),
  indexerUrl: z.string(),
  enableLiquidation: z.boolean().default(false),
});

type Config = z.infer<typeof configSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Values from isLiquidatable() are scaled by 1e18
function formatUsd(value: bigint): string {
  const whole = value / 10n ** 18n;
  const frac = ((value % 10n ** 18n) * 100n) / 10n ** 18n;
  return `$${whole}.${frac.toString().padStart(2, "0")}`;
}

// Fisher-Yates shuffle so each cycle checks a random subset of borrowers
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Fetch all lending pools (with borrowToken) + borrowers from indexer
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

interface IndexerData {
  pools: Map<string, PoolInfo>; // lendingPool (lower) -> PoolInfo
  poolBorrowers: Map<string, string[]>; // lendingPool (lower) -> users
}

function sendIndexerRequest(
  runtime: Runtime<Config>,
  indexerUrl: string,
  query: string,
): string | null {
  try {
    const client = new HTTPClient();
    const responseFn = client.sendRequest(
      runtime as unknown as NodeRuntime<Config>,
      {
        url: indexerUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ query })).toString("base64"),
      },
    );
    const response = responseFn.result();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      runtime.log(`[WARN] Indexer HTTP Error: ${response.statusCode}`);
      return null;
    }
    return Buffer.from(response.body).toString("utf-8");
  } catch (err) {
    runtime.log(`[ERROR] Indexer request failed: ${String(err)}`);
    return null;
  }
}

async function fetchIndexerData(
  runtime: Runtime<Config>,
  indexerUrl: string,
): Promise<IndexerData> {
  const pools = new Map<string, PoolInfo>();
  const poolBorrowers = new Map<string, string[]>();

  // Query 1: all lending pools with their borrowToken
  const poolsQuery = `{
    lendingPoolCreateds(limit: 500) {
      items {
        lendingPool
        borrowToken
      }
    }
  }`;

  const poolsRaw = sendIndexerRequest(runtime, indexerUrl, poolsQuery);
  if (poolsRaw) {
    const json = JSON.parse(poolsRaw) as {
      data?: { lendingPoolCreateds?: { items?: PoolInfo[] } };
    };
    for (const item of json?.data?.lendingPoolCreateds?.items ?? []) {
      pools.set(item.lendingPool.toLowerCase(), {
        lendingPool: item.lendingPool,
        borrowToken: item.borrowToken,
      });
    }
  }

  runtime.log(`[DISCOVERY] Found ${pools.size} lending pools from indexer`);

  // Query 2: all active borrowDebts
  const debtsQuery = `{
    borrowDebts(limit: 1000) {
      items {
        user
        lendingPoolAddress
        amount
      }
    }
  }`;

  const debtsRaw = sendIndexerRequest(runtime, indexerUrl, debtsQuery);
  if (debtsRaw) {
    const json = JSON.parse(debtsRaw) as {
      data?: { borrowDebts?: { items?: BorrowDebt[] } };
    };
    for (const item of json?.data?.borrowDebts?.items ?? []) {
      if (BigInt(item.amount ?? "0") <= 0n) continue;
      const pool = item.lendingPoolAddress.toLowerCase();
      if (!poolBorrowers.has(pool)) poolBorrowers.set(pool, []);
      poolBorrowers.get(pool)!.push(item.user);
    }
  }

  return { pools, poolBorrowers };
}

// ---------------------------------------------------------------------------
// On-chain: check health via Helper.isLiquidatable()
// Returns [liquidatable, borrowValue (1e18), collateralValue (1e18), bonus (1e18)]
// ---------------------------------------------------------------------------

interface HealthResult {
  liquidatable: boolean;
  borrowValue: bigint;
  collateralValue: bigint;
  bonus: bigint;
}

function checkHealth(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  borrower: string,
  lendingPool: string,
  helperAddress: string,
): HealthResult | null {
  try {
    const callData = encodeFunctionData({
      abi: HELPER_ABI,
      functionName: "isLiquidatable",
      args: [borrower as Address, lendingPool as Address],
    });

    const result = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: "0x0000000000000000000000000000000000000000" as Address,
          to: helperAddress as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const [liquidatable, borrowValue, collateralValue, bonus] =
      decodeFunctionResult({
        abi: HELPER_ABI,
        functionName: "isLiquidatable",
        data: bytesToHex(result.data),
      }) as [boolean, bigint, bigint, bigint];

    return { liquidatable, borrowValue, collateralValue, bonus };
  } catch (err) {
    runtime.log(`[ERROR] isLiquidatable(${borrower}): ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// On-chain: approve borrow token for lendingPool (once per pool per cycle)
// ---------------------------------------------------------------------------

function approveToken(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  tokenAddress: string,
  spender: string,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as Address, maxUint256],
    });

    const report = runtime
      .report({
        encodedPayload: hexToBase64(callData),
        encoderName: "evm",
        signingAlgo: "ecdsa",
        hashingAlgo: "keccak256",
      })
      .result();

    const resp = evmClient
      .writeReport(runtime, {
        receiver: tokenAddress as Address,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(`[ERROR] approve failed - tx=${resp.txHash}`);
      return false;
    }

    runtime.log(
      `[APPROVE] token=${tokenAddress} spender=${spender} tx=${resp.txHash}`,
    );
    return true;
  } catch (err) {
    runtime.log(`[ERROR] approve: ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// On-chain: execute liquidation
// ---------------------------------------------------------------------------

function executeLiquidation(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  borrower: string,
  lendingPool: string,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: LENDING_POOL_ABI,
      functionName: "liquidation",
      args: [borrower as Address],
    });

    const report = runtime
      .report({
        encodedPayload: hexToBase64(callData),
        encoderName: "evm",
        signingAlgo: "ecdsa",
        hashingAlgo: "keccak256",
      })
      .result();

    const resp = evmClient
      .writeReport(runtime, {
        receiver: lendingPool as Address,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(
        `[ERROR] liquidation(${borrower}) failed - tx=${resp.txHash}`,
      );
      return false;
    }

    runtime.log(
      `[LIQUIDATED] borrower=${borrower} pool=${lendingPool} tx=${resp.txHash}`,
    );
    return true;
  } catch (err) {
    runtime.log(`[ERROR] liquidation(${borrower}): ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main cron callback
// ---------------------------------------------------------------------------

const onCronTrigger = async (runtime: Runtime<Config>): Promise<string> => {
  const config = runtime.config;
  const ts = new Date().toISOString();

  runtime.log(`[${ts}] === Liquidation cycle start ===`);

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    runtime.log(`[ERROR] Network not found: ${config.chainSelectorName}`);
    return "error";
  }

  const evmClient = new EVMClient(network.chainSelector.selector);
  const approvedPools = new Set<string>();

  // CRE callContract limit per workflow execution
  const CALL_LIMIT = 15;
  let callsUsed = 0;
  let totalChecked = 0;
  let totalLiquidated = 0;

  // Fetch all pools (with borrowToken) and active borrowers from indexer
  const { pools, poolBorrowers } = await fetchIndexerData(runtime, config.indexerUrl);

  outer: for (const [lendingPool, borrowers] of poolBorrowers) {
    const poolInfo = pools.get(lendingPool);
    if (!poolInfo) {
      runtime.log(`[WARN] No pool info found for pool=${lendingPool}, skipping`);
      continue;
    }

    const { borrowToken } = poolInfo;
    runtime.log(
      `[POOL] lendingPool=${lendingPool} borrowToken=${borrowToken} borrowers=${borrowers.length}`,
    );

    for (const borrower of shuffle(borrowers)) {
      if (callsUsed >= CALL_LIMIT) {
        runtime.log(`[LIMIT] callContract limit (${CALL_LIMIT}) reached, stopping cycle early`);
        break outer;
      }
      totalChecked++;
      callsUsed++;

      const health = checkHealth(
        runtime,
        evmClient,
        borrower,
        lendingPool,
        config.helperAddress,
      );

      if (!health) continue;

      const { liquidatable, borrowValue, collateralValue, bonus } = health;

      runtime.log(
        `[HEALTH] borrower=${borrower}` +
          ` | liquidatable=${liquidatable}` +
          ` | borrowValue=${formatUsd(borrowValue)}` +
          ` | collateralValue=${formatUsd(collateralValue)}` +
          ` | bonus=${formatUsd(bonus)}`,
      );

      if (!liquidatable) {
        runtime.log(`[OK] ${borrower}: healthy`);
        continue;
      }

      runtime.log(
        `[LIQUIDATABLE] ${borrower}: borrow=${formatUsd(borrowValue)} > collateral threshold`,
      );

      if (!config.enableLiquidation) {
        runtime.log(`[SKIP] enableLiquidation=false`);
        continue;
      }

      // Approve borrow token once per pool per cycle
      if (!approvedPools.has(lendingPool)) {
        const ok = approveToken(runtime, evmClient, borrowToken, lendingPool);
        if (!ok) {
          runtime.log(`[ERROR] approve failed, skipping pool`);
          break;
        }
        approvedPools.add(lendingPool);
      }

      const success = executeLiquidation(runtime, evmClient, borrower, lendingPool);
      if (success) totalLiquidated++;
    }
  }

  runtime.log(
    `[DONE] checked=${totalChecked} liquidated=${totalLiquidated} ts=${ts}`,
  );
  return "complete";
};

// ---------------------------------------------------------------------------
// Workflow initializer
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger as any),
  ];
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema: configSchema as any,
  });
  await runner.run(initWorkflow);
}
