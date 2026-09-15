import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import type { Client } from "@hiero-ledger/sdk";
import { getMyOrderbookOrdersV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import { PaginatedOrdersResult } from "../service/orderbook-api-service.interface";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";

const getMyOrderbookOrdersV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

This tool lists the operator account's own SaucerSwap V3 orderbook orders
(paginated), with status, direction, price, fill percentage, nonce, and
deadline. It authenticates as the operator (JWT cached per session) — it only
sees orders belonging to the signing account.

Parameters:
- page (number, optional): 1-indexed page number (default 1).
- limit (number, optional): Page size.
- sort (str, optional): 'asc' | 'desc' by creation time.
- statusFilter (str, optional): Comma-separated statuses, e.g. 'ACTIVE,PARTIAL_FILLED'.
- directionFilter (str, optional): 'BUY' | 'SELL'.
- typeFilter (str, optional): 'LIMIT' | 'MARKET'.
- orderbookId (number, optional): Filter to a single market id.
- startTimestamp / endTimestamp (number, optional): Unix ms bounds on createdAt.
${usageInstructions}

Example: "List my ACTIVE orders on orderbook 3"
`;
};

const postProcess = (result: PaginatedOrdersResult) => {
    const lines = result.orders.map(
        (o) =>
            `#${o.id} ${o.pair} ${o.direction} ${o.type} — ${o.amount} @ ${o.price}, ${o.percentFilled}% filled, status ${o.status}, nonce ${o.nonce}, deadline ${o.deadline}`,
    );
    return `Found ${result.total} order(s) (page ${result.page}, limit ${result.limit}):\n${lines.join("\n")}`;
};

type GetMyOrderbookOrdersV3Params = z.infer<ReturnType<typeof getMyOrderbookOrdersV3Parameters>>;

export const GET_MY_ORDERBOOK_ORDERS_V3_TOOL = "get_my_orderbook_orders_v3_tool" as const;

export class GetMyOrderbookOrdersV3Tool extends BaseTool<
    GetMyOrderbookOrdersV3Params,
    GetMyOrderbookOrdersV3Params
> {
    method = GET_MY_ORDERBOOK_ORDERS_V3_TOOL;
    name = "Get My Orderbook Orders (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof getMyOrderbookOrdersV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = getMyOrderbookOrdersV3Prompt(context);
        this.parameters = getMyOrderbookOrdersV3Parameters();
    }

    async normalizeParams(
        params: GetMyOrderbookOrdersV3Params,
        _context: Context,
        _client: Client,
    ): Promise<GetMyOrderbookOrdersV3Params> {
        return getMyOrderbookOrdersV3Parameters().parse(params);
    }

    async coreAction(
        normalisedParams: GetMyOrderbookOrdersV3Params,
        context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        const result = await api.getOrders(client, context, normalisedParams);
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
        return formatOrderbookToolError(GET_MY_ORDERBOOK_ORDERS_V3_TOOL, "Failed to get orderbook orders", error);
    }
}

const tool = (context: Context) => new GetMyOrderbookOrdersV3Tool(context);

export default tool;
