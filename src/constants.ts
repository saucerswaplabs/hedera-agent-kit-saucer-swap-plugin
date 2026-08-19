// Configuration constants for SaucerSwap plugin
export const SAUCER_SWAP_CONFIG = {
  DEFAULT_DEADLINE_SECONDS: 120, // 2 minutes

  // Gas limits
  SWAP_GAS_LIMIT: 15_000_000,
  QUOTE_GAS_LIMIT: 15_000_000,

  // Gas price (in tinybar)
  DEFAULT_GAS_PRICE: 100_000_000,

  // Mirror node call defaults
  MIRROR_NODE_FROM_ADDRESS: "0x0000000000000000000000000000000000000032", // System account
} as const;
