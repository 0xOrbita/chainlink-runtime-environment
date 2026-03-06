
export const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { internalType: "uint80", name: "roundId", type: "uint80" },
      { internalType: "int256", name: "answer", type: "int256" },
      { internalType: "uint256", name: "startedAt", type: "uint256" },
      { internalType: "uint256", name: "updatedAt", type: "uint256" },
      { internalType: "uint80", name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "description",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Oracle contract - setPrice(int256 price) - owner only
export const ORACLE_ABI = [
  {
    inputs: [{ internalType: "int256", name: "newPrice", type: "int256" }],
    name: "setPrice",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { internalType: "uint80", name: "roundId", type: "uint80" },
      { internalType: "int256", name: "answer", type: "int256" },
      { internalType: "uint256", name: "startedAt", type: "uint256" },
      { internalType: "uint256", name: "updatedAt", type: "uint256" },
      { internalType: "uint80", name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// OrbitaPriceConsumer - verifyAndStoreReport accepts signed Chainlink Data Streams report
export const PRICE_CONSUMER_ABI = [
  {
    type: "function",
    name: "verifyAndStoreReport",
    inputs: [{ name: "signedReport", type: "bytes", internalType: "bytes" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "latestPrice",
    inputs: [{ name: "feedId", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "int192", internalType: "int192" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "latestTimestamp",
    inputs: [{ name: "feedId", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "uint32", internalType: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPrice",
    inputs: [{ name: "feedId", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
] as const;
