import { TokenId } from "@hiero-ledger/sdk";
import BigNumber from 'bignumber.js';
import { AccountResolver } from "@hashgraph/hedera-agent-kit";
import { SaucerSwapError } from "./errors";
import {
  SaucerSwapV2CompactPool,
  SaucerSwapV2PoolToken,
} from "./service/saucer-swap-rest-pools-service.interface";


/**
 * Handles response formatting for both autonomous and manual modes
 */
export const handleResponse = (data: any, message: string) => {
  return {
    success: true,
    data,
    message,
  };
};

/**
 * Converts decimal amount to tiny units (wei)
 */
export const toTiny = (amount: number | string): string => {
  const amountBigInt = typeof amount === "string" ? BigInt(amount) : BigInt(amount);
  return amountBigInt.toString();
};

/**
 * Validates token addresses
 */
export const isValidAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Normalizes token addresses to lowercase
 */
export const normalizeAddress = (address: string): string => {
  if (!isValidAddress(address)) {
    throw new Error(`Invalid address: ${address}`);
  }
  return address.toLowerCase();
};

/**
 * Sorts token addresses for consistent pair ordering
 */
export const sortTokens = (tokenA: string, tokenB: string): [string, string] => {
  const normalizedA = normalizeAddress(tokenA);
  const normalizedB = normalizeAddress(tokenB);
  
  if (normalizedA === normalizedB) {
    throw new Error("Cannot create pool with same token");
  }
  
  return normalizedA < normalizedB ? [normalizedA, normalizedB] : [normalizedB, normalizedA];
};

/**
 * Calculates slippage bounds
 */
export const calculateSlippageBounds = (
  amount: bigint,
  slippageBps: number
): { min: bigint; max: bigint } => {
  const slippageMultiplier = BigInt(10000 - slippageBps);
  const min = (amount * slippageMultiplier) / 10000n;
  
  const maxMultiplier = BigInt(10000 + slippageBps);
  const max = (amount * maxMultiplier) / 10000n;
  
  return { min, max };
};

/**
 * Formats amount with decimals
 */
export const formatAmount = (amount: bigint, decimals: number): string => {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fractional = amount % divisor;
  
  if (fractional === 0n) {
    return whole.toString();
  }
  
  const fractionalStr = fractional.toString().padStart(decimals, '0');
  const trimmed = fractionalStr.replace(/0+$/, '');
  
  if (trimmed === '') {
    return whole.toString();
  }
  
  return `${whole}.${trimmed}`;
};

export const getHederaTokenEVMAddress = (address: string) => {
  if (!AccountResolver.isHederaAddress(address)) {
    return address;
  }
  const token = TokenId.fromString(address);
  return '0x' + token.toEvmAddress();
}

export const getHederaTokenAddress = (address: string) => {
  if (AccountResolver.isHederaAddress(address)) {
    return address;
  }
  const token = TokenId.fromEvmAddress(0,0, address);
  return token.toString();
}

export function toBaseUnit(amount: number | BigNumber, decimals: number): BigNumber {
  const amountBN = new BigNumber(amount);
  const multiplier = new BigNumber(10).pow(decimals);
  return amountBN.multipliedBy(multiplier).integerValue(BigNumber.ROUND_FLOOR);
}

/**
 * Converts a display amount to its exact base-unit form as a bigint, without the
 * 2^53 precision loss of {@link BigNumber.toNumber}.
 */
export function toBaseUnitBigInt(amount: number | BigNumber, decimals: number): bigint {
  return BigInt(toBaseUnit(amount, decimals).toFixed(0));
}

/**
 * The Hedera Agent Kit exposes several count fields (contract `payableAmount`,
 * token allowances) as plain JS numbers. Those are exact only below 2^53, so a
 * base-unit amount that cannot be represented is refused loudly instead of being
 * silently rounded and corrupting the transaction.
 */
export function toSafeExactNumber(amount: bigint): number {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SaucerSwapError(
      `Amount ${amount.toString()} base units cannot be represented exactly for this SDK call`,
      'AMOUNT_TOO_LARGE',
    );
  }
  return Number(amount);
}

/** Inverse of {@link toBaseUnit}: base units back to the token's display scale. */
export function fromBaseUnit(amount: number | string | BigNumber | bigint, decimals: number): BigNumber {
  return new BigNumber(amount).dividedBy(new BigNumber(10).pow(decimals));
}

/**
 * Renders a base-unit amount the way a person would read it — full precision,
 * no exponent notation, no trailing zeros.
 */
export const formatTokenAmount = (
  amount: number | string | BigNumber | bigint,
  decimals: number,
): string => fromBaseUnit(amount, decimals).toFixed();

/** WHBAR gets no token id: quoting one would point at something nobody holds. */
export const describeTokenForUser = (
  symbol: string,
  tokenId: string,
  isWrappedHbar: boolean,
): string => (isWrappedHbar ? 'native HBAR' : `${symbol} (${tokenId})`);

export const getTokenDecimals = (pool: SaucerSwapV2CompactPool, hederaTokenAddress: string): number => {
  if (pool.tokenA.id === hederaTokenAddress) {
    return pool.tokenA.decimals;
  }
  return pool.tokenB.decimals;
}

/**
 * USD value of one side of a pool.
 *
 * The compact-pools endpoint occasionally reports a negative reserve, so only the
 * magnitude is used — this figure exists to rank depth, not to settle balances.
 */
export const poolSideLiquidityUsd = (
  amount: string,
  token: SaucerSwapV2PoolToken,
): number => {
  const reserve = new BigNumber(amount ?? 0).abs();
  const priceUsd = new BigNumber(token.priceUsd ?? 0);
  if (reserve.isNaN() || priceUsd.isNaN()) {
    return 0;
  }
  return fromBaseUnit(reserve, token.decimals).multipliedBy(priceUsd).toNumber();
};

/** Combined USD depth of both sides of a pool. */
export const poolLiquidityUsd = (pool: SaucerSwapV2CompactPool): number =>
  poolSideLiquidityUsd(pool.amountA, pool.tokenA) +
  poolSideLiquidityUsd(pool.amountB, pool.tokenB);

/** Fee tier as a percentage: 3000 (hundredths of a bip) -> 0.3. */
export const feeTierToPercent = (fee: number): number => fee / 10_000;