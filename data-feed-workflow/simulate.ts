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
  ]);

  // We'll write the same mock price + timestamp structure the workflow does
  const price = 100000000n; // $1.00 for stablecoins, we'll use this for test

  for (const oracle of config.oracles) {
    const address = oracle.address as Address;
    console.log(`Writing price to ${oracle.name} @ ${address}...`);

    try {
      // Broadcast actual transaction
      const txHash = await walletClient.writeContract({
        address,
        abi,
        functionName: "setPrice",
        args: [price],
      });
      console.log(`[SUCCESS] ${oracle.name} - Transaction Hash: ${txHash}`);

      console.log(`Waiting for confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      console.log(`[CONFIRMED] Block: ${receipt.blockNumber}`);
    } catch (e: any) {
      console.log(`[FAILED] ${oracle.name} - ${e.shortMessage || e.message}`);
    }
  }
}

main().catch(console.error);
