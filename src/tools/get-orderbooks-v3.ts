import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import type { Client } from "@hiero-ledger/sdk";
import { getOrderbooksV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import { PaginatedOrderbooksResult } from "../service/orderbook-api-service.interface";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";

const getOrderbooksV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

This tool lists SaucerSwap V3 orderbook markets (paginated), including token
ids/EVM addresses, symbols, decimals, price/volume stats, market grid rules
(tickStep, sizeStep, lotSize, minNotional), fees in pips (takerFeePips,
makerFeePips; 1 pip = 1e-6), status, and isAMMEnabled.

Parameters:
- page (number, optional): 1-indexed page number (default 1).
- limit (number, optional): Page size (default 20, max 100).
- orderbookId (number, optional): Filter to a single market id.
- tokenId (str, optional): Filter by either token's Hedera ID (0.0.x).
- symbol (str, optional): Partial token symbol match.
- status (str, optional): 'OPEN' or 'CLOSED'.
${usageInstructions}

Example: "List all OPEN SaucerSwap V3 orderbooks"
`;
};

const postProcess = (result: PaginatedOrderbooksResult) => {
    const lines = result.orderbooks.map(
        (b) =>
            `#${b.id} ${b.baseTokenSymbol ?? b.baseTokenId}/${b.quoteTokenSymbol ?? b.quoteTokenId} — status ${b.status}, AMM ${b.isAMMEnabled ? "enabled" : "disabled"}, tickStep ${b.tickStep}, lotSize ${b.lotSize}, minNotional ${b.minNotional}, fees ${b.takerFeePips}/${b.makerFeePips} pips (taker/maker)`,
    );
    return `Found ${result.total} orderbook(s) (page ${result.page}, limit ${result.limit}):\n${lines.join("\n")}`;
};

type GetOrderbooksV3Params = z.infer<ReturnType<typeof getOrderbooksV3Parameters>>;

export const GET_ORDERBOOKS_V3_TOOL = "get_orderbooks_v3_tool" as const;

export class GetOrderbooksV3Tool extends BaseTool<GetOrderbooksV3Params, GetOrderbooksV3Params> {
    method = GET_ORDERBOOKS_V3_TOOL;
    name = "List Orderbooks (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof getOrderbooksV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = getOrderbooksV3Prompt(context);
        this.parameters = getOrderbooksV3Parameters();
    }

    async normalizeParams(
        params: GetOrderbooksV3Params,
        _context: Context,
        _client: Client,
    ): Promise<GetOrderbooksV3Params> {
        return getOrderbooksV3Parameters().parse(params);
    }

    async coreAction(
        normalisedParams: GetOrderbooksV3Params,
        _context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        const result = await api.getOrderbooks(normalisedParams);
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
        return formatOrderbookToolError(GET_ORDERBOOKS_V3_TOOL, "Failed to list orderbooks", error);
    }
}

const tool = (context: Context) => new GetOrderbooksV3Tool(context);

export default tool;
