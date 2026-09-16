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

  // V3 orderbook API policy limits (see orderbook_api_integration_guide.md §7.0)
  ORDERBOOK_MAX_BUILD_BATCH: 250,
  ORDERBOOK_MAX_CANCEL_BATCH: 500,
  ORDERBOOK_DEFAULT_LIMIT_DEADLINE_SECONDS: 3600, // default LIMIT order deadline (1 hour)
} as const;
