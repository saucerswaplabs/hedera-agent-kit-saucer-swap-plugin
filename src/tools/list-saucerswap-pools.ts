import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from 'zod';
import type { Client } from "@hiero-ledger/sdk";
import { listSaucerSwapPoolsParameters } from "../saucer-swap.zod";
import { SaucerSwapV2ConfigService } from "../service/saucer-swap-v2-config-service";
import { SaucerSwapApiServiceImpl } from "../service/saucer-swap-rest-pools-service";
import {
    DEFAULT_LIST_LIMIT,
    SaucerSwapPoolSummary,
    SaucerSwapSwapRoute,
    SaucerSwapTokenInfo,
    SaucerSwapTokenRegistry,
    formatUsd,
} from "../service/token-registry-service";
import { SaucerSwapError, logToolError } from "../errors";

const listPoolsPrompt = (context: Context = {}) => `
${PromptGenerator.getContextSnippet(context)}

Lists SaucerSwap V2 pools, ranked by USD liquidity.

Given a token, it answers "what can this be swapped for?" — the tokens sharing a pool with it,
with the fee tier of the deepest pool for each. Without a token it lists the busiest pools on
the network.

SaucerSwap V2 routing in this plugin is single-hop, so a swap only works when the two tokens
share a pool. Use this tool before promising a pair, and after a POOL_NOT_FOUND error.

Parameters:
- token (str, optional): Symbol, name, Hedera token id or EVM address to filter by. "HBAR" works.
- limit (number, optional): How many results to return. Defaults to ${DEFAULT_LIST_LIMIT}.
`;

type ListPoolsParams = z.infer<ReturnType<typeof listSaucerSwapPoolsParameters>>;

const renderPool = (pool: SaucerSwapPoolSummary, index: number): string =>
    `${String(index + 1).padStart(2)}. ${pool.tokenA.symbol} (${pool.tokenA.id}) / ` +
    `${pool.tokenB.symbol} (${pool.tokenB.id}) — ${pool.feePercent}% fee — ` +
    `$${formatUsd(pool.liquidityUsd)} liquidity`;

const renderRoute = (route: SaucerSwapSwapRoute, index: number): string =>
    `${String(index + 1).padStart(2)}. ${route.token.symbol} — ${route.token.name} — ` +
    `id ${route.token.id} — ${route.feePercent}% fee — $${formatUsd(route.liquidityUsd)} liquidity` +
    (route.poolCount > 1 ? ` (${route.poolCount} fee tiers available)` : '');

export const LIST_POOLS_TOOL = "list_saucerswap_pools_tool" as const;

export class ListSaucerSwapPoolsTool extends BaseTool<ListPoolsParams, ListPoolsParams> {
    method = LIST_POOLS_TOOL;
    name = "List Pools (SaucerSwap V2)";
    description: string;
    parameters: ReturnType<typeof listSaucerSwapPoolsParameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = listPoolsPrompt(context);
        this.parameters = listSaucerSwapPoolsParameters();
    }

    async normalizeParams(params: ListPoolsParams): Promise<ListPoolsParams> {
        return listSaucerSwapPoolsParameters().parse(params ?? {});
    }

    async coreAction(params: ListPoolsParams, _context: Context, client: Client) {
        const config = new SaucerSwapV2ConfigService(client.ledgerId!);
        const api = new SaucerSwapApiServiceImpl(client.ledgerId!, config.getSaucerSwapApiKey());
        const registry = await SaucerSwapTokenRegistry.load(
            api,
            config.getWrappedHBARTokenId().toString(),
        );
        const network = client.ledgerId!.toString();

        if (!params.token) {
            const pools = registry.listPools({ limit: params.limit });
            return {
                raw: { network, totalPools: registry.poolCount, pools },
                humanMessage: [
                    `Top ${pools.length} of ${registry.poolCount} SaucerSwap V2 pools on ${network}, ` +
                    `deepest liquidity first:`,
                    ...pools.map(renderPool),
                ].join('\n'),
            };
        }

        const resolution = registry.resolve(params.token);

        if (resolution.status === 'ambiguous') {
            return {
                raw: { network, status: resolution.status, query: params.token, candidates: resolution.candidates },
                humanMessage: [
                    `"${params.token}" matches ${resolution.candidates.length} tokens on ${network}. ` +
                    `Ask the user which one, then call again with its id:`,
                    ...resolution.candidates.map(
                        (t: SaucerSwapTokenInfo) =>
                            `- ${t.symbol} — ${t.name} — id ${t.id} — $${formatUsd(t.liquidityUsd)} liquidity`,
                    ),
                ].join('\n'),
            };
        }

        if (resolution.status === 'not_found') {
            return {
                raw: { network, status: resolution.status, query: params.token, suggestions: resolution.suggestions },
                humanMessage:
                    `No token with SaucerSwap V2 liquidity on ${network} matches "${params.token}". ` +
                    `Tokens with the deepest liquidity: ` +
                    resolution.suggestions.map(t => `${t.symbol} (${t.id})`).join(', ') + '.',
            };
        }

        const { token } = resolution;
        const routes = registry.listRoutesFor(token.id, params.limit);

        if (!routes.length) {
            return {
                raw: { network, token, routes: [] },
                humanMessage:
                    `${token.symbol} (${token.id}) has no SaucerSwap V2 pool on ${network}, so it cannot be swapped.`,
            };
        }

        return {
            raw: { network, token, routes },
            humanMessage: [
                `${token.symbol} (${token.id}) can be swapped directly for ${routes.length} token(s) ` +
                `on ${network}, deepest liquidity first:`,
                ...routes.map(renderRoute),
                '',
                `Anything not listed needs two swaps — this plugin routes single-hop only.`,
            ].join('\n'),
        };
    }

    async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
        return false;
    }

    async secondaryAction(_request: unknown, _client: Client, _context: Context) {
        return null;
    }

    async handleError(error: unknown, _context: Context) {
        const desc = 'Failed to list SaucerSwap pools';
        const message =
            error instanceof SaucerSwapError ? `${desc}: ${error.message} (code: ${error.code})`
            : error instanceof Error ? `${desc}: ${error.message}`
            : `${desc}: Unknown error occurred`;
        logToolError(LIST_POOLS_TOOL, message, error);
        return { raw: { error: message }, humanMessage: message };
    }
}

const tool = (context: Context) => new ListSaucerSwapPoolsTool(context);

export default tool;
