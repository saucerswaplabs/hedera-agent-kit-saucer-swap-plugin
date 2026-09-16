import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import { AccountId, type Client } from "@hiero-ledger/sdk";
import { placeOrderbookOrderV3Parameters } from "../saucer-swap.zod";
import { OrderbookApiService } from "../service/orderbook-api-service";
import {
    OrderRequestInput,
    OrderType,
    SaveOrderItem,
    SerializedOrder,
} from "../service/orderbook-api-service.interface";
import { getOperatorSigner, signOrder } from "../service/orderbook-signing-service";
import { OrderbookBatchLimitError } from "../errors";
import { formatOrderbookToolError } from "../utils/orderbook-tool-helpers";
import { SAUCER_SWAP_CONFIG } from "../constants";

const placeOrderbookOrderV3Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

WRITE TOOL — this places REAL orders on the SaucerSwap V3 orderbook with the
operator account's funds. Only use it with explicit user opt-in.

This tool runs the full order placement flow: authenticate (challenge →
operator-signed nonce → JWT), build orders server-side (server assigns
nonces), sign each returned order struct (EIP-712) with the operator key, and
save them to the matching engine.

All amounts are RAW token units — uint256 values passed as decimal strings,
never numbers. When placing an order from a quote
(get_orderbook_quote_v3_tool): exactInput → inputAmount=snappedInputAmount,
outputAmount=suggestedOutputAmount; exactOutput →
inputAmount=suggestedInputAmount, outputAmount=snappedOutputAmount.

Parameters:
- orders (array, required, 1-${SAUCER_SWAP_CONFIG.ORDERBOOK_MAX_BUILD_BATCH} items): Each order has:
  - orderbookId (str, required): Market id, e.g. '3'.
  - type (str, required): 'LIMIT' or 'MARKET'.
  - deadline (str, LIMIT only): Unix SECONDS as a decimal string; defaults to
    1 hour from now for LIMIT. MUST be omitted for MARKET orders (the server
    stamps its own short deadline).
  - inputToken (str, required): EVM address of the sell token.
  - inputAmount (str, required): Raw sell amount (uint256 decimal string).
  - outputToken (str, required): EVM address of the buy token.
  - outputAmount (str, required): Minimum raw buy amount (uint256 decimal string).
  - recipient (str, optional): Output recipient EVM address.
  - makerOnly / takerOnce / isAMMEnabled (bool, optional).
${usageInstructions}

Example: "Place a LIMIT order on orderbook 3 selling 1000000 raw units of 0xabc... for at least 500000 raw units of 0xdef..."
`;
};

const postProcess = (orders: SerializedOrder[]) => {
    const lines = orders.map((o) => {
        const meta = o.meta ?? {};
        return `order ${meta.id ?? "?"} (book ${meta.orderbookId ?? "?"}, ${meta.type ?? "?"}) — signed to sell ${o.input.amount} of ${o.input.token} for min ${o.output.amount} of ${o.output.token}, recipient ${o.output.recipient}, deadline ${o.info.deadline} (unix s), status ${meta.status ?? "unknown"}, nonce ${o.info.nonce}, hash ${meta.orderHash ?? "n/a"}`;
    });
    return `Submitted ${orders.length} order(s) to the SaucerSwap V3 orderbook:\n${lines.join("\n")}`;
};

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const operatorRecipient = (accountId: string): string => {
    const id = AccountId.fromString(accountId);
    // Public-key aliases do not resolve to an EVM recipient locally. The SDK
    // otherwise falls back to their zero account number. Nonzero shards/realms
    // likewise require an explicit recipient rather than a guessed address.
    if (id.aliasKey || !id.shard.isZero() || !id.realm.isZero()
        || (!id.evmAddress && id.num.lte(0))) {
        throw new Error("Cannot establish the operator's output address locally; provide an explicit recipient. No orders were signed or submitted.");
    }
    const recipient = `0x${id.toEvmAddress()}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) {
        throw new Error("Cannot establish the operator's output address locally; provide an explicit recipient. No orders were signed or submitted.");
    }
    return recipient;
};

/**
 * Anti-blind-signing guard: the server assigns nonce/reactor, but it has NO
 * legitimate reason to change the tokens or amounts the user asked for.
 * Refuse to sign any built order whose economic fields deviate from the
 * request — a compromised or buggy API response must never turn into an
 * operator-signed spend authorization for something the user did not request.
 * The deadline may only be SHORTENED (the server documents clamping down);
 * an extension is refused. All orders in a batch are validated BEFORE any
 * signature is produced (validate-all-then-sign).
 */
const assertBuiltOrderMatchesRequest = (
    built: SerializedOrder,
    request: OrderRequestInput & { recipient: string },
    index: number,
) => {
    const refuse = (field: string, requested: string, returned: string) => {
        throw new Error(
            `Refusing to sign: order ${index + 1} returned by /orders/build does not match the request — ${field} requested ${requested} but server returned ${returned}. No orders were submitted; no order signatures left this process.`,
        );
    };
    if (!sameAddress(built.input.token, request.inputToken)) {
        refuse("inputToken", request.inputToken, built.input.token);
    }
    if (built.input.amount !== request.inputAmount) {
        refuse("inputAmount", request.inputAmount, built.input.amount);
    }
    if (!sameAddress(built.output.token, request.outputToken)) {
        refuse("outputToken", request.outputToken, built.output.token);
    }
    if (built.output.amount !== request.outputAmount) {
        refuse("outputAmount", request.outputAmount, built.output.amount);
    }
    if (built.makerOnly !== (request.makerOnly ?? false)) {
        refuse("makerOnly", String(request.makerOnly ?? false), String(built.makerOnly));
    }
    if (built.takerOnce !== (request.takerOnce ?? false)) {
        refuse("takerOnce", String(request.takerOnce ?? false), String(built.takerOnce));
    }
    if (!sameAddress(built.output.recipient, request.recipient)) {
        refuse("recipient", request.recipient, built.output.recipient);
    }
    if (built.meta?.orderbookId !== undefined && built.meta.orderbookId !== request.orderbookId) {
        refuse("orderbookId", request.orderbookId, built.meta.orderbookId);
    }
    // Deadline: the server may clamp DOWN (documented); it must never extend
    // the life of the spend authorization beyond what was requested.
    if (request.deadline !== undefined && BigInt(built.info.deadline) > BigInt(request.deadline)) {
        refuse("deadline (extension beyond request)", request.deadline, built.info.deadline);
    }
};

type PlaceOrderbookOrderV3RawParams = z.infer<ReturnType<typeof placeOrderbookOrderV3Parameters>>;
type PlaceOrderbookOrderV3NormalisedParams = { orderRequests: OrderRequestInput[] };

export const PLACE_ORDERBOOK_ORDER_V3_TOOL = "place_orderbook_order_v3_tool" as const;

export class PlaceOrderbookOrderV3Tool extends BaseTool<
    PlaceOrderbookOrderV3RawParams,
    PlaceOrderbookOrderV3NormalisedParams
> {
    method = PLACE_ORDERBOOK_ORDER_V3_TOOL;
    name = "Place Orderbook Order (SaucerSwap V3)";
    description: string;
    parameters: ReturnType<typeof placeOrderbookOrderV3Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = placeOrderbookOrderV3Prompt(context);
        this.parameters = placeOrderbookOrderV3Parameters();
    }

    async normalizeParams(
        params: PlaceOrderbookOrderV3RawParams,
        _context: Context,
        _client: Client,
    ): Promise<PlaceOrderbookOrderV3NormalisedParams> {
        const parsed = placeOrderbookOrderV3Parameters().parse(params);

        if (parsed.orders.length > SAUCER_SWAP_CONFIG.ORDERBOOK_MAX_BUILD_BATCH) {
            throw new OrderbookBatchLimitError(
                "orders",
                parsed.orders.length,
                SAUCER_SWAP_CONFIG.ORDERBOOK_MAX_BUILD_BATCH,
            );
        }

        const orderRequests: OrderRequestInput[] = parsed.orders.map((order) => {
            if (order.type === "MARKET" && order.deadline !== undefined) {
                throw new Error(
                    "MARKET orders must not set a deadline — the server stamps its own short deadline",
                );
            }
            const deadline =
                order.type === "LIMIT"
                    ? (order.deadline ??
                        String(Math.floor(Date.now() / 1000) + SAUCER_SWAP_CONFIG.ORDERBOOK_DEFAULT_LIMIT_DEADLINE_SECONDS))
                    : undefined;
            return {
                orderbookId: order.orderbookId,
                type: order.type as OrderType,
                ...(deadline !== undefined ? { deadline } : {}),
                inputToken: order.inputToken,
                inputAmount: order.inputAmount,
                outputToken: order.outputToken,
                outputAmount: order.outputAmount,
                ...(order.recipient !== undefined ? { recipient: order.recipient } : {}),
                ...(order.makerOnly !== undefined ? { makerOnly: order.makerOnly } : {}),
                ...(order.takerOnce !== undefined ? { takerOnce: order.takerOnce } : {}),
                ...(order.isAMMEnabled !== undefined ? { isAMMEnabled: order.isAMMEnabled } : {}),
            };
        });

        return { orderRequests };
    }

    async coreAction(
        normalisedParams: PlaceOrderbookOrderV3NormalisedParams,
        context: Context,
        client: Client,
    ) {
        const api = new OrderbookApiService(client.ledgerId);
        const signer = getOperatorSigner(client, context);
        // Bind the self default locally, never to the recipient or swapper
        // returned by the API. The SDK handles numeric and EVM-alias IDs.
        const orderRequests = normalisedParams.orderRequests.map((request) => ({
            ...request,
            recipient: request.recipient ?? operatorRecipient(signer.accountId),
        }));

        // Auth happens implicitly (JWT cached per session, re-auth on 401).
        const domain = await api.getDomain(client, context);
        const builtOrders = await api.buildOrders(client, context, orderRequests);

        // Sign each RETURNED order struct — the server assigns nonce/reactor
        // and may clamp the deadline down, so the returned struct (not the
        // original input) is what must be signed. Guard rails first:
        // count parity, then per-field economic equality on EVERY order
        // (anti blind-signing) — no signature is produced until the whole
        // batch validates.
        if (builtOrders.length !== orderRequests.length) {
            throw new Error(
                `Refusing to sign: /orders/build returned ${builtOrders.length} order(s) for ${orderRequests.length} request(s). No orders were submitted; no order signatures left this process.`,
            );
        }

        for (let i = 0; i < builtOrders.length; i++) {
            assertBuiltOrderMatchesRequest(builtOrders[i], orderRequests[i], i);
        }

        const items: SaveOrderItem[] = [];
        for (let i = 0; i < builtOrders.length; i++) {
            const order = builtOrders[i];
            const request = orderRequests[i];
            const signature = await signOrder(signer, order, domain);
            items.push({
                order,
                signature,
                orderbookId: request.orderbookId,
                type: request.type,
            });
        }

        const saved = await api.saveOrders(client, context, items);
        return {
            raw: saved,
            humanMessage: postProcess(saved.orders),
        };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        return formatOrderbookToolError(PLACE_ORDERBOOK_ORDER_V3_TOOL, "Failed to place orderbook order(s)", error);
    }
}

const tool = (context: Context) => new PlaceOrderbookOrderV3Tool(context);

export default tool;
