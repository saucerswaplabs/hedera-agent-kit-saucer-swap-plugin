import { LedgerId } from "@hiero-ledger/sdk";

// Addresses are the EVM (long-zero) form of the Hedera entity ids listed at
// https://docs.saucerswap.finance/developerx/contract-deployments
//
// `wrappedHBAR` must be the WHBAR *token* id, not the WHBAR contract id — the two
// differ by one on both networks and only the token id appears in pool data:
//   mainnet: token 0.0.1456986 (0x163b5a), contract 0.0.1456985 (0x163b59)
//   testnet: token 0.0.15058   (0x3ad2),   contract 0.0.15057   (0x3ad1)
export const saucerSwapConfig = {
  networks: {
    [LedgerId.MAINNET.toString()]: {
      router: "0x00000000000000000000000000000000003c437a",    // 0.0.3949434 SaucerSwapV2SwapRouter
      wrappedHBAR: "0x0000000000000000000000000000000000163b5a", // 0.0.1456986 WHBAR token
      quoter: "0x00000000000000000000000000000000003c4370",    // 0.0.3949424 SaucerSwapV2QuoterV2
    },
    [LedgerId.TESTNET.toString()]: {
      router: "0x0000000000000000000000000000000000159398",    // 0.0.1414040 SaucerSwapV2SwapRouter
      wrappedHBAR: "0x0000000000000000000000000000000000003ad2", // 0.0.15058 WHBAR token
      quoter: "0x00000000000000000000000000000000001535b2",    // 0.0.1390002 SaucerSwapV2QuoterV2
    },
  }
} as const;

export type SaucerSwapConfig = typeof saucerSwapConfig;
