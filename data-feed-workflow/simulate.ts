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
const PK = process.env.CRE_ETH_PRIVATE_KEY as `0x${string}`;
if (!PK || PK === "your-eth-private-key") {
  throw new Error("Missing or invalid CRE_ETH_PRIVATE_KEY in environment");
}

const account = privateKeyToAccount(PK.startsWith("0x") ? PK : `0x${PK}`);

// Configuration Toggle
const USE_BINANCE_PRICES = true; // Set to false to use mock prices

// Mock price configurations
const MOCK_BASE_PRICE = 100000000n; // $1.00
const MOCK_WETH_PRICE = 190000000000n; // $1900.00
const MOCK_WBTC_PRICE = 6827614000000n; // $68276.14

// Map Oracle names to Binance symbols
const BINANCE_SYMBOL_MAP: Record<string, string> = {
  "USDT/USD": "USDTBIDR", // USDT/USD isn't a direct pair on Binance often, though we can use it as 1 or fetch something else. We'll handle stablecoins specially.
  "NATIVE/USD": "ETHUSDT", // Assuming Native is ETH on Worldchain
  "WETH/USD": "ETHUSDT",
  "WBTC/USD": "BTCUSDT",
};

async function fetchBinancePrice(symbol: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    );
    if (!response.ok) {
      console.warn(
        `Failed to fetch ${symbol} from Binance: ${response.statusText}`,
      );
      return null;
    }
    const data = await response.json();
    return parseFloat(data.price);
  } catch (error) {
    console.warn(`Error fetching ${symbol} from Binance:`, error);
    return null;
  }
}

async function getOraclePrice(oracleName: string): Promise<bigint> {
  if (!USE_BINANCE_PRICES) {
    // Return Mock Prices
    return oracleName === "WETH/USD" ? MOCK_WETH_PRICE : MOCK_BASE_PRICE;
  }

  // Handle Stablecoins directly if needed, or if mapping is missing
  if (oracleName === "USDT/USD") {
    console.log(
      `[Price Source] Using hardcoded $1.00 for stablecoin ${oracleName}`,
    );
    return 100000000n; // $1.00 with 8 decimals
  }

  const binanceSymbol = BINANCE_SYMBOL_MAP[oracleName];
  if (!binanceSymbol) {
    console.log(
      `[Price Source] No Binance mapping for ${oracleName}, falling back to mock.`,
    );
    return oracleName === "WETH/USD" ? MOCK_WETH_PRICE : MOCK_BASE_PRICE;
  }

  const priceNum = await fetchBinancePrice(binanceSymbol);

  if (priceNum !== null) {
    console.log(`[Price Source] Binance API: ${binanceSymbol} = $${priceNum}`);
    // Convert to BigInt with 8 decimals (multiply by 10^8)
    // Math.round is used to avoid floating point precision issues when converting to BigInt
    return BigInt(Math.round(priceNum * 100000000));
  } else {
    console.log(
      `[Price Source] Binance API fetch failed for ${oracleName}, falling back to mock.`,
    );
    return oracleName === "WETH/USD" ? MOCK_WETH_PRICE : MOCK_BASE_PRICE;
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

  for (const oracle of config.oracles) {
    const address = oracle.address as Address;
    console.log(`\n======================================`);
    console.log(`Evaluating ${oracle.name} @ ${address}`);

    // Specifically mock WETH/USD to $1900 as per requested
    // const price = oracle.name === "WETH/USD" ? 190000000000n : basePrice;

    // Get price based on configuration toggle
    const price = await getOraclePrice(oracle.name);

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
      const frac = (answer % divisor).toString().padStart(decimals, "0");

      console.log(
        `[BEFORE] Current on-chain price: $${whole}.${frac} (Raw: ${answer})`,
      );

      // 2. Broadcast actual transaction
      const txHash = await walletClient.writeContract({
        address,
        abi,
        functionName: "setPrice",
        args: [price],
      });
      console.log(`[WRITE] Broadcasting new price transaction (${price})...`);
      console.log(`[SUCCESS] Transaction Hash: ${txHash}`);

      console.log(`Waiting for confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      console.log(`[CONFIRMED] Block: ${receipt.blockNumber}`);

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
      const newFrac = (newAnswer % divisor).toString().padStart(decimals, "0");

      console.log(
        `[AFTER] New on-chain price: $${newWhole}.${newFrac} (Raw: ${newAnswer})`,
      );
    } catch (e: any) {
      console.log(`[FAILED] ${oracle.name} - ${e.shortMessage || e.message}`);
    }
  }
}

main().catch(console.error);
