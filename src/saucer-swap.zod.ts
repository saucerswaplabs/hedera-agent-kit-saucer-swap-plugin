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
  amountOutMinimum: z.string()
    .max(512)
    .regex(/^[0-9]+(?:\.[0-9]+)?$/, "Use a plain decimal string, without signs or exponent notation")
    .refine(value => value.trim() === value, "Minimum output cannot contain surrounding whitespace")
    .refine(value => /[1-9]/.test(value), "Minimum output must be greater than zero")
    .describe(
      "The user's explicitly approved minimum amount of tokenOut, in display units as a decimal string " +
      '(e.g. "6.6" USDC). Required; never infer a default, substitute a new quote, or lower it. ' +
      "Must be exactly representable in the resolved output token's base units.",
    ),
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

// ---------------------------------------------------------------------------
// V3 orderbook tools
// ---------------------------------------------------------------------------

/** uint256 amounts travel as decimal strings end to end — never JS numbers. */
const rawAmountString = (label: string) =>
  z.string().regex(/^[0-9]+$/, `${label} must be a raw integer amount as a decimal string`);

export const getOrderbooksV3Parameters = () => z.object({
  page: z.number().int().optional().describe("1-indexed page number (default 1)"),
  limit: z.number().int().optional().describe("Page size (default 20, max 100)"),
  orderbookId: z.number().int().optional().describe("Filter to a single market id"),
  tokenId: z.string().optional().describe("Filter by either token's Hedera ID (0.0.x)"),
  symbol: z.string().optional().describe("Partial token symbol match"),
  status: z.enum(["OPEN", "CLOSED"]).optional().describe("Filter by orderbook status"),
});

export const getOrderbookDepthV3Parameters = () => z.object({
  orderbookId: z.string().describe("Orderbook (market) id, e.g. '3'"),
});

export const getOrderbookTradesV3Parameters = () => z.object({
  orderbookId: z.string().describe("Orderbook (market) id, e.g. '3'"),
  sort: z.enum(["asc", "desc"]).optional().describe("Order fills by time (default desc)"),
  page: z.number().int().optional().describe("1-indexed page number (default 1; negative values are rejected by the server with 400)"),
  limit: z.number().int().optional().describe("Page size (default 10; negative values are rejected by the server with 400)"),
});

export const getOrderbookQuoteV3Parameters = () => z.object({
  orderbookId: z.string().describe("Orderbook (market) id, e.g. '3'"),
  quoteType: z.enum(["exactInput", "exactOutput"]).describe(
    "exactInput: specify what you spend (inputToken/inputAmount). exactOutput: specify what you want to receive (outputToken/outputAmount).",
  ),
  inputToken: z.string().optional().describe("EVM address of the token being spent (required for exactInput)"),
  inputAmount: rawAmountString("inputAmount").optional().describe("Raw token units to spend, uint256 as decimal string (required for exactInput)"),
  outputToken: z.string().optional().describe("EVM address of the token to receive (required for exactOutput)"),
  outputAmount: rawAmountString("outputAmount").optional().describe("Raw token units to receive, uint256 as decimal string (required for exactOutput)"),
});

const orderRequestV3 = () => z.object({
  orderbookId: z.string().describe("Orderbook (market) id, e.g. '3'"),
  type: z.enum(["LIMIT", "MARKET"]).describe("Order type"),
  deadline: z.string().regex(/^[0-9]+$/).optional().describe(
    "Unix timestamp in SECONDS as a decimal string. LIMIT only (defaults to 1 hour from now); MUST be omitted for MARKET orders.",
  ),
  inputToken: z.string().describe("EVM address of the token you are selling"),
  inputAmount: rawAmountString("inputAmount").describe("Raw sell amount, uint256 as decimal string"),
  outputToken: z.string().describe("EVM address of the token you are buying"),
  outputAmount: rawAmountString("outputAmount").describe("Minimum raw buy amount, uint256 as decimal string"),
  recipient: z.string().optional().describe("Output recipient EVM address (defaults to your own address)"),
  makerOnly: z.boolean().optional().describe("Restrict order to maker fills only"),
  takerOnce: z.boolean().optional().describe("Allow only one taker to fill the order"),
  isAMMEnabled: z.boolean().optional().describe("Permit AMM-backed settlement (server default true)"),
});

export const placeOrderbookOrderV3Parameters = () => z.object({
  orders: z.array(orderRequestV3()).min(1).describe(
    "Order requests to build, sign, and submit in one batch (policy cap 250 per request; older deployments cap at 100).",
  ),
});

export const cancelOrderbookOrdersV3Parameters = () => z.object({
  orderIds: z.array(z.number().int()).min(1).optional().describe(
    "Order ids to cancel (max 500 per request). Provide either orderIds or nonceFloor, not both.",
  ),
  nonceFloor: z.string().regex(/^[0-9]+$/).optional().describe(
    "Emergency cancel-all variant: cancels every live order whose nonce is strictly below this floor. uint256 as decimal string. Provide either orderIds or nonceFloor, not both.",
  ),
});

export const getMyOrderbookOrdersV3Parameters = () => z.object({
  page: z.number().int().optional().describe("1-indexed page number (default 1)"),
  limit: z.number().int().optional().describe("Page size"),
  sort: z.enum(["asc", "desc"]).optional().describe("Sort by creation time"),
  statusFilter: z.string().optional().describe(
    "Comma-separated statuses, e.g. 'ACTIVE,PARTIAL_FILLED' (ACTIVE, CANCELED, FILLED, EXPIRED, FAILED, CLOSED, PARTIAL_FILLED, CORRECTED)",
  ),
  directionFilter: z.enum(["BUY", "SELL"]).optional().describe("Filter by direction"),
  typeFilter: z.enum(["LIMIT", "MARKET"]).optional().describe("Filter by order type"),
  orderbookId: z.number().int().optional().describe("Filter to a single market id"),
  startTimestamp: z.number().int().optional().describe("Unix milliseconds — inclusive lower bound on createdAt"),
  endTimestamp: z.number().int().optional().describe("Unix milliseconds — inclusive upper bound on createdAt"),
});
