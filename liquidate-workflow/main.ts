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

const poolSchema = z.object({
  lendingPool: z.string(),
  router: z.string(),
  borrowToken: z.string(),
});

const configSchema = z.object({
  schedule: z.string().default("*/30 * * * * *"),
  chainSelectorName: z
    .string()
    .default("ethereum-testnet-sepolia-worldchain-1"),
  helperAddress: z.string(),
  indexerUrl: z.string(),
  enableLiquidation: z.boolean().default(false),
  pools: z.array(poolSchema),
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

// ---------------------------------------------------------------------------
// Fetch borrowers from Orbita indexer (Ponder GraphQL)
// Fetch ALL borrowDebts then filter client-side to avoid address case mismatch
// ---------------------------------------------------------------------------

interface BorrowDebt {
  user: string;
  lendingPoolAddress: string;
  amount: string;
}

async function fetchBorrowersFromIndexer(
  runtime: Runtime<Config>,
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

  try {
    const client = new HTTPClient();

    // Use native CRE HttpCapability for POST request
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
      return [];
    }

    const rawBody = Buffer.from(response.body).toString("utf-8");
    const json = JSON.parse(rawBody) as {
      data?: { borrowDebts?: { items?: BorrowDebt[] } };
    };

    const lendingPoolLower = lendingPool.toLowerCase();

    return (json?.data?.borrowDebts?.items ?? [])
      .filter(
        (item) =>
          item.lendingPoolAddress.toLowerCase() === lendingPoolLower &&
          BigInt(item.amount ?? "0") > 0n,
      )
      .map((item) => item.user)
      .slice(0, 15); 
  } catch (err) {
    runtime.log(`[ERROR] Indexer Fetch Failed: ${String(err)}`);
    return [];
  }
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

  let totalChecked = 0;
  let totalLiquidated = 0;

  for (const pool of config.pools) {
    runtime.log(`[POOL] lendingPool=${pool.lendingPool}`);

    const borrowers = await fetchBorrowersFromIndexer(
      runtime,
      config.indexerUrl,
      pool.lendingPool,
    );

    runtime.log(`[POOL] ${borrowers.length} active borrowers`);

    for (const borrower of borrowers) {
      totalChecked++;

      const health = checkHealth(
        runtime,
        evmClient,
        borrower,
        pool.lendingPool,
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
      if (!approvedPools.has(pool.lendingPool)) {
        const ok = approveToken(
          runtime,
          evmClient,
          pool.borrowToken,
          pool.lendingPool,
        );
        if (!ok) {
          runtime.log(`[ERROR] approve failed, skipping pool`);
          break;
        }
        approvedPools.add(pool.lendingPool);
      }

      const success = executeLiquidation(
        runtime,
        evmClient,
        borrower,
        pool.lendingPool,
      );
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
