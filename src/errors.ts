/**
 * Custom error classes for SaucerSwap plugin
 */

export class SaucerSwapError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SaucerSwapError';
    Object.setPrototypeOf(this, SaucerSwapError.prototype);
  }
}

/**
 * Logs a tool failure.
 *
 * A `SaucerSwapError` is an expected turn in a conversation — an unknown symbol, an
 * unlisted pair — and the agent relays it to the user, so it gets one line. Anything
 * else is a real fault and keeps its stack trace.
 */
export const logToolError = (toolName: string, message: string, error: unknown): void => {
  if (error instanceof SaucerSwapError) {
    console.error(`[${toolName}]`, message);
    return;
  }
  console.error(`[${toolName}]`, message, error);
};

export class PoolNotFoundError extends SaucerSwapError {
  constructor(tokenA: string, tokenB: string, hint?: string) {
    super(
      `Pool not found for tokens ${tokenA} and ${tokenB}.${hint ? ` ${hint}` : ''}`,
      'POOL_NOT_FOUND'
    );
    this.name = 'PoolNotFoundError';
    Object.setPrototypeOf(this, PoolNotFoundError.prototype);
  }
}

/**
 * Raised when a token reference typed by a user cannot be matched to any token
 * that has SaucerSwap V2 liquidity. Carries suggestions so the agent can offer
 * alternatives instead of inventing a token id.
 */
export class TokenNotFoundError extends SaucerSwapError {
  constructor(
    public readonly query: string,
    public readonly suggestions: string[],
    role?: string,
  ) {
    const where = role ? ` for ${role}` : '';
    const hint = suggestions.length
      ? ` Tokens with the most SaucerSwap V2 liquidity right now: ${suggestions.join(', ')}.`
      : '';
    super(
      `No token with SaucerSwap V2 liquidity matches "${query}"${where}.${hint}` +
        ` Call list_saucerswap_tokens_tool for the tradable list instead of guessing a token id.`,
      'TOKEN_NOT_FOUND'
    );
    this.name = 'TokenNotFoundError';
    Object.setPrototypeOf(this, TokenNotFoundError.prototype);
  }
}

/**
 * Raised when a symbol or name matches several tokens (Hedera lets anyone mint
 * a token called "USDC"). The agent is expected to relay the candidates and let
 * the user pick the exact token id.
 */
export class AmbiguousTokenError extends SaucerSwapError {
  constructor(
    public readonly query: string,
    public readonly candidates: string[],
    role?: string,
  ) {
    const where = role ? ` for ${role}` : '';
    super(
      `"${query}"${where} matches ${candidates.length} different tokens on SaucerSwap: ` +
        `${candidates.join(' | ')}. Ask the user which one they mean, then call again with that ` +
        `token's Hedera id (0.0.x). Do not pick one on the user's behalf.`,
      'AMBIGUOUS_TOKEN'
    );
    this.name = 'AmbiguousTokenError';
    Object.setPrototypeOf(this, AmbiguousTokenError.prototype);
  }
}

export class InvalidTokenAddressError extends SaucerSwapError {
  constructor(address: string) {
    super(`Invalid token address: ${address}`, 'INVALID_TOKEN_ADDRESS');
    this.name = 'InvalidTokenAddressError';
    Object.setPrototypeOf(this, InvalidTokenAddressError.prototype);
  }
}

export class InvalidAmountError extends SaucerSwapError {
  constructor(amount: number | string) {
    super(`Invalid amount: ${amount}. Amount must be greater than zero`, 'INVALID_AMOUNT');
    this.name = 'InvalidAmountError';
    Object.setPrototypeOf(this, InvalidAmountError.prototype);
  }
}

export class MirrorNodeError extends SaucerSwapError {
  constructor(message: string, public readonly statusCode?: number) {
    super(`Mirror Node error: ${message}`, 'MIRROR_NODE_ERROR');
    this.name = 'MirrorNodeError';
    Object.setPrototypeOf(this, MirrorNodeError.prototype);
  }
}

export class ConfigurationError extends SaucerSwapError {
  constructor(message: string) {
    super(`Configuration error: ${message}`, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

export class OrderbookApiError extends SaucerSwapError {
  /** true when the failing response carried a JSON body with a server error message. */
  public hasJsonErrorBody = false;

  constructor(message: string, public readonly statusCode?: number) {
    super(`Orderbook API error: ${message}`, 'ORDERBOOK_API_ERROR');
    this.name = 'OrderbookApiError';
    Object.setPrototypeOf(this, OrderbookApiError.prototype);
  }
}


export class OrderbookAuthError extends SaucerSwapError {
  constructor(message: string) {
    super(`Orderbook authentication failed: ${message}`, 'ORDERBOOK_AUTH_ERROR');
    this.name = 'OrderbookAuthError';
    Object.setPrototypeOf(this, OrderbookAuthError.prototype);
  }
}

/**
 * Raised when the client's operator signing capability is unavailable —
 * orderbook trading tools sign off-chain messages (auth challenge + EIP-712
 * orders) with the operator key, so they only work in AUTONOMOUS mode with a
 * configured operator.
 */
export class OperatorSigningUnavailableError extends SaucerSwapError {
  constructor(detail: string) {
    super(
      `Operator signing unavailable: ${detail}. Orderbook trading tools require AUTONOMOUS mode with an operator configured on the client (orders are signed off-chain, so RETURN_BYTES mode is not supported).`,
      'OPERATOR_SIGNING_UNAVAILABLE'
    );
    this.name = 'OperatorSigningUnavailableError';
    Object.setPrototypeOf(this, OperatorSigningUnavailableError.prototype);
  }
}

export class OrderbookBatchLimitError extends SaucerSwapError {
  constructor(what: string, count: number, max: number) {
    super(
      `Too many ${what}: ${count} (max ${max} per request)`,
      'ORDERBOOK_BATCH_LIMIT'
    );
    this.name = 'OrderbookBatchLimitError';
    Object.setPrototypeOf(this, OrderbookBatchLimitError.prototype);
  }
}

export class TokenNotAssociatedError extends SaucerSwapError {
  constructor(accountId: string, tokenId: string, signerAccountId?: string) {
    const signerHint = signerAccountId
      ? ` Cannot auto-associate because the recipient differs from the signer (${signerAccountId}). Have the recipient associate the token first.`
      : ' Have the recipient associate the token first.';
    super(
      `Recipient ${accountId} does not have token ${tokenId} associated.${signerHint}`,
      'TOKEN_NOT_ASSOCIATED'
    );
    this.name = 'TokenNotAssociatedError';
    Object.setPrototypeOf(this, TokenNotAssociatedError.prototype);
  }
}

