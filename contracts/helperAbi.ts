export const HELPER_ABI = [
  {
    inputs: [{ internalType: "address", name: "_factory", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "OwnableInvalidOwner",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "OwnableUnauthorizedAccount",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    inputs: [],
    name: "factory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_lendingPool", type: "address" },
      { internalType: "address", name: "_user", type: "address" },
    ],
    name: "getAddressPosition",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_lendingPool", type: "address" },
      { internalType: "address", name: "_user", type: "address" },
    ],
    name: "getCollateralValue",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_tokenIn", type: "address" },
      { internalType: "address", name: "_tokenOut", type: "address" },
      { internalType: "uint256", name: "_amountIn", type: "uint256" },
      { internalType: "address", name: "_position", type: "address" },
    ],
    name: "getExchangeRate",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            components: [
              { internalType: "uint32", name: "dstEid", type: "uint32" },
              { internalType: "bytes32", name: "to", type: "bytes32" },
              { internalType: "uint256", name: "amountLD", type: "uint256" },
              { internalType: "uint256", name: "minAmountLD", type: "uint256" },
              { internalType: "bytes", name: "extraOptions", type: "bytes" },
              { internalType: "bytes", name: "composeMsg", type: "bytes" },
              { internalType: "bytes", name: "oftCmd", type: "bytes" },
            ],
            internalType: "struct SendParam",
            name: "sendParam",
            type: "tuple",
          },
          {
            components: [
              { internalType: "uint256", name: "nativeFee", type: "uint256" },
              { internalType: "uint256", name: "lzTokenFee", type: "uint256" },
            ],
            internalType: "struct MessagingFee",
            name: "fee",
            type: "tuple",
          },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "uint256", name: "chainId", type: "uint256" },
          { internalType: "uint128", name: "addExecutorLzReceiveOption", type: "uint128" },
        ],
        internalType: "struct BorrowParams",
        name: "params",
        type: "tuple",
      },
      { internalType: "address", name: "_lendingPool", type: "address" },
      { internalType: "bool", name: "_payInLzToken", type: "bool" },
    ],
    name: "getFee",
    outputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_lendingPool", type: "address" },
      { internalType: "address", name: "_user", type: "address" },
    ],
    name: "getMaxBorrowAmount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_token", type: "address" }],
    name: "getTokenValue",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "user", type: "address" },
      { internalType: "address", name: "lendingPool", type: "address" },
    ],
    name: "isLiquidatable",
    outputs: [
      { internalType: "bool", name: "", type: "bool" },
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_factory", type: "address" }],
    name: "setFactory",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// LendingPool contract - liquidation entry point
export const LENDING_POOL_ABI = [
  {
    inputs: [{ internalType: "address", name: "_borrower", type: "address" }],
    name: "liquidation",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ERC20 - for approving borrow token before liquidation
export const ERC20_ABI = [
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
