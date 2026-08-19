import { describe, expect, it } from 'vitest';
import {
  SaucerSwapTokenRegistry,
  formatUsd,
} from '../src/service/token-registry-service';
import {
  SaucerSwapApiService,
  SaucerSwapV2CompactPool,
  SaucerSwapV2PoolToken,
} from '../src/service/saucer-swap-rest-pools-service.interface';
import { AmbiguousTokenError, PoolNotFoundError, TokenNotFoundError } from '../src/errors';

const WHBAR_TOKEN_ID = '0.0.15058';

const token = (
  id: string,
  symbol: string,
  name: string,
  decimals: number,
  priceUsd: number,
): SaucerSwapV2PoolToken => ({
  id,
  name,
  symbol,
  decimals,
  priceUsd,
  icon: '',
  price: '0',
  dueDiligenceComplete: false,
  isFeeOnTransferToken: false,
});

// Mirrors real data: WHBAR is labelled "HBAR", two tokens share the name
// "USD Coin", two unrelated tokens share the symbol "HLQT", and one symbol
// carries stray whitespace.
const WHBAR = token(WHBAR_TOKEN_ID, 'HBAR', 'WHBAR [new]', 8, 0.07);
const USDC = token('0.0.5449', 'USDC', 'USD Coin', 6, 1);
const USDC_HTS = token('0.0.1055459', 'USDC[hts]', 'USD Coin', 6, 0.65);
const DAI = token('0.0.5529', 'DAI', 'Dai', 8, 1);
const HLQT_A = token('0.0.4232758', 'HLQT', 'HLQT', 8, 0.06);
const HLQT_B = token('0.0.4360535', 'HLQT', 'HLQT', 8, 0.001);
const TIOT = token('0.0.5768679', ' TIOT dev', ' TIOT dev ', 8, 0.07);

const pool = (
  id: number,
  tokenA: SaucerSwapV2PoolToken,
  amountA: string,
  tokenB: SaucerSwapV2PoolToken,
  amountB: string,
  fee: number,
): SaucerSwapV2CompactPool => ({
  id,
  contractId: `0.0.${900000 + id}`,
  tokenA,
  tokenB,
  amountA,
  amountB,
  fee,
  sqrtRatioX96: '0',
  tickCurrent: 0,
  liquidity: '0',
});

const POOLS: SaucerSwapV2CompactPool[] = [
  // HBAR/USDC listed at two fee tiers: $1000 deep at 0.3 %, $100 at 0.05 %.
  pool(1, WHBAR, '1000000000000', USDC, '300000000', 3000),
  pool(2, WHBAR, '100000000000', USDC, '30000000', 500),
  pool(3, USDC, '5000000000', DAI, '500000000000', 500),
  pool(4, WHBAR, '10000000000', HLQT_A, '100000000', 3000),
  pool(5, WHBAR, '1000000000', HLQT_B, '100000000', 10000),
  // The API sometimes reports a negative reserve; only the magnitude counts.
  pool(6, WHBAR, '-500000000', TIOT, '0', 3000),
  pool(7, USDC_HTS, '1000000', DAI, '100000000', 500),
];

const fakeApi = (pools: SaucerSwapV2CompactPool[] = POOLS): SaucerSwapApiService => ({
  getAllPoolsCompact: async () => pools,
});

const loadRegistry = (pools?: SaucerSwapV2CompactPool[]) =>
  SaucerSwapTokenRegistry.load(fakeApi(pools), WHBAR_TOKEN_ID);

describe('SaucerSwapTokenRegistry indexing', () => {
  it('indexes every token that appears in a pool', async () => {
    const registry = await loadRegistry();
    expect(registry.tokenCount).toBe(7);
    expect(registry.poolCount).toBe(7);
  });

  it('aggregates USD liquidity and pool count per token', async () => {
    const registry = await loadRegistry();

    // 300 (pool 1) + 30 (pool 2) + 5000 (pool 3)
    const usdc = registry.getById('0.0.5449')!;
    expect(usdc.liquidityUsd).toBeCloseTo(5330, 6);
    expect(usdc.poolCount).toBe(3);

    // 700 + 70 + 7 + 0.7 + 0.35, the last from a negative reserve
    const whbar = registry.getById(WHBAR_TOKEN_ID)!;
    expect(whbar.liquidityUsd).toBeCloseTo(778.05, 6);
    expect(whbar.poolCount).toBe(5);
  });

  it('trims whitespace out of symbols and names', async () => {
    const registry = await loadRegistry();
    const tiot = registry.getById('0.0.5768679')!;
    expect(tiot.symbol).toBe('TIOT dev');
    expect(tiot.name).toBe('TIOT dev');
  });

  it('derives the EVM address from the Hedera id', async () => {
    const registry = await loadRegistry();
    expect(registry.getById(WHBAR_TOKEN_ID)!.evmAddress)
      .toBe('0x0000000000000000000000000000000000003ad2');
  });
});

describe('SaucerSwapTokenRegistry.listTokens', () => {
  it('ranks by USD liquidity', async () => {
    const registry = await loadRegistry();
    expect(registry.listTokens().map(t => t.id)).toEqual([
      '0.0.5449',      // USDC     5330
      '0.0.5529',      // DAI      5001
      WHBAR_TOKEN_ID,  // HBAR      778.05
      '0.0.1055459',   // USDC[hts]   0.65
      '0.0.4232758',   // HLQT_A      0.06
      '0.0.4360535',   // HLQT_B      0.001
      '0.0.5768679',   // TIOT        0
    ]);
  });

  it('honours limit and clamps nonsense values', async () => {
    const registry = await loadRegistry();
    expect(registry.listTokens({ limit: 2 })).toHaveLength(2);
    expect(registry.listTokens({ limit: 0 })).toHaveLength(1);
    expect(registry.listTokens({ limit: 10_000 })).toHaveLength(7);
    expect(registry.listTokens({ limit: Number.NaN })).toHaveLength(7);
  });

  it('filters on symbol and name', async () => {
    const registry = await loadRegistry();
    expect(registry.listTokens({ search: 'usd' }).map(t => t.id))
      .toEqual(['0.0.5449', '0.0.1055459']);
    expect(registry.listTokens({ search: 'dai' }).map(t => t.id)).toEqual(['0.0.5529']);
    expect(registry.listTokens({ search: 'nope' })).toEqual([]);
  });
});

describe('SaucerSwapTokenRegistry.resolve', () => {
  it('resolves a Hedera token id', async () => {
    const registry = await loadRegistry();
    expect(registry.resolve('0.0.5449')).toMatchObject({
      status: 'resolved',
      token: { symbol: 'USDC' },
    });
  });

  it('resolves an EVM address', async () => {
    const registry = await loadRegistry();
    expect(registry.resolve('0x0000000000000000000000000000000000003ad2')).toMatchObject({
      status: 'resolved',
      token: { id: WHBAR_TOKEN_ID },
    });
  });

  it('maps HBAR spellings onto the wrapped HBAR token', async () => {
    const registry = await loadRegistry();
    for (const query of ['HBAR', 'hbar', 'wHBAR', 'WHBAR']) {
      expect(registry.resolve(query)).toMatchObject({
        status: 'resolved',
        token: { id: WHBAR_TOKEN_ID },
      });
    }
  });

  it('prefers an exact symbol match over a substring match', async () => {
    const registry = await loadRegistry();
    // "USDC" is also a substring of "USDC[hts]" — the exact hit must win outright.
    expect(registry.resolve('USDC')).toMatchObject({
      status: 'resolved',
      token: { id: '0.0.5449' },
    });
  });

  it('resolves by name and ignores case', async () => {
    const registry = await loadRegistry();
    expect(registry.resolve('dai')).toMatchObject({
      status: 'resolved',
      token: { id: '0.0.5529' },
    });
  });

  it('reports a shared symbol as ambiguous, deepest first', async () => {
    const registry = await loadRegistry();
    const resolution = registry.resolve('HLQT');
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(resolution.candidates.map(t => t.id)).toEqual(['0.0.4232758', '0.0.4360535']);
  });

  it('reports a shared name as ambiguous', async () => {
    const registry = await loadRegistry();
    const resolution = registry.resolve('USD Coin');
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(resolution.candidates.map(t => t.id)).toEqual(['0.0.5449', '0.0.1055459']);
  });

  it('offers suggestions when nothing matches', async () => {
    const registry = await loadRegistry();
    for (const query of ['Dogecoin', '0.0.999999', '', '   ']) {
      const resolution = registry.resolve(query);
      expect(resolution.status).toBe('not_found');
      if (resolution.status !== 'not_found') continue;
      expect(resolution.suggestions).toHaveLength(5);
      expect(resolution.suggestions[0].id).toBe('0.0.5449');
    }
  });
});

describe('SaucerSwapTokenRegistry.resolveOrThrow', () => {
  it('throws AmbiguousTokenError listing every candidate id', async () => {
    const registry = await loadRegistry();
    try {
      registry.resolveOrThrow('HLQT', 'tokenOut');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousTokenError);
      const ambiguous = error as AmbiguousTokenError;
      expect(ambiguous.code).toBe('AMBIGUOUS_TOKEN');
      expect(ambiguous.message).toContain('tokenOut');
      expect(ambiguous.message).toContain('0.0.4232758');
      expect(ambiguous.message).toContain('0.0.4360535');
    }
  });

  it('throws TokenNotFoundError pointing at the discovery tool', async () => {
    const registry = await loadRegistry();
    try {
      registry.resolveOrThrow('Dogecoin', 'tokenIn');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TokenNotFoundError);
      const notFound = error as TokenNotFoundError;
      expect(notFound.code).toBe('TOKEN_NOT_FOUND');
      expect(notFound.message).toContain('list_saucerswap_tokens_tool');
    }
  });

  it('returns the token when it is unambiguous', async () => {
    const registry = await loadRegistry();
    expect(registry.resolveOrThrow('DAI').id).toBe('0.0.5529');
  });
});

describe('SaucerSwapTokenRegistry.findPoolForTokens', () => {
  it('picks the deepest fee tier for a pair', async () => {
    const registry = await loadRegistry();
    expect(registry.findPoolForTokens(WHBAR_TOKEN_ID, '0.0.5449').fee).toBe(3000);
  });

  it('does not care about token order', async () => {
    const registry = await loadRegistry();
    expect(registry.findPoolForTokens('0.0.5449', WHBAR_TOKEN_ID).id).toBe(1);
  });

  it('explains what each token can be traded against when no pool exists', async () => {
    const registry = await loadRegistry();
    try {
      registry.findPoolForTokens('0.0.5529', WHBAR_TOKEN_ID);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PoolNotFoundError);
      const notFound = error as PoolNotFoundError;
      expect(notFound.code).toBe('POOL_NOT_FOUND');
      expect(notFound.message).toContain('DAI (0.0.5529) trades against');
      expect(notFound.message).toContain('USDC (0.0.5449)');
      expect(notFound.message).toContain('single-hop');
    }
  });
});

describe('SaucerSwapTokenRegistry.listRoutesFor', () => {
  it('lists each counterpart once, deepest first, with its best fee tier', async () => {
    const registry = await loadRegistry();
    const routes = registry.listRoutesFor(WHBAR_TOKEN_ID);

    expect(routes.map(r => r.token.id)).toEqual([
      '0.0.5449',      // $1000 via the 0.3 % pool
      '0.0.4232758',   // $7.06
      '0.0.4360535',   // $0.701
      '0.0.5768679',   // $0.35
    ]);

    const usdcRoute = routes[0];
    expect(usdcRoute.poolCount).toBe(2);
    expect(usdcRoute.fee).toBe(3000);
    expect(usdcRoute.feePercent).toBe(0.3);
  });

  it('returns nothing for a token with no pools', async () => {
    const registry = await loadRegistry([]);
    expect(registry.listRoutesFor(WHBAR_TOKEN_ID)).toEqual([]);
  });
});

describe('SaucerSwapTokenRegistry.listPools', () => {
  it('ranks pools by depth', async () => {
    const registry = await loadRegistry();
    expect(registry.listPools({ limit: 3 }).map(p => p.poolId)).toEqual([3, 1, 2]);
  });

  it('filters to pools holding a token', async () => {
    const registry = await loadRegistry();
    const poolIds = registry.listPools({ tokenId: '0.0.5529' }).map(p => p.poolId);
    expect(poolIds).toEqual([3, 7]);
  });

  it('reports the fee tier as a percentage', async () => {
    const registry = await loadRegistry();
    const [deepest] = registry.listPools({ limit: 1 });
    expect(deepest.fee).toBe(500);
    expect(deepest.feePercent).toBe(0.05);
  });
});

describe('formatUsd', () => {
  it('groups thousands and keeps cents below 1000', () => {
    expect(formatUsd(818617.42)).toBe('818,617');
    expect(formatUsd(60.666)).toBe('60.67');
    expect(formatUsd(0)).toBe('0.00');
    expect(formatUsd(Number.NaN)).toBe('0');
  });
});
