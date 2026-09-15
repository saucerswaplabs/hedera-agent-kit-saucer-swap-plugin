import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import type { Client } from "@hiero-ledger/sdk";
import { cancelOrderbookOrdersV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import {
    CancelOrdersResponse,
    EmergencyCancelResponse,
} from "../service/orderbook-api-service.interface";
import { OrderbookBatchLimitError } from "../errors";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";
import { SAUCER_SWAP_CONFIG } from "../constants";

const cancelOrderbookOrdersV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

WRITE TOOL — this cancels REAL live orders on the SaucerSwap V3 orderbook for
the operator account. Only use it with explicit user opt-in.

Cancellation is ASYNCHRONOUS: the server replies 202/PENDING once the request
is forwarded to the matching engine — 'accepted' is a request acknowledgement,
NOT a completed cancel. An order that fills before the cancel applies stays
FILLED. Confirm terminal state via get_my_orderbook_orders_v3_tool.

Two mutually exclusive modes:
- orderIds: cancel specific orders by id (max ${SAUCER_SWAP_CONFIG.ORDERBOOK_MAX_CANCEL_BATCH} per request).
- nonceFloor: emergency cancel-all — cancels every live order whose nonce is
  strictly below the floor (uint256 as a decimal string).

Parameters:
- orderIds (number[], optional): Order ids to cancel.
- nonceFloor (str, optional): Nonce floor for the cancel-all variant.
${usageInstructions}

Example: "Cancel orders 123 and 456 on the V3 orderbook"
`;
};

const postProcessCancel = (response: CancelOrdersResponse) => {
    const skipped = response.skipped.length
        ? ` Skipped: ${response.skipped.map((s) => `${s.orderId} (${s.reason})`).join(", ")}.`
        : "";
    return `Cancel request accepted for ${response.accepted.length} order(s): [${response.accepted.join(", ")}].${skipped} Status is PENDING — accepted means forwarded, not final; confirm via your order history (get_my_orderbook_orders_v3_tool).`;
};

const postProcessCancelAll = (response: EmergencyCancelResponse) =>
    `Emergency cancel-all accepted below nonce floor ${response.nonceFloor}: ${response.accepted.length} order(s) [${response.accepted.join(", ")}]. Status is PENDING — accepted means forwarded, not final; confirm via your order history (get_my_orderbook_orders_v3_tool).`;

type CancelOrderbookOrdersV3Params = z.infer<ReturnType<typeof cancelOrderbookOrdersV3Parameters>>;

export const CANCEL_ORDERBOOK_ORDERS_V3_TOOL = "cancel_orderbook_orders_v3_tool" as const;

export class CancelOrderbookOrdersV3Tool extends BaseTool<
    CancelOrderbookOrdersV3Params,
    CancelOrderbookOrdersV3Params
> {
    method = CANCEL_ORDERBOOK_ORDERS_V3_TOOL;
    name = "Cancel Orderbook Orders (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof cancelOrderbookOrdersV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = cancelOrderbookOrdersV3Prompt(context);
        this.parameters = cancelOrderbookOrdersV3Parameters();
    }

    async normalizeParams(
        params: CancelOrderbookOrdersV3Params,
        _context: Context,
        _client: Client,
    ): Promise<CancelOrderbookOrdersV3Params> {
        const parsed = cancelOrderbookOrdersV3Parameters().parse(params);
        const hasIds = parsed.orderIds !== undefined && parsed.orderIds.length > 0;
        const hasFloor = parsed.nonceFloor !== undefined;
        if (hasIds === hasFloor) {
            throw new Error("Provide exactly one of orderIds or nonceFloor");
        }
        if (hasIds && parsed.orderIds!.length > SAUCER_SWAP_CONFIG.ORDERBOOK_MAX_CANCEL_BATCH) {
            throw new OrderbookBatchLimitError(
                "orderIds",
                parsed.orderIds!.length,
                SAUCER_SWAP_CONFIG.ORDERBOOK_MAX_CANCEL_BATCH,
            );
        }
        return parsed;
    }

    async coreAction(
        normalisedParams: CancelOrderbookOrdersV3Params,
        context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        if (normalisedParams.orderIds !== undefined && normalisedParams.orderIds.length > 0) {
            const response = await api.cancel(client, context, normalisedParams.orderIds);
            return { raw: response, humanMessage: postProcessCancel(response) };
        }
        const response = await api.cancelAll(client, context, normalisedParams.nonceFloor!);
        return { raw: response, humanMessage: postProcessCancelAll(response) };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        return formatOrderbookToolError(CANCEL_ORDERBOOK_ORDERS_V3_TOOL, "Failed to cancel orderbook orders", error);
    }
}

const tool = (context: Context) => new CancelOrderbookOrdersV3Tool(context);

export default tool;
