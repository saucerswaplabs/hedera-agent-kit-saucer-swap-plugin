import { LedgerId } from "@hiero-ledger/sdk";
import {
  SaucerSwapV2CompactPool,
  SaucerSwapRestNetwork,
  SaucerSwapApiService,
} from "./saucer-swap-rest-pools-service.interface";

const SAUCERSWAP_REST_BASE_URLS: Record<SaucerSwapRestNetwork, string> = {
  MAINNET: "https://api.saucerswap.finance",
  TESTNET: "https://test-api.saucerswap.finance",
};

/**
 * Answering a single chat message can hit this endpoint several times — listing
 * tokens, resolving a symbol, then finding the pool — and the payload is the same
 * every time. A short shared cache keeps that to one request without letting
 * prices go stale.
 */
const POOLS_CACHE_TTL_MS = 30_000;

const poolsCache = new Map<string, { expiresAt: number; pools: Promise<SaucerSwapV2CompactPool[]> }>();

/**
 * Service to access SaucerSwap REST API V2 pools endpoint:
 * GET /v2/pools – "Get compact data for all SaucerSwap V2 pools".
 *
 * Docs: https://docs.saucerswap.finance/v/developer/rest-api/pools-v2/pools
 */
export class SaucerSwapApiServiceImpl implements SaucerSwapApiService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(ledgerId: LedgerId, apiKey: string) {
    const network = this.mapLedgerToNetwork(ledgerId);
    this.baseUrl = SAUCERSWAP_REST_BASE_URLS[network];

    // The docs provide a demo key that is globally rate limited and not for production use:
    // default: 875e1017-87b8-4b12-8301-6aa1f1aa073b
    // See: https://docs.saucerswap.finance/v/developer/rest-api/pools-v1/pools
    this.apiKey = apiKey;
  }

  /**
   * Calls SaucerSwap V2 "Get compact data for all SaucerSwap V2 pools" endpoint.
   * GET {baseUrl}/v2/pools
   */
  async getAllPoolsCompact(): Promise<SaucerSwapV2CompactPool[]> {
    const cacheKey = this.baseUrl;
    const cached = poolsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.pools;
    }

    const pools = this.fetchAllPoolsCompact();
    poolsCache.set(cacheKey, { expiresAt: Date.now() + POOLS_CACHE_TTL_MS, pools });
    // A failed fetch must not be served for the rest of the TTL.
    pools.catch(() => poolsCache.delete(cacheKey));

    return pools;
  }

  private async fetchAllPoolsCompact(): Promise<SaucerSwapV2CompactPool[]> {
    const url = `${this.baseUrl}/v2/pools`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `SaucerSwap REST "GET /pools" failed with status ${response.status}`
      );
    }

    const pools = (await response.json()) as SaucerSwapV2CompactPool[];
    return pools;
  }

  private mapLedgerToNetwork(ledgerId: LedgerId): SaucerSwapRestNetwork {
    switch (ledgerId.toString()) {
      case LedgerId.MAINNET.toString():
        return "MAINNET";
      case LedgerId.TESTNET.toString():
        return "TESTNET";
      default:
        // Fallback to MAINNET base URL if an unsupported ledger is used.
        return "MAINNET";
    }
  }
}


