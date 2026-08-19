import {
    BaseTool,
    Context,
    PromptGenerator,
    untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { z } from 'zod';
import type { Client } from "@hiero-ledger/sdk";
import { findSaucerSwapTokenParameters } from "../saucer-swap.zod";
import { SaucerSwapV2ConfigService } from "../service/saucer-swap-v2-config-service";
import { SaucerSwapApiServiceImpl } from "../service/saucer-swap-rest-pools-service";
import {
    SaucerSwapTokenInfo,
    SaucerSwapTokenRegistry,
    formatUsd,
} from "../service/token-registry-service";
import { SaucerSwapError, logToolError } from "../errors";
import { LIST_TOKENS_TOOL } from "./list-saucerswap-tokens";

const findTokenPrompt = (context: Context = {}) => `
${PromptGenerator.getContextSnippet(context)}

Turns a token name or symbol the user typed into a concrete Hedera token id on SaucerSwap V2,
and reports what that token can be swapped for.

Call this before quoting or swapping whenever the user named a token in words rather than an id
and you want to confirm the match — or when a swap failed with AMBIGUOUS_TOKEN.

Parameters:
- query (str, required): The symbol, name, Hedera token id or EVM address the user gave.

Three outcomes:
- one match: the token id is confirmed and you can proceed.
- several matches: the symbol or name is shared by different tokens. Show the candidates with
  their ids, ask the user which one they mean, then use that id verbatim. Never choose for them.
- no match: the token has no SaucerSwap V2 liquidity. Say so and offer alternatives from
  ${LIST_TOKENS_TOOL} instead of guessing an id.
`;

type FindTokenParams = z.infer<ReturnType<typeof findSaucerSwapTokenParameters>>;

const renderCandidate = (token: SaucerSwapTokenInfo, index: number): string =>
    `${index + 1}. ${token.symbol} — ${token.name} — id ${token.id} — ${token.decimals} decimals — ` +
    `$${formatUsd(token.priceUsd)} — $${formatUsd(token.liquidityUsd)} liquidity across ${token.poolCount} pool(s)`;

export const FIND_TOKEN_TOOL = "find_saucerswap_token_tool" as const;

export class FindSaucerSwapTokenTool extends BaseTool<FindTokenParams, FindTokenParams> {
    method = FIND_TOKEN_TOOL;
    name = "Find Token (SaucerSwap V2)";
    description: string;
    parameters: ReturnType<typeof findSaucerSwapTokenParameters>;
    outputParser = untypedQueryOutputParser;

    constructor(context: Context) {
        super();
        this.description = findTokenPrompt(context);
        this.parameters = findSaucerSwapTokenParameters();
    }

    async normalizeParams(params: FindTokenParams): Promise<FindTokenParams> {
        return findSaucerSwapTokenParameters().parse(params);
    }

    async coreAction(params: FindTokenParams, _context: Context, client: Client) {
        const config = new SaucerSwapV2ConfigService(client.ledgerId!);
        const api = new SaucerSwapApiServiceImpl(client.ledgerId!, config.getSaucerSwapApiKey());
        const registry = await SaucerSwapTokenRegistry.load(
            api,
            config.getWrappedHBARTokenId().toString(),
        );

        const resolution = registry.resolve(params.query);
        const network = client.ledgerId!.toString();

        if (resolution.status === 'ambiguous') {
            return {
                raw: { network, status: resolution.status, query: params.query, candidates: resolution.candidates },
                humanMessage: [
                    `"${params.query}" matches ${resolution.candidates.length} different tokens on ` +
                    `SaucerSwap V2 (${network}). Ask the user which one they mean and use its id:`,
                    ...resolution.candidates.map(renderCandidate),
                ].join('\n'),
            };
        }

        if (resolution.status === 'not_found') {
            return {
                raw: { network, status: resolution.status, query: params.query, suggestions: resolution.suggestions },
                humanMessage: [
                    `No token with SaucerSwap V2 liquidity on ${network} matches "${params.query}". ` +
                    `It may exist on Hedera without a V2 pool, or the name may be wrong. ` +
                    `The deepest tradable tokens right now are:`,
                    ...resolution.suggestions.map(renderCandidate),
                ].join('\n'),
            };
        }

        const { token } = resolution;
        const routes = registry.listRoutesFor(token.id);

        return {
            raw: { network, status: resolution.status, query: params.query, token, routes },
            humanMessage: [
                `"${params.query}" is ${token.symbol} — ${token.name}, id ${token.id} ` +
                `(${token.decimals} decimals, $${formatUsd(token.priceUsd)}, ` +
                `$${formatUsd(token.liquidityUsd)} liquidity across ${token.poolCount} pool(s)).`,
                routes.length
                    ? `It can be swapped directly for: ` +
                      routes
                          .map(r => `${r.token.symbol} (${r.token.id}, ${r.feePercent}% fee)`)
                          .join(', ') + '.'
                    : `It currently has no usable V2 pool, so it cannot be swapped.`,
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
        const desc = 'Failed to look up token';
        const message =
            error instanceof SaucerSwapError ? `${desc}: ${error.message} (code: ${error.code})`
            : error instanceof Error ? `${desc}: ${error.message}`
            : `${desc}: Unknown error occurred`;
        logToolError(FIND_TOKEN_TOOL, message, error);
        return { raw: { error: message }, humanMessage: message };
    }
}

const tool = (context: Context) => new FindSaucerSwapTokenTool(context);

export default tool;
