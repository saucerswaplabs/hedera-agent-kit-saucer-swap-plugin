import { describe, expect, it } from 'vitest';
import {
  feeTierToPercent,
  formatTokenAmount,
  fromBaseUnit,
  poolLiquidityUsd,
  toBaseUnit,
} from '../src/utils';
import { SaucerSwapV2CompactPool } from '../src/service/saucer-swap-rest-pools-service.interface';

describe('base-unit conversion', () => {
  it('round-trips display units through base units', () => {
    expect(toBaseUnit(100, 8).toFixed()).toBe('10000000000');
    expect(fromBaseUnit('10000000000', 8).toFixed()).toBe('100');
  });

  it('floors amounts finer than the token can express', () => {
    expect(toBaseUnit(0.001, 2).toFixed()).toBe('0');
    expect(toBaseUnit(1.239, 2).toFixed()).toBe('123');
  });

  it('formats without exponent notation or trailing zeros', () => {
    expect(formatTokenAmount('221016910', 6)).toBe('221.01691');
    expect(formatTokenAmount('1', 18)).toBe('0.000000000000000001');
    expect(formatTokenAmount('500000000', 8)).toBe('5');
  });
});

describe('feeTierToPercent', () => {
  it('converts hundredths of a bip to a percentage', () => {
    expect(feeTierToPercent(500)).toBe(0.05);
    expect(feeTierToPercent(1500)).toBe(0.15);
    expect(feeTierToPercent(3000)).toBe(0.3);
    expect(feeTierToPercent(10000)).toBe(1);
  });
});

describe('poolLiquidityUsd', () => {
  const poolWith = (amountA: string, amountB: string): SaucerSwapV2CompactPool => ({
    id: 1,
    contractId: '0.0.1',
    tokenA: {
      id: '0.0.15058', name: 'WHBAR', symbol: 'HBAR', decimals: 8, priceUsd: 0.07,
      icon: '', price: '0', dueDiligenceComplete: false, isFeeOnTransferToken: false,
    },
    tokenB: {
      id: '0.0.5449', name: 'USD Coin', symbol: 'USDC', decimals: 6, priceUsd: 1,
      icon: '', price: '0', dueDiligenceComplete: false, isFeeOnTransferToken: false,
    },
    amountA, amountB, fee: 3000, sqrtRatioX96: '0', tickCurrent: 0, liquidity: '0',
  });

  it('sums both sides at their USD price', () => {
    // 10000 HBAR * $0.07 + 300 USDC * $1
    expect(poolLiquidityUsd(poolWith('1000000000000', '300000000'))).toBeCloseTo(1000, 6);
  });

  it('treats a negative reserve as its magnitude', () => {
    expect(poolLiquidityUsd(poolWith('-1000000000000', '300000000'))).toBeCloseTo(1000, 6);
  });

  it('survives unparseable numbers', () => {
    expect(poolLiquidityUsd(poolWith('not-a-number', '300000000'))).toBeCloseTo(300, 6);
  });
});
