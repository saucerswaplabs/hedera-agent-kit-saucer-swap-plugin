import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import type { Client } from "@hiero-ledger/sdk";
import { getOrderbookTradesV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import { RecentTradesResult } from "../service/orderbook-api-service.interface";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";

const getOrderbookTradesV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

This tool fetches the public trade tape (recent fills) for a single
SaucerSwap V3 orderbook market. Each trade has: timestamp (unix ms), price
(human-readable quote-per-base string), amountBase (HUMAN-READABLE
decimals-adjusted string, NOT raw units), direction ('buy' | 'sell'), and
transactionHash.

Parameters:
- orderbookId (str, required): The orderbook (market) id, e.g. '3'.
- sort (str, optional): 'asc' | 'desc' by time (default 'desc').
- page (number, optional): 1-indexed page (default 1). Negative values are rejected by the server (400).
- limit (number, optional): Page size (default 10). Negative values are rejected by the server (400).
${usageInstructions}

Example: "Show the last 50 trades on orderbook 3"
`;
};

const postProcess = (result: RecentTradesResult) => {
    const lines = result.trades
        .slice(0, 10)
        .map(
            (t) =>
                `${new Date(t.timestamp).toISOString()} ${t.direction.toUpperCase()} ${t.amountBase} @ ${t.price} (tx ${t.transactionHash})`,
        );
    const suffix = result.trades.length > 10 ? `\n… ${result.trades.length - 10} more on this page` : "";
    return `Orderbook ${result.orderbookId}: ${result.total} trade(s) total (page ${result.page}, limit ${result.limit}):\n${lines.join("\n")}${suffix}`;
};

type GetOrderbookTradesV3Params = z.infer<ReturnType<typeof getOrderbookTradesV3Parameters>>;

export const GET_ORDERBOOK_TRADES_V3_TOOL = "get_orderbook_trades_v3_tool" as const;

export class GetOrderbookTradesV3Tool extends BaseTool<GetOrderbookTradesV3Params, GetOrderbookTradesV3Params> {
    method = GET_ORDERBOOK_TRADES_V3_TOOL;
    name = "Get Orderbook Trades (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof getOrderbookTradesV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = getOrderbookTradesV3Prompt(context);
        this.parameters = getOrderbookTradesV3Parameters();
    }

    async normalizeParams(
        params: GetOrderbookTradesV3Params,
        _context: Context,
        _client: Client,
    ): Promise<GetOrderbookTradesV3Params> {
        return getOrderbookTradesV3Parameters().parse(params);
    }

    async coreAction(
        normalisedParams: GetOrderbookTradesV3Params,
        _context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        const { orderbookId, ...query } = normalisedParams;
        const result = await api.getTrades(orderbookId, query);
        return {
            raw: result,
            humanMessage: postProcess(result),
        };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        return formatOrderbookToolError(GET_ORDERBOOK_TRADES_V3_TOOL, "Failed to get orderbook trades", error);
    }
}

const tool = (context: Context) => new GetOrderbookTradesV3Tool(context);

export default tool;
