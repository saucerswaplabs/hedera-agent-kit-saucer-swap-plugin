import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import type { Client } from "@hiero-ledger/sdk";
import { getOrderbookDepthV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import { DepthSnapshot } from "../service/orderbook-api-service.interface";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";

const getOrderbookDepthV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

This tool fetches the current depth snapshot for a single SaucerSwap V3
orderbook market: best bid/ask, spread, and the full [price, size] ladders
(string tuples), plus the lastUpdateId sequence marker.

Parameters:
- orderbookId (str, required): The orderbook (market) id, e.g. '3'.
${usageInstructions}

Example: "Get the depth snapshot for orderbook 3"
`;
};

const postProcess = (snapshot: DepthSnapshot) =>
    `Orderbook ${snapshot.orderbookId} depth (lastUpdateId ${snapshot.lastUpdateId}): best bid ${snapshot.bestBidQuote ?? "none"}, best ask ${snapshot.bestAskQuote ?? "none"}, spread ${snapshot.spreadPercent ?? "n/a"}%. ${snapshot.bids.length} bid level(s), ${snapshot.asks.length} ask level(s).`;

type GetOrderbookDepthV3Params = z.infer<ReturnType<typeof getOrderbookDepthV3Parameters>>;

export const GET_ORDERBOOK_DEPTH_V3_TOOL = "get_orderbook_depth_v3_tool" as const;

export class GetOrderbookDepthV3Tool extends BaseTool<GetOrderbookDepthV3Params, GetOrderbookDepthV3Params> {
    method = GET_ORDERBOOK_DEPTH_V3_TOOL;
    name = "Get Orderbook Depth (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof getOrderbookDepthV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = getOrderbookDepthV3Prompt(context);
        this.parameters = getOrderbookDepthV3Parameters();
    }

    async normalizeParams(
        params: GetOrderbookDepthV3Params,
        _context: Context,
        _client: Client,
    ): Promise<GetOrderbookDepthV3Params> {
        return getOrderbookDepthV3Parameters().parse(params);
    }

    async coreAction(
        normalisedParams: GetOrderbookDepthV3Params,
        _context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        const snapshot = await api.getDepth(normalisedParams.orderbookId);
        return {
            raw: snapshot,
            humanMessage: postProcess(snapshot),
        };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        return formatOrderbookToolError(GET_ORDERBOOK_DEPTH_V3_TOOL, "Failed to get orderbook depth", error);
    }
}

const tool = (context: Context) => new GetOrderbookDepthV3Tool(context);

export default tool;
