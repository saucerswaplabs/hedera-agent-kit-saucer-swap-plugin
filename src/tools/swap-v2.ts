import SaucerSwapV2ParameterNormaliser, {
    NormalisedSwapV2Params,
    ResolvedSwapV2Context,
} from "../saucer-swap-v2-parameter-normaliser";
import { swapV2Parameters } from "../saucer-swap.zod";
import {
    AgentMode,
    BaseTool,
    Context,
    getMirrornodeService,
    handleTransaction,
    HederaBuilder,
    HederaParameterNormaliser,
    PromptGenerator,
    RawTransactionResponse,
    transactionToolOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import { Client, Status } from "@hiero-ledger/sdk";
import { SaucerSwapV2ConfigService } from "../service/saucer-swap-v2-config-service";
import { SaucerSwapApiServiceImpl } from "../service/saucer-swap-rest-pools-service";
import { SaucerSwapTokenRegistry } from "../service/token-registry-service";
import { SaucerSwapError, TokenNotAssociatedError, logToolError } from "../errors";
import { describeTokenForUser } from "../utils";
import { isTokenAssociated } from "../utils/token-association";
import { ensureTokenAllowance } from "../utils/token-allowance";
import { LIST_TOKENS_TOOL } from "./list-saucerswap-tokens";

const swapV2Prompt = (context: Context = {}) => `
${PromptGenerator.getContextSnippet(context)}

This tool will swap tokens using the SaucerSwap V2 protocol. It spends the user's funds, so
confirm the pair and the amount first — quoting with get_swap_quote_v2_tool beforehand is the norm.

Token parameters accept whatever the user said: a symbol, a token name, a Hedera token id or an
EVM address, resolved against live pool data. Never invent a token id — call ${LIST_TOKENS_TOOL}
when you are unsure which token is meant. If the tool reports AMBIGUOUS_TOKEN, relay the
candidates and let the user pick an id instead of choosing for them.

Amounts are in display units: "swap 100 HBAR" means amountIn: 100.

If the recipient has not associated the output token, the tool will associate it first (only
works when the recipient equals the signing account; otherwise the call fails with a clear error
and the recipient must associate the token themselves). When tokenIn is not native HBAR / WHBAR,
the tool also grants an AccountAllowance to the SwapRouter contract for amountIn before swapping.

Asking for HBAR as tokenOut pays out native HBAR: the router unwraps WHBAR as part of the same
transaction, so the recipient needs no WHBAR association and their HBAR balance goes up.

Parameters:
- tokenIn (str, required): The token being sold. Symbol, name, Hedera id ("0.0.456858") or EVM address. "HBAR" is routed via WHBAR.
- tokenOut (str, required): The token being bought, same formats.
- amountIn (number, required): The amount of tokenIn to sell, in display units.
- recipientAddress (str, optional): The account to receive the output tokens. Defaults to the operator account.

Note: the swap executes at whatever price the pool gives — there is no slippage limit — so keep
amounts modest on low-liquidity pairs.
`;

const postProcess = (response: RawTransactionResponse, resolved: ResolvedSwapV2Context) =>
    `Swapped ${resolved.amountInDisplay} ` +
    `${describeTokenForUser(resolved.tokenIn.symbol, resolved.tokenIn.id, resolved.isInputWrappedHBAR)} ` +
    `for ${describeTokenForUser(resolved.tokenOut.symbol, resolved.tokenOut.id, resolved.isOutputWrappedHBAR)} ` +
    `through the ${resolved.feePercent}% fee pool, ` +
    `sent to ${resolved.recipientAccountId}.\nTransaction ID: ${response.transactionId}`;

const resolveSignerAccountId = (context: Context, client: Client): string | undefined => {
    if (context.mode === AgentMode.RETURN_BYTES) {
        return context.accountId;
    }
    return client.operatorAccountId?.toString();
};

const ensureTokenAssociated = async (
    recipientAccountId: string,
    tokenOutHederaId: string,
    context: Context,
    client: Client,
    mirrorNode: ReturnType<typeof getMirrornodeService>,
) => {
    if (await isTokenAssociated(recipientAccountId, tokenOutHederaId, mirrorNode)) return;

    const signer = resolveSignerAccountId(context, client);
    if (!signer || signer !== recipientAccountId) {
        throw new TokenNotAssociatedError(recipientAccountId, tokenOutHederaId, signer);
    }

    const associateParams = HederaParameterNormaliser.normaliseAssociateTokenParams(
        { accountId: recipientAccountId, tokenIds: [tokenOutHederaId] },
        context,
        client,
    );
    const associateTx = HederaBuilder.associateToken(associateParams);
    await handleTransaction(associateTx, client, context, () =>
        `Associated token ${tokenOutHederaId} with account ${recipientAccountId}`,
    );
};

type SwapV2RawParams = z.infer<ReturnType<typeof swapV2Parameters>>;

type SwapV2NormalisedParams = NormalisedSwapV2Params & {
    /** The SwapRouter, which needs an allowance when the input is not native HBAR. */
    spenderAccountId?: string;
};

type SwapV2CoreActionResult = {
    transaction: ReturnType<typeof HederaBuilder.executeTransaction>;
    resolved: ResolvedSwapV2Context;
};

export const SWAP_V2_TOOL = 'swap_v2_tool';

export class SwapV2Tool extends BaseTool<SwapV2RawParams, SwapV2NormalisedParams> {
    method = SWAP_V2_TOOL;
    name = 'Swap V2';
    description: string;
    parameters: ReturnType<typeof swapV2Parameters>;
    outputParser = transactionToolOutputParser;

    constructor(context: Context) {
        super();
        this.description = swapV2Prompt(context);
        this.parameters = swapV2Parameters();
    }

    async normalizeParams(
        params: SwapV2RawParams,
        context: Context,
        client: Client,
    ): Promise<SwapV2NormalisedParams> {
        const mirrorNode = getMirrornodeService(context.mirrornodeService, client.ledgerId!);
        const config = new SaucerSwapV2ConfigService(client.ledgerId!);
        const api = new SaucerSwapApiServiceImpl(client.ledgerId!, config.getSaucerSwapApiKey());
        const registry = await SaucerSwapTokenRegistry.load(
            api,
            config.getWrappedHBARTokenId().toString(),
        );

        const normalised = await SaucerSwapV2ParameterNormaliser.normaliseSwapV2Params(
            params, context, config, registry, mirrorNode, client,
        );

        return {
            ...normalised,
            spenderAccountId: normalised.resolved.isInputWrappedHBAR
                ? undefined
                : config.getSwapRouterContractId().toString(),
        };
    }

    async coreAction(
        normalisedParams: SwapV2NormalisedParams,
        context: Context,
        client: Client,
    ): Promise<SwapV2CoreActionResult> {
        const mirrorNode = getMirrornodeService(context.mirrornodeService, client.ledgerId!);
        const { contractParams, resolved, spenderAccountId } = normalisedParams;

        if (!resolved.isOutputWrappedHBAR) {
            await ensureTokenAssociated(
                resolved.recipientAccountId, resolved.tokenOut.id, context, client, mirrorNode,
            );
        }

        if (!resolved.isInputWrappedHBAR) {
            const ownerAccountId = resolveSignerAccountId(context, client);
            if (!ownerAccountId) {
                throw new SaucerSwapError('Cannot resolve owner account for token allowance', 'OWNER_UNRESOLVED');
            }
            await ensureTokenAllowance(
                ownerAccountId,
                spenderAccountId!,
                resolved.tokenIn.id,
                resolved.amountInBase,
                resolved.tokenIn.decimals,
                context,
                client,
                mirrorNode,
            );
        }

        // Carrying `resolved` through to the secondary action is what lets the
        // confirmation name the tokens instead of just echoing a transaction id.
        return { transaction: HederaBuilder.executeTransaction(contractParams), resolved };
    }

    async secondaryAction(
        coreActionResult: SwapV2CoreActionResult,
        client: Client,
        context: Context,
    ) {
        const { transaction, resolved } = coreActionResult;
        return await handleTransaction(transaction, client, context, response =>
            postProcess(response, resolved),
        );
    }

    async handleError(error: unknown, _context: Context) {
        const desc = 'Failed to swap tokens';
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
        logToolError(SWAP_V2_TOOL, message, error);
        return {
            raw: {
                status: Status.InvalidTransaction.toString(),
                accountId: null,
                tokenId: null,
                transactionId: '',
                topicId: null,
                scheduleId: null,
                error: message,
                code,
            },
            humanMessage: message,
        };
    }
}

const tool = (context: Context) => new SwapV2Tool(context);

export default tool;
