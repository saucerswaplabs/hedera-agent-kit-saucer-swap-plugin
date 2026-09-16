import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import type { Client } from "@hiero-ledger/sdk";
import { getOrderbookQuoteV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import {
    ExactInputQuoteResult,
    ExactOutputQuoteResult,
} from "../service/orderbook-api-service.interface";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";

const getOrderbookQuoteV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

This tool simulates a market order against the current SaucerSwap V3
orderbook and returns a quote. All amounts are RAW token units (uint256 as
decimal strings). Note: slippageBps in the response is a fixed applied
buffer, NOT market impact.

To place the quoted order with place_orderbook_order_v3_tool:
- exactInput quote  → submit snappedInputAmount as inputAmount and
  suggestedOutputAmount as outputAmount.
- exactOutput quote → submit suggestedInputAmount as inputAmount and
  snappedOutputAmount as outputAmount.

Parameters:
- orderbookId (str, required): The orderbook (market) id, e.g. '3'.
- quoteType (str, required): 'exactInput' (specify spend side) or 'exactOutput' (specify receive side).
- inputToken (str): EVM address of the token being spent — required for exactInput.
- inputAmount (str): Raw integer amount to spend — required for exactInput.
- outputToken (str): EVM address of the token to receive — required for exactOutput.
- outputAmount (str): Raw integer amount to receive — required for exactOutput.
${usageInstructions}

Example: "Quote spending 1000000 raw units of 0xabc... on orderbook 3 (exactInput)"
`;
};

const postProcessExactInput = (q: ExactInputQuoteResult) =>
    q.fillable
        ? `Exact-input quote: spending ${q.snappedInputAmount} (snapped)${q.consumedInputAmount !== undefined ? ` — book absorbs ${q.consumedInputAmount} —` : ""} yields expected ${q.expectedOutputAmount} of ${q.outputToken}. Build the order with inputAmount=${q.snappedInputAmount} and outputAmount=${q.suggestedOutputAmount} (includes fixed ${q.slippageBps} bps buffer — not market impact).`
        : `Exact-input quote: NOT fillable — no liquidity available for this trade right now.`;

const postProcessExactOutput = (q: ExactOutputQuoteResult) =>
    q.fillable
        ? `Exact-output quote: receiving ${q.snappedOutputAmount} (snapped from requested ${q.requestedOutputAmount}) costs expected ${q.expectedInputAmount} of ${q.inputToken}. Build the order with inputAmount=${q.suggestedInputAmount} (bumped UP by fixed ${q.slippageBps} bps buffer — not market impact) and outputAmount=${q.snappedOutputAmount}.`
        : `Exact-output quote: NOT fillable — book depth is below the requested output amount.`;

type GetOrderbookQuoteV3Params = z.infer<ReturnType<typeof getOrderbookQuoteV3Parameters>>;

export const GET_ORDERBOOK_QUOTE_V3_TOOL = "get_orderbook_quote_v3_tool" as const;

export class GetOrderbookQuoteV3Tool extends BaseTool<GetOrderbookQuoteV3Params, GetOrderbookQuoteV3Params> {
    method = GET_ORDERBOOK_QUOTE_V3_TOOL;
    name = "Get Orderbook Quote (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof getOrderbookQuoteV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = getOrderbookQuoteV3Prompt(context);
        this.parameters = getOrderbookQuoteV3Parameters();
    }

    async normalizeParams(
        params: GetOrderbookQuoteV3Params,
        _context: Context,
        _client: Client,
    ): Promise<GetOrderbookQuoteV3Params> {
        const parsed = getOrderbookQuoteV3Parameters().parse(params);
        if (parsed.quoteType === "exactInput" && (!parsed.inputToken || !parsed.inputAmount)) {
            throw new Error("exactInput quotes require inputToken and inputAmount");
        }
        if (parsed.quoteType === "exactOutput" && (!parsed.outputToken || !parsed.outputAmount)) {
            throw new Error("exactOutput quotes require outputToken and outputAmount");
        }
        return parsed;
    }

    async coreAction(
        normalisedParams: GetOrderbookQuoteV3Params,
        _context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        if (normalisedParams.quoteType === "exactInput") {
            const quote = await api.getQuoteExactInput(
                normalisedParams.orderbookId,
                normalisedParams.inputToken!,
                normalisedParams.inputAmount!,
            );
            return { raw: quote, humanMessage: postProcessExactInput(quote) };
        }
        const quote = await api.getQuoteExactOutput(
            normalisedParams.orderbookId,
            normalisedParams.outputToken!,
            normalisedParams.outputAmount!,
        );
        return { raw: quote, humanMessage: postProcessExactOutput(quote) };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        return formatOrderbookToolError(GET_ORDERBOOK_QUOTE_V3_TOOL, "Failed to get orderbook quote", error);
    }
}

const tool = (context: Context) => new GetOrderbookQuoteV3Tool(context);

export default tool;
