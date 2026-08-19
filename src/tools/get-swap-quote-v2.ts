import {
    BaseTool,
    Context,
    PromptGenerator,
    getMirrornodeService,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from 'zod';
import type { Client } from "@hiero-ledger/sdk";
import { getSwapQuoteV2Parameters, getSwapQuoteV2ParametersNormalised } from "../saucer-swap.zod";
import { SaucerSwapV2QueryServiceImpl } from "../service/saucer-swap-v2-query-service-impl";
import SaucerSwapV2ParameterNormaliser from "../saucer-swap-v2-parameter-normaliser";
import { SaucerSwapV2ConfigService } from "../service/saucer-swap-v2-config-service";
import { SaucerSwapApiServiceImpl } from "../service/saucer-swap-rest-pools-service";
import { SaucerSwapTokenRegistry } from "../service/token-registry-service";
import { SaucerSwapError, logToolError } from "../errors";
import { describeTokenForUser, formatTokenAmount, fromBaseUnit } from "../utils";
import { LIST_TOKENS_TOOL } from "./list-saucerswap-tokens";

const getSwapQuoteV2Prompt = (context: Context = {}) => {
    const contextSnippet = PromptGenerator.getContextSnippet(context);
    const usageInstructions = PromptGenerator.getParameterUsageInstructions();

    return `
${contextSnippet}

Quotes a SaucerSwap V2 swap: how much tokenOut the user would receive for amountIn of tokenIn.

Token parameters take whatever the user said — a symbol, a token name, a Hedera token id
or an EVM address — and are resolved against live pool data. Never invent a token id: if
you do not know which token the user means, call ${LIST_TOKENS_TOOL} first.

Amounts are in display units, so pass the number the user said (100 HBAR -> amountIn: 100).

Parameters:
- tokenIn (str, required): The token being sold. Symbol, name, Hedera id ("0.0.456858") or EVM address. "HBAR" is routed via WHBAR.
- tokenOut (str, required): The token being bought, same formats.
- amountIn (number, required): The amount of tokenIn to sell, in display units.
${usageInstructions}

If the tool reports AMBIGUOUS_TOKEN, several tokens share that symbol or name — relay the
candidates and ask the user which token id they mean. If it reports POOL_NOT_FOUND, the pair
has no direct pool; the error lists what each token can be traded against instead.

Example: "Get a quote for swapping 100 HBAR to USDC"
`;
};

type GetSwapQuoteV2RawParams = z.infer<ReturnType<typeof getSwapQuoteV2Parameters>>;
type GetSwapQuoteV2NormalisedParams = z.infer<ReturnType<typeof getSwapQuoteV2ParametersNormalised>>;

const postProcess = (
    amountOutBase: bigint,
    params: GetSwapQuoteV2NormalisedParams,
) => {
    const amountIn = formatTokenAmount(params.amountIn, params.tokenInDecimals);
    const amountOut = formatTokenAmount(amountOutBase, params.tokenOutDecimals);
    const rate = fromBaseUnit(amountOutBase, params.tokenOutDecimals)
        .dividedBy(fromBaseUnit(params.amountIn, params.tokenInDecimals));

    const tokenInLabel = describeTokenForUser(
        params.tokenInSymbol, params.tokenInId, params.isInputWrappedHBAR,
    );
    const tokenOutLabel = describeTokenForUser(
        params.tokenOutSymbol, params.tokenOutId, params.isOutputWrappedHBAR,
    );

    return (
        `Swapping ${amountIn} ${tokenInLabel} returns about ` +
        `${amountOut} ${tokenOutLabel}. ` +
        `Rate: 1 ${params.tokenInSymbol} ≈ ${rate.toPrecision(8)} ${params.tokenOutSymbol}. ` +
        `Routed through the ${params.feePercent}% fee pool. ` +
        `The quote is indicative — it excludes slippage and Hedera network fees.`
    );
};

export const GET_SWAP_QUOTE_V2_TOOL = "get_swap_quote_v2_tool" as const;

export class GetSwapQuoteV2Tool extends BaseTool<GetSwapQuoteV2RawParams, GetSwapQuoteV2NormalisedParams> {
    method = GET_SWAP_QUOTE_V2_TOOL;
    name = "Get Quote (SaucerSwap V2)";
    description: string;
    parameters: ReturnType<typeof getSwapQuoteV2Parameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = getSwapQuoteV2Prompt(context);
        this.parameters = getSwapQuoteV2Parameters();
    }

    async normalizeParams(
        params: GetSwapQuoteV2RawParams,
        context: Context,
        client: Client,
    ): Promise<GetSwapQuoteV2NormalisedParams> {
        const config = new SaucerSwapV2ConfigService(client.ledgerId!);
        const api = new SaucerSwapApiServiceImpl(client.ledgerId!, config.getSaucerSwapApiKey());
        const registry = await SaucerSwapTokenRegistry.load(
            api,
            config.getWrappedHBARTokenId().toString(),
        );
        return await SaucerSwapV2ParameterNormaliser.normaliseGetSwapQuoteV2Params(params, context, registry);
    }

    async coreAction(
        normalisedParams: GetSwapQuoteV2NormalisedParams,
        context: Context,
        client: Client,
    ) {
        const mirrorNode = getMirrornodeService(context.mirrornodeService, client.ledgerId!);
        const config = new SaucerSwapV2ConfigService(client.ledgerId!);
        const queryService = new SaucerSwapV2QueryServiceImpl(client.ledgerId!, mirrorNode, config);
        const quote = await queryService.getSwapQuote(
            normalisedParams.tokenIn,
            normalisedParams.tokenOut,
            normalisedParams.amountIn,
            normalisedParams.poolFeesInHexFormat.toLowerCase(),
        );
        return {
            raw: {
                // `quote` stays in base units for backwards compatibility, as an exact string.
                quote: quote.toString(),
                amountOut: formatTokenAmount(quote, normalisedParams.tokenOutDecimals),
                amountIn: formatTokenAmount(normalisedParams.amountIn, normalisedParams.tokenInDecimals),
                tokenIn: {
                    id: normalisedParams.tokenInId,
                    symbol: normalisedParams.tokenInSymbol,
                    decimals: normalisedParams.tokenInDecimals,
                },
                tokenOut: {
                    id: normalisedParams.tokenOutId,
                    symbol: normalisedParams.tokenOutSymbol,
                    decimals: normalisedParams.tokenOutDecimals,
                },
                feePercent: normalisedParams.feePercent,
            },
            humanMessage: postProcess(quote, normalisedParams),
        };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        const desc = 'Failed to get quote';
        let message: string;
        let code: string | undefined;
        if (error instanceof SaucerSwapError) {
            code = error.code;
            message = `${desc}: ${error.message} (code: ${error.code})`;
        } else if (error instanceof Error) {
            message = `${desc}: ${error.message}`;
        } else {
            message = `${desc}: Unknown error occurred`;
        }
        logToolError(GET_SWAP_QUOTE_V2_TOOL, message, error);
        return { raw: { error: message, code }, humanMessage: message };
    }
}

const tool = (context: Context) => new GetSwapQuoteV2Tool(context);

export default tool;
