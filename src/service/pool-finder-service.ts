import { SaucerSwapApiService } from "./saucer-swap-rest-pools-service.interface";
import { SaucerSwapV2CompactPool } from "./saucer-swap-rest-pools-service.interface";
import { PoolNotFoundError } from "../errors";
import { poolLiquidityUsd } from "../utils";

/**
 * Service for finding pools by token pairs
 */
export class PoolFinderService {
  /**
   * Finds a pool for the given token pair
   *
   * @param tokenA - Hedera token address (e.g., "0.0.123456")
   * @param tokenB - Hedera token address (e.g., "0.0.789012")
   * @param apiService - SaucerSwap API service instance
   * @returns The pool matching the token pair
   * @throws {PoolNotFoundError} If no pool exists for the token pair
   */
  static async findPoolForTokens(
    tokenA: string,
    tokenB: string,
    apiService: SaucerSwapApiService
  ): Promise<SaucerSwapV2CompactPool> {
    const pools = await apiService.getAllPoolsCompact();
    return this.selectDeepestPool(pools, tokenA, tokenB);
  }

  /**
   * Picks the pool to trade a pair through.
   *
   * V2 lists the same pair at several fee tiers, so "the first match" is not good
   * enough — the deepest pool gives the quote closest to what the user will get.
   *
   * @param buildHint - called only on failure, to attach usable alternatives to the error
   * @throws {PoolNotFoundError} If no pool exists for the token pair
   */
  static selectDeepestPool(
    pools: SaucerSwapV2CompactPool[],
    tokenA: string,
    tokenB: string,
    buildHint?: () => string,
  ): SaucerSwapV2CompactPool {
    const matches = pools.filter(
      p => (p.tokenA.id === tokenA && p.tokenB.id === tokenB) ||
           (p.tokenA.id === tokenB && p.tokenB.id === tokenA)
    );

    if (!matches.length) {
      throw new PoolNotFoundError(tokenA, tokenB, buildHint?.());
    }

    return matches.reduce((deepest, candidate) =>
      poolLiquidityUsd(candidate) > poolLiquidityUsd(deepest) ? candidate : deepest
    );
  }
}
