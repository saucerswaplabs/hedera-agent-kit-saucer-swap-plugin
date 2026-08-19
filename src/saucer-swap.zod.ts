import { z } from "zod";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "./service/token-registry-service";

/**
 * Token parameters accept anything a user would say in chat. Resolution happens
 * server-side against live pool data, so the model never has to know a token id —
 * and an unknown or ambiguous name comes back as a question rather than a guess.
 */
const TOKEN_REFERENCE =
  'Accepts a symbol ("USDC"), a token name ("USD Coin"), a Hedera token id ("0.0.456858") ' +
  'or an EVM address. Say "HBAR" for native HBAR — it is routed through WHBAR automatically. ' +
  'Prefer a Hedera token id when the user has picked one from a list.';

const AMOUNT_IN =
  'Amount of tokenIn in display units, exactly as the user says it — 1.5 means 1.5 tokens, ' +
  'not 1.5 base units. Decimal conversion is handled for you.';

export const getSwapQuoteV2Parameters = () => z.object({
  tokenIn: z.string().describe(`Token being sold. ${TOKEN_REFERENCE}`),
  tokenOut: z.string().describe(`Token being bought. ${TOKEN_REFERENCE}`),
  amountIn: z.number().describe(AMOUNT_IN),
});

export const getSwapQuoteV2ParametersNormalised = () => z.object({
  tokenIn: z.string().describe("Input token EVM address"),
  tokenOut: z.string().describe("Output token EVM address"),
  amountIn: z.bigint().describe("Amount of input tokens in base units"),
  poolFeesInHexFormat: z.string().describe("Pool fees in hex format"),
  // Resolved metadata, carried so the quote can be reported in display units.
  tokenInId: z.string().describe("Input token Hedera id"),
  tokenInSymbol: z.string().describe("Input token symbol"),
  tokenInDecimals: z.number().describe("Input token decimals"),
  tokenOutId: z.string().describe("Output token Hedera id"),
  tokenOutSymbol: z.string().describe("Output token symbol"),
  tokenOutDecimals: z.number().describe("Output token decimals"),
  feePercent: z.number().describe("Pool fee tier as a percentage"),
  isInputWrappedHBAR: z.boolean().describe("Whether the input side is native HBAR"),
  isOutputWrappedHBAR: z.boolean().describe("Whether the output side is native HBAR"),
});

export const swapV2Parameters = () => z.object({
  tokenIn: z.string().describe(`Token being sold. ${TOKEN_REFERENCE}`),
  tokenOut: z.string().describe(`Token being bought. ${TOKEN_REFERENCE}`),
  amountIn: z.number().describe(AMOUNT_IN),
  recipientAddress: z.string().optional().describe("Recipient address. Defaults to the operator account."),
});

export const listSaucerSwapTokensParameters = () => z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(`How many tokens to return, deepest liquidity first. Defaults to ${DEFAULT_LIST_LIMIT}.`),
  search: z
    .string()
    .optional()
    .describe('Optional filter matched against token symbol and name, e.g. "usd".'),
});

export const findSaucerSwapTokenParameters = () => z.object({
  query: z
    .string()
    .describe('What the user called the token: symbol, name, Hedera token id or EVM address.'),
});

export const listSaucerSwapPoolsParameters = () => z.object({
  token: z
    .string()
    .optional()
    .describe(
      `Optional token to filter by. ${TOKEN_REFERENCE} ` +
      'When given, the result is everything this token can be swapped for.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(`How many results to return, deepest liquidity first. Defaults to ${DEFAULT_LIST_LIMIT}.`),
});
