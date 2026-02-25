/**
 * Orbita CRE Price Feed Workflow
 *
 * Cron-triggered workflow that:
 * 1. Reads latestRoundData() from each oracle contract on World Chain Sepolia
 * 2. Checks for stale prices and deviation against last known values
 * 3. If update needed, calls setPrice() on each oracle contract
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
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
} from "viem";
import { z } from "zod";
import {
  AGGREGATOR_V3_ABI,
  ORACLE_ABI,
  PRICE_CONSUMER_ABI,
} from "../contracts/abi.js";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------
const oracleSchema = z.object({
  name: z.string(),
  address: z.string(),
  feedId: z.string(),
});

const configSchema = z.object({
  schedule: z.string().default("*/30 * * * * *"),
  chainSelectorName: z
    .string()
    .default("ethereum-testnet-sepolia-worldchain-1"),
  priceConsumerAddress: z.string().default(""),
  stalenessThresholdSeconds: z.number().default(3600),
  deviationThresholdBps: z.number().default(100), // 1% = 100 bps
  enableWrite: z.boolean().default(false), // set true to actually call setPrice()
  oracles: z.array(oracleSchema),
});

type Config = z.infer<typeof configSchema>;
type Oracle = z.infer<typeof oracleSchema>;

// ---------------------------------------------------------------------------
// In-memory state: track last submitted prices for deviation check
// ---------------------------------------------------------------------------
const lastKnownPrices = new Map<
  string,
  { answer: bigint; updatedAt: bigint }
>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(answer: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = answer / divisor;
  const frac = (answer % divisor).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

function isStale(updatedAt: bigint, thresholdSeconds: number): boolean {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  return nowSeconds - updatedAt > BigInt(thresholdSeconds);
}

function hasDeviation(
  newAnswer: bigint,
  oldAnswer: bigint,
  thresholdBps: number,
): boolean {
  if (oldAnswer === 0n) return true;
  const diff =
    newAnswer > oldAnswer ? newAnswer - oldAnswer : oldAnswer - newAnswer;
  const deviationBps = (diff * 10000n) / oldAnswer;
  return deviationBps >= BigInt(thresholdBps);
}

// ---------------------------------------------------------------------------
// Read latestRoundData from oracle
// ---------------------------------------------------------------------------

interface RoundData {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: number;
}

function readOraclePrice(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  oracle: Oracle,
): RoundData | null {
  if (!oracle.address || oracle.address === `0x${"0".repeat(40)}`) {
    runtime.log(`[SKIP] ${oracle.name}: address not configured`);
    return null;
  }

  try {
    const roundCallData = encodeFunctionData({
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    });

    const roundResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: oracle.address as Address,
          data: roundCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
      decodeFunctionResult({
        abi: AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
        data: bytesToHex(roundResult.data),
      }) as [bigint, bigint, bigint, bigint, bigint];

    const decimalsCallData = encodeFunctionData({
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    });

    const decimalsResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: oracle.address as Address,
          data: decimalsCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const decimals = decodeFunctionResult({
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
      data: bytesToHex(decimalsResult.data),
    }) as number;

    return { roundId, answer, startedAt, updatedAt, answeredInRound, decimals };
  } catch (err) {
    runtime.log(`[ERROR] ${oracle.name}: read failed - ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write: call setPrice(price, timestamp) on oracle contract
// ---------------------------------------------------------------------------

function updateOraclePrice(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  oracle: Oracle,
  newPrice: bigint,
  timestamp: bigint,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: ORACLE_ABI,
      functionName: "setPrice",
      args: [newPrice],
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
        receiver: oracle.address as Address,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(
        `[ERROR] ${oracle.name}: setPrice tx failed - hash=${resp.txHash}`,
      );
      return false;
    }

    runtime.log(
      `[WRITE] ${oracle.name}: setPrice(${newPrice}, ${timestamp}) ok - tx=${resp.txHash}`,
    );
    return true;
  } catch (err: any) {
    runtime.log(`[ERROR] ${oracle.name}: setPrice failed - ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read stored price from OrbitaPriceConsumer
// ---------------------------------------------------------------------------

function readStoredPrice(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  feedId: string,
  priceConsumerAddress: string,
): { price: bigint; timestamp: number } | null {
  if (!priceConsumerAddress) return null;

  try {
    const tsCallData = encodeFunctionData({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestTimestamp",
      args: [feedId as `0x${string}`],
    });

    const tsResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: priceConsumerAddress as Address,
          data: tsCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const timestamp = decodeFunctionResult({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestTimestamp",
      data: bytesToHex(tsResult.data),
    }) as number;

    const priceCallData = encodeFunctionData({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestPrice",
      args: [feedId as `0x${string}`],
    });

    const priceResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: priceConsumerAddress as Address,
          data: priceCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const price = decodeFunctionResult({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestPrice",
      data: bytesToHex(priceResult.data),
    }) as bigint;

    return { price, timestamp };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main cron callback
// ---------------------------------------------------------------------------

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  const ts = new Date().toISOString();

  runtime.log(`[${ts}] === Orbita CRE PriceFeed cycle start ===`);

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
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  let updated = 0;
  let skipped = 0;

  for (const oracle of config.oracles) {
    runtime.log(`[READ] ${oracle.name} @ ${oracle.address}`);

    const data = readOraclePrice(runtime, evmClient, oracle);

    if (!data) {
      skipped++;
      continue;
    }

    const formatted = formatPrice(data.answer, data.decimals);
    const stale = isStale(data.updatedAt, config.stalenessThresholdSeconds);
    const updatedAtDate = new Date(Number(data.updatedAt) * 1000).toISOString();

    runtime.log(
      `[PRICE] ${oracle.name}: $${formatted} | ` +
        `decimals=${data.decimals} | updatedAt=${updatedAtDate} | stale=${stale}`,
    );

    // Deviation check
    const last = lastKnownPrices.get(oracle.name);
    const deviated = last
      ? hasDeviation(data.answer, last.answer, config.deviationThresholdBps)
      : true;

    if (stale)
      runtime.log(
        `[STALE] ${oracle.name}: >${config.stalenessThresholdSeconds}s old`,
      );
    if (deviated && last) {
      const bps =
        ((data.answer > last.answer
          ? data.answer - last.answer
          : last.answer - data.answer) *
          10000n) /
        last.answer;
      runtime.log(`[DEVIATION] ${oracle.name}: ${Number(bps) / 100}% change`);
    }

    // Read OrbitaPriceConsumer stored state
    if (config.priceConsumerAddress && oracle.feedId) {
      const stored = readStoredPrice(
        runtime,
        evmClient,
        oracle.feedId,
        config.priceConsumerAddress,
      );
      if (stored) {
        runtime.log(
          `[CONSUMER] ${oracle.name}: stored price=${stored.price} ts=${stored.timestamp}`,
        );
      }
    }

    const needsUpdate = stale || deviated;

    // Write: update oracle with setPrice()
    if (needsUpdate && config.enableWrite) {
      runtime.log(`[WRITE] ${oracle.name}: calling setPrice...`);
      const ok = updateOraclePrice(
        runtime,
        evmClient,
        oracle,
        data.answer,
        nowSeconds,
      );
      if (ok) {
        updated++;
        lastKnownPrices.set(oracle.name, {
          answer: data.answer,
          updatedAt: nowSeconds,
        });
      }
    } else if (needsUpdate) {
      runtime.log(
        `[SKIP-WRITE] ${oracle.name}: needs update but enableWrite=false`,
      );
      lastKnownPrices.set(oracle.name, {
        answer: data.answer,
        updatedAt: data.updatedAt,
      });
      skipped++;
    } else {
      runtime.log(`[OK] ${oracle.name}: no update needed`);
      lastKnownPrices.set(oracle.name, {
        answer: data.answer,
        updatedAt: data.updatedAt,
      });
    }
  }

  runtime.log(`[DONE] updated=${updated} skipped=${skipped} ts=${ts}`);
  return "complete";
};

// ---------------------------------------------------------------------------
// Workflow initializer
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
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
