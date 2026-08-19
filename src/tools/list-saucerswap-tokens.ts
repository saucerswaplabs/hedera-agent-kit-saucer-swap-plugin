import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from 'zod';
import type { Client } from "@hiero-ledger/sdk";
import { listSaucerSwapTokensParameters } from "../saucer-swap.zod";
import { SaucerSwapV2ConfigService } from "../service/saucer-swap-v2-config-service";
import { SaucerSwapApiServiceImpl } from "../service/saucer-swap-rest-pools-service";
import {
    DEFAULT_LIST_LIMIT,
    SaucerSwapTokenInfo,
    SaucerSwapTokenRegistry,
    formatUsd,
} from "../service/token-registry-service";
import { SaucerSwapError, logToolError } from "../errors";

const listTokensPrompt = (context: Context = {}) => `
${PromptGenerator.getContextSnippet(context)}

Lists the tokens that can actually be swapped on SaucerSwap V2 on the connected network,
ranked by how much USD liquidity each one has. Every entry includes the Hedera token id, so
the user can pick a token without looking anything up outside this conversation.

Use this whenever the user asks what is available, which tokens are popular, or names a token
you cannot map to an id. Do not answer such questions from memory — token availability differs
between mainnet and testnet and changes over time.

Parameters:
- limit (number, optional): How many tokens to return. Defaults to ${DEFAULT_LIST_LIMIT}.
- search (str, optional): Filter on symbol or name, e.g. "usd" to find stablecoins.

Symbols are not unique on Hedera — anyone can mint a token called USDC. When two entries share
a symbol or name, show both with their ids and let the user choose.
`;

type ListTokensParams = z.infer<ReturnType<typeof listSaucerSwapTokensParameters>>;

const renderToken = (token: SaucerSwapTokenInfo, index: number): string =>
    `${String(index + 1).padStart(2)}. ${token.symbol} — ${token.name} — id ${token.id} — ` +
    `${token.decimals} decimals — $${formatUsd(token.priceUsd)} — ` +
    `$${formatUsd(token.liquidityUsd)} liquidity across ${token.poolCount} pool(s)` +
    (token.isFeeOnTransferToken ? ' — fee-on-transfer token' : '');

export const LIST_TOKENS_TOOL = "list_saucerswap_tokens_tool" as const;

export class ListSaucerSwapTokensTool extends BaseTool<ListTokensParams, ListTokensParams> {
    method = LIST_TOKENS_TOOL;
    name = "List Swappable Tokens (SaucerSwap V2)";
    description: string;
    parameters: ReturnType<typeof listSaucerSwapTokensParameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = listTokensPrompt(context);
        this.parameters = listSaucerSwapTokensParameters();
    }

    async normalizeParams(params: ListTokensParams): Promise<ListTokensParams> {
        return listSaucerSwapTokensParameters().parse(params ?? {});
    }

    async coreAction(params: ListTokensParams, _context: Context, client: Client) {
        const config = new SaucerSwapV2ConfigService(client.ledgerId!);
        const api = new SaucerSwapApiServiceImpl(client.ledgerId!, config.getSaucerSwapApiKey());
        const registry = await SaucerSwapTokenRegistry.load(
            api,
            config.getWrappedHBARTokenId().toString(),
        );

        const tokens = registry.listTokens({ limit: params.limit, search: params.search });
        const network = client.ledgerId!.toString();

        if (!tokens.length) {
            const message = params.search
                ? `No SaucerSwap V2 token on ${network} matches "${params.search}". ` +
                  `Call this tool without a search filter to see all ${registry.tokenCount} tradable tokens.`
                : `SaucerSwap V2 reports no pools on ${network}.`;
            return { raw: { network, tokens: [], totalTradableTokens: registry.tokenCount }, humanMessage: message };
        }

        const heading = params.search
            ? `SaucerSwap V2 tokens on ${network} matching "${params.search}" ` +
              `(${tokens.length} of ${registry.tokenCount} tradable), deepest liquidity first:`
            : `Top ${tokens.length} of ${registry.tokenCount} swappable SaucerSwap V2 tokens on ${network}, ` +
              `deepest liquidity first:`;

        const humanMessage = [
            heading,
            ...tokens.map(renderToken),
            '',
            'Use the Hedera id (0.0.x) when quoting or swapping. Not every pair has a pool — ' +
            'list_saucerswap_pools_tool shows what a given token can be traded against.',
        ].join('\n');

        return {
            raw: { network, totalTradableTokens: registry.tokenCount, tokens },
            humanMessage,
        };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        const desc = 'Failed to list SaucerSwap tokens';
        const message =
            error instanceof SaucerSwapError ? `${desc}: ${error.message} (code: ${error.code})`
            : error instanceof Error ? `${desc}: ${error.message}`
            : `${desc}: Unknown error occurred`;
        logToolError(LIST_TOKENS_TOOL, message, error);
        return { raw: { error: message }, humanMessage: message };
    }
}

const tool = (context: Context) => new ListSaucerSwapTokensTool(context);

export default tool;
