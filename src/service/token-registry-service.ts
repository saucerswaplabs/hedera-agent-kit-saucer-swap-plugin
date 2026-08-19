import { TokenId } from "@hiero-ledger/sdk";
import {
  SaucerSwapApiService,
  SaucerSwapV2CompactPool,
  SaucerSwapV2PoolToken,
} from "./saucer-swap-rest-pools-service.interface";
import { PoolFinderService } from "./pool-finder-service";
import { AmbiguousTokenError, TokenNotFoundError } from "../errors";
import { feeTierToPercent, poolLiquidityUsd, poolSideLiquidityUsd } from "../utils";

/** A token reachable through at least one SaucerSwap V2 pool. */
export type SaucerSwapTokenInfo = {
  /** Hedera token id, e.g. "0.0.456858". The only unambiguous way to name a token. */
  id: string;
  /** Long-zero EVM address of the same token. */
  evmAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number;
  /** This token's share of the USD depth of every V2 pool it sits in. */
  liquidityUsd: number;
  /** How many V2 pools contain the token. */
  poolCount: number;
  dueDiligenceComplete: boolean;
  isFeeOnTransferToken: boolean;
};

export type SaucerSwapPoolSummary = {
  poolId: number;
  contractId: string;
  /** Fee tier in hundredths of a bip: 500 = 0.05 %, 3000 = 0.3 %. */
  fee: number;
  feePercent: number;
  tokenA: { id: string; symbol: string; decimals: number };
  tokenB: { id: string; symbol: string; decimals: number };
  liquidityUsd: number;
};

/** A token that `token` can be swapped for, plus the best pool to do it through. */
export type SaucerSwapSwapRoute = {
  token: SaucerSwapTokenInfo;
  fee: number;
  feePercent: number;
  liquidityUsd: number;
  poolCount: number;
};

export type TokenResolution =
  | { status: 'resolved'; token: SaucerSwapTokenInfo }
  | { status: 'ambiguous'; query: string; candidates: SaucerSwapTokenInfo[] }
  | { status: 'not_found'; query: string; suggestions: SaucerSwapTokenInfo[] };

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

/** How many alternatives a "not found" / "ambiguous" answer offers the user. */
const SUGGESTION_COUNT = 5;

/**
 * Both networks label the wrapped-HBAR token "HBAR" in pool data, but users also
 * write WHBAR or the symbol, so every spelling maps to the configured WHBAR token.
 */
const HBAR_ALIASES = new Set(['HBAR', 'WHBAR', 'HBAR[WRAPPED]', 'WRAPPED HBAR', 'ℏ']);

const HEDERA_ID_PATTERN = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
};

const toEvmAddress = (tokenId: string): string => {
  try {
    return `0x${TokenId.fromString(tokenId).toEvmAddress()}`;
  } catch {
    return '';
  }
};

/**
 * An in-memory index of everything tradable on SaucerSwap V2, built from the
 * compact-pools endpoint.
 *
 * It exists so an agent can answer "what can I swap?" and "which USDC did you
 * mean?" from chat alone, instead of asking the model to recall token ids — a
 * bare `0.0.x` parameter is exactly the kind of thing an LLM hallucinates.
 */
export class SaucerSwapTokenRegistry {
  private constructor(
    private readonly tokensById: Map<string, SaucerSwapTokenInfo>,
    private readonly rawPools: SaucerSwapV2CompactPool[],
    private readonly wrappedHbarTokenId: string,
  ) {}

  static async load(
    apiService: SaucerSwapApiService,
    wrappedHbarTokenId: string,
  ): Promise<SaucerSwapTokenRegistry> {
    const rawPools = await apiService.getAllPoolsCompact();
    const tokensById = new Map<string, SaucerSwapTokenInfo>();

    for (const pool of rawPools) {
      const sides: Array<[SaucerSwapV2PoolToken, string]> = [
        [pool.tokenA, pool.amountA],
        [pool.tokenB, pool.amountB],
      ];
      for (const [token, amount] of sides) {
        const sideLiquidityUsd = poolSideLiquidityUsd(amount, token);
        const known = tokensById.get(token.id);
        if (known) {
          known.liquidityUsd += sideLiquidityUsd;
          known.poolCount += 1;
        } else {
          tokensById.set(token.id, {
            id: token.id,
            evmAddress: toEvmAddress(token.id),
            // Testnet has tokens whose symbol carries stray whitespace (" TIOT dev").
            symbol: (token.symbol ?? '').trim(),
            name: (token.name ?? '').trim(),
            decimals: token.decimals,
            priceUsd: Number(token.priceUsd) || 0,
            liquidityUsd: sideLiquidityUsd,
            poolCount: 1,
            dueDiligenceComplete: Boolean(token.dueDiligenceComplete),
            isFeeOnTransferToken: Boolean(token.isFeeOnTransferToken),
          });
        }
      }
    }

    return new SaucerSwapTokenRegistry(tokensById, rawPools, wrappedHbarTokenId);
  }

  get tokenCount(): number {
    return this.tokensById.size;
  }

  get poolCount(): number {
    return this.rawPools.length;
  }

  getById(tokenId: string): SaucerSwapTokenInfo | undefined {
    return this.tokensById.get(tokenId);
  }

  /** Every tradable token, deepest liquidity first. */
  private byLiquidity(): SaucerSwapTokenInfo[] {
    return [...this.tokensById.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }

  /**
   * Tradable tokens ranked by USD liquidity, optionally filtered by a substring
   * of the symbol or name.
   */
  listTokens(options: { limit?: number; search?: string } = {}): SaucerSwapTokenInfo[] {
    const needle = options.search?.trim().toLowerCase();
    const all = this.byLiquidity();
    const filtered = needle
      ? all.filter(
          t =>
            t.symbol.toLowerCase().includes(needle) ||
            t.name.toLowerCase().includes(needle) ||
            t.id === needle,
        )
      : all;
    return filtered.slice(0, clampLimit(options.limit));
  }

  /** V2 pools ranked by USD depth, optionally only those holding `tokenId`. */
  listPools(options: { limit?: number; tokenId?: string } = {}): SaucerSwapPoolSummary[] {
    const { tokenId } = options;
    return this.rawPools
      .filter(p => !tokenId || p.tokenA.id === tokenId || p.tokenB.id === tokenId)
      .map(p => this.summarisePool(p))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, clampLimit(options.limit));
  }

  /**
   * What `tokenId` can be swapped for in a single hop, deepest route first.
   *
   * SaucerSwap V2 can list the same pair at several fee tiers; each counterpart
   * appears once here, carrying the fee of its deepest pool.
   */
  listRoutesFor(tokenId: string, limit?: number): SaucerSwapSwapRoute[] {
    const routes = new Map<string, SaucerSwapSwapRoute>();

    for (const pool of this.rawPools) {
      const counterpartId =
        pool.tokenA.id === tokenId ? pool.tokenB.id
        : pool.tokenB.id === tokenId ? pool.tokenA.id
        : undefined;
      if (!counterpartId) continue;

      const counterpart = this.tokensById.get(counterpartId);
      if (!counterpart) continue;

      const liquidityUsd = poolLiquidityUsd(pool);
      const known = routes.get(counterpartId);
      if (!known) {
        routes.set(counterpartId, {
          token: counterpart,
          fee: pool.fee,
          feePercent: feeTierToPercent(pool.fee),
          liquidityUsd,
          poolCount: 1,
        });
        continue;
      }

      known.poolCount += 1;
      if (liquidityUsd > known.liquidityUsd) {
        known.liquidityUsd = liquidityUsd;
        known.fee = pool.fee;
        known.feePercent = feeTierToPercent(pool.fee);
      }
    }

    return [...routes.values()]
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, clampLimit(limit));
  }

  /** The WHBAR token, which callers surface to users as native HBAR. */
  isWrappedHbar(tokenId: string): boolean {
    return tokenId === this.wrappedHbarTokenId;
  }

  /**
   * Turns whatever a user typed into a single token.
   *
   * Hedera ids and EVM addresses identify a token outright. Symbols and names do
   * not — anyone can mint a token called "USDC" — so a query matching several
   * tokens comes back as `ambiguous` for the caller to resolve with the user
   * rather than being silently narrowed to the largest match.
   */
  resolve(query: string): TokenResolution {
    const raw = (query ?? '').trim();
    if (!raw) {
      return { status: 'not_found', query: raw, suggestions: this.suggestions() };
    }

    const byIdentifier = this.resolveIdentifier(raw);
    if (byIdentifier) return byIdentifier;

    if (HBAR_ALIASES.has(raw.toUpperCase())) {
      const whbar = this.tokensById.get(this.wrappedHbarTokenId);
      if (whbar) return { status: 'resolved', token: whbar };
    }

    const needle = raw.toLowerCase();
    const tiers: Array<(token: SaucerSwapTokenInfo) => boolean> = [
      t => t.symbol.toLowerCase() === needle,
      t => t.name.toLowerCase() === needle,
      t => t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle),
    ];

    // An exact symbol hit beats a name hit, which beats a substring hit; only
    // within the first tier that matches at all can the result be ambiguous.
    const all = this.byLiquidity();
    for (const matches of tiers.map(tier => all.filter(tier))) {
      if (matches.length === 1) return { status: 'resolved', token: matches[0] };
      if (matches.length > 1) return { status: 'ambiguous', query: raw, candidates: matches };
    }

    return { status: 'not_found', query: raw, suggestions: this.suggestions() };
  }

  /**
   * {@link resolve}, but raises the error the agent should relay to the user.
   *
   * @param role - which parameter is being resolved, e.g. "tokenIn"
   */
  resolveOrThrow(query: string, role?: string): SaucerSwapTokenInfo {
    const resolution = this.resolve(query);
    if (resolution.status === 'resolved') {
      return resolution.token;
    }
    if (resolution.status === 'ambiguous') {
      throw new AmbiguousTokenError(
        resolution.query,
        resolution.candidates.map(t => describeToken(t)),
        role,
      );
    }
    throw new TokenNotFoundError(
      resolution.query,
      resolution.suggestions.map(t => describeToken(t)),
      role,
    );
  }

  /**
   * The deepest pool trading `tokenAId` against `tokenBId`.
   *
   * @throws {PoolNotFoundError} with the counterparts each token *does* trade
   * against, so the agent can offer a real alternative.
   */
  findPoolForTokens(tokenAId: string, tokenBId: string): SaucerSwapV2CompactPool {
    return PoolFinderService.selectDeepestPool(this.rawPools, tokenAId, tokenBId, () =>
      this.buildPairHint(tokenAId, tokenBId),
    );
  }

  private summarisePool(pool: SaucerSwapV2CompactPool): SaucerSwapPoolSummary {
    return {
      poolId: pool.id,
      contractId: pool.contractId,
      fee: pool.fee,
      feePercent: feeTierToPercent(pool.fee),
      tokenA: {
        id: pool.tokenA.id,
        symbol: (pool.tokenA.symbol ?? '').trim(),
        decimals: pool.tokenA.decimals,
      },
      tokenB: {
        id: pool.tokenB.id,
        symbol: (pool.tokenB.symbol ?? '').trim(),
        decimals: pool.tokenB.decimals,
      },
      liquidityUsd: poolLiquidityUsd(pool),
    };
  }

  private resolveIdentifier(raw: string): TokenResolution | undefined {
    let tokenId: string | undefined;

    if (HEDERA_ID_PATTERN.test(raw)) {
      tokenId = raw;
    } else if (EVM_ADDRESS_PATTERN.test(raw)) {
      try {
        tokenId = TokenId.fromEvmAddress(0, 0, raw).toString();
      } catch {
        return undefined;
      }
    }
    if (!tokenId) return undefined;

    const token = this.tokensById.get(tokenId);
    return token
      ? { status: 'resolved', token }
      : { status: 'not_found', query: raw, suggestions: this.suggestions() };
  }

  private suggestions(): SaucerSwapTokenInfo[] {
    return this.listTokens({ limit: SUGGESTION_COUNT });
  }

  /** "USDC (0.0.5449) trades against: HBAR, DAI, ALPHA" for both sides of a failed pair. */
  private buildPairHint(tokenAId: string, tokenBId: string): string {
    const parts: string[] = [];
    for (const tokenId of [tokenAId, tokenBId]) {
      const token = this.tokensById.get(tokenId);
      if (!token) continue;
      const routes = this.listRoutesFor(tokenId, SUGGESTION_COUNT);
      if (!routes.length) continue;
      parts.push(
        `${token.symbol} (${token.id}) trades against: ` +
          routes.map(r => `${r.token.symbol} (${r.token.id})`).join(', '),
      );
    }
    return parts.length
      ? `${parts.join('. ')}. SaucerSwap V2 routing here is single-hop only, so pick a pair that shares a pool.`
      : '';
  }
}

/** Compact one-line token description used in tool output and error messages. */
export const describeToken = (token: SaucerSwapTokenInfo): string =>
  `${token.symbol} — ${token.name} — id ${token.id} — ${token.decimals} decimals — ` +
  `$${formatUsd(token.liquidityUsd)} liquidity in ${token.poolCount} pool(s)`;

export const formatUsd = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1000) return Math.round(value).toLocaleString('en-US');
  return value.toFixed(2);
};
