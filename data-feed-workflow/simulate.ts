import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { worldchainSepolia } from "viem/chains";
import fs from "fs";

const RPC_URL = "https://worldchain-sepolia.g.alchemy.com/public";

// Load private key from env
const PK = process.env.CRE_ETH_PRIVATE_KEY as string;
if (!PK || PK === "your-eth-private-key") {
  throw new Error("Missing or invalid CRE_ETH_PRIVATE_KEY in environment");
}

const formattedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
const account = privateKeyToAccount(formattedPK as `0x${string}`);

// Configuration Toggle
const USE_REAL_PRICES = false; // Set to false to use mock prices

// Mock price configurations
const MOCK_BASE_PRICE = 100000000n; // $1.00
const MOCK_WETH_PRICE = 200000000000n; // $2000.00
const MOCK_WBTC_PRICE = 700000000000n; // $60000.00

// Map Oracle names to MEXC symbols
const MEXC_SYMBOL_MAP: Record<string, string> = {
  "USDT/USD": "USDTUSDC",
  "NATIVE/USD": "USDTUSDC",
  "WETH/USD": "ETHUSDT",
  "WBTC/USD": "BTCUSDT",
};

async function fetchMexcPrice(symbol: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`,
    );
    if (!response.ok) {
      console.warn(
        `Failed to fetch ${symbol} from MEXC: ${response.statusText}`,
      );
      return null;
    }
    const data = (await response.json()) as { price: string };
    return parseFloat(data.price);
  } catch (error) {
    console.warn(`Error fetching ${symbol} from MEXC:`, error);
    return null;
  }
}

async function getOraclePrice(
  oracleName: string,
): Promise<{ price: bigint; source: string }> {
  const getMockPrice = (name: string) => {
    if (name === "WETH/USD") return MOCK_WETH_PRICE;
    if (name === "WBTC/USD") return MOCK_WBTC_PRICE;
    return MOCK_BASE_PRICE;
  };

  if (!USE_REAL_PRICES) {
    // Return Mock Prices
    if (oracleName === "USDT/USD" || oracleName === "NATIVE/USD") {
      return { price: 100000000n, source: "Mocked locally ($1.00)" };
    }
    return { price: getMockPrice(oracleName), source: "Mocked locally" };
  }

  // Handle Stablecoins directly if needed, or if mapping is missing
  if (oracleName === "USDT/USD" || oracleName === "NATIVE/USD") {
    return {
      price: 100000000n,
      source: "Hardcoded $1.00 (Stablecoin/Native Mock)",
    };
  }

  const mexcSymbol = MEXC_SYMBOL_MAP[oracleName];
  if (!mexcSymbol) {
    return {
      price: getMockPrice(oracleName),
      source: "No MEXC mapping found, falling back to mock",
    };
  }

  const priceNum = await fetchMexcPrice(mexcSymbol);

  if (priceNum !== null) {
    return {
      price: BigInt(Math.round(priceNum * 100000000)),
      source: `MEXC API: ${mexcSymbol} = $${priceNum}`,
    };
  } else {
    return {
      price: getMockPrice(oracleName),
      source: "MEXC API fetch failed, falling back to mock",
    };
  }
}

async function main() {
  const publicClient = createPublicClient({
    chain: worldchainSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: worldchainSepolia,
    transport: http(RPC_URL),
  });

  console.log(`Connected wallet: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Wallet Balance: ${balance.toString()} wei`);

  if (balance === 0n) {
    throw new Error("Wallet has no Worldchain Sepolia ETH for gas!");
  }

  // Load target addresses from config
  const config = JSON.parse(fs.readFileSync("./config.staging.json", "utf-8"));

  const abi = parseAbi([
    "function setPrice(int256 price) external",
    "function setPrice(int256 price, uint256 timestamp) external",
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)",
  ]);

  // We'll write the same mock price + timestamp structure the workflow does
  // const basePrice = 100000000n; // $1.00 for stablecoins, we'll use this for test

  const summaryTable: any[] = [];

  const width = 80;
  const borderLine = "─".repeat(width);
  const logRow = (text: string) => {
    console.log(`│ ${text.padEnd(width - 2, " ")} │`);
  };

  for (const oracle of config.oracles) {
    const address = oracle.address as Address;

    // Get price based on configuration toggle
    const { price, source } = await getOraclePrice(oracle.name);

    console.log(`\n┌${borderLine}┐`);
    logRow(`Oracle:     ${oracle.name}`);
    logRow(`Address:    ${address}`);
    logRow(`Source:     ${source}`);
    console.log(`├${borderLine}┤`);

    try {
      // 1. Read before state
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        (await publicClient.readContract({
          address,
          abi,
          functionName: "latestRoundData",
        })) as [bigint, bigint, bigint, bigint, bigint];

      const decimals = (await publicClient.readContract({
        address,
        abi,
        functionName: "decimals",
      })) as number;

      const divisor = 10n ** BigInt(decimals);
      const whole = answer / divisor;
      let frac = (answer % divisor)
        .toString()
        .padStart(decimals, "0")
        .replace(/0+$/, "");
      if (frac.length < 2) frac = frac.padEnd(2, "0");

      logRow(`Before:     $${whole}.${frac} (Raw: ${answer})`);

      // 2. Broadcast actual transaction
      const txHash = await walletClient.writeContract({
        address,
        abi,
        functionName: "setPrice",
        args: [price],
      });
      logRow(`Tx Hash:    ${txHash}`);

      const statusText = `Status:     Waiting for confirmation...`;
      process.stdout.write(`│ ${statusText.padEnd(width - 2, " ")} │\r`);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      logRow(`Status:     Confirmed in Block ${receipt.blockNumber}`);

      // 3. Read after state
      const [
        newRoundId,
        newAnswer,
        newStartedAt,
        newUpdatedAt,
        newAnsweredInRound,
      ] = (await publicClient.readContract({
        address,
        abi,
        functionName: "latestRoundData",
      })) as [bigint, bigint, bigint, bigint, bigint];

      const newWhole = newAnswer / divisor;
      let newFrac = (newAnswer % divisor)
        .toString()
        .padStart(decimals, "0")
        .replace(/0+$/, "");
      if (newFrac.length < 2) newFrac = newFrac.padEnd(2, "0");

      logRow(`After:      $${newWhole}.${newFrac} (Raw: ${newAnswer})`);
      console.log(`└${borderLine}┘`);

      summaryTable.push({
        Oracle: oracle.name,
        "Before ($)": `${whole}.${frac}`,
        "After ($)": `${newWhole}.${newFrac}`,
        Block: receipt.blockNumber.toString(),
        "Tx Hash": txHash,
      });
    } catch (e: any) {
      logRow(`Failed:     ${e.shortMessage || e.message}`);
      console.log(`└${borderLine}┘`);
      summaryTable.push({
        Oracle: oracle.name,
        "Before ($)": "ERROR",
        "After ($)": "ERROR",
        Block: "FAILED",
        "Tx Hash": e.shortMessage || e.message,
      });
    }
  }

  console.log(`\n\n======================================`);
  console.log(`📊 EXECUTION SUMMARY`);
  console.log(`======================================\n`);
  console.table(summaryTable);
}

main().catch(console.error);
