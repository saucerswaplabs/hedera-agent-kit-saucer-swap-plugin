import type { Context, Plugin } from "@hashgraph/hedera-agent-kit";
import { version } from "../package.json";

import getSwapQuoteV2Tool, { GET_SWAP_QUOTE_V2_TOOL } from "./tools/get-swap-quote-v2";
import swapV2Tool, { SWAP_V2_TOOL } from "./tools/swap-v2";
import listSaucerSwapTokensTool, { LIST_TOKENS_TOOL } from "./tools/list-saucerswap-tokens";
import findSaucerSwapTokenTool, { FIND_TOKEN_TOOL } from "./tools/find-saucerswap-token";
import listSaucerSwapPoolsTool, { LIST_POOLS_TOOL } from "./tools/list-saucerswap-pools";

export const saucerSwapPlugin: Plugin = {
  name: 'saucer-swap-plugin',
  version,
  description: 'A plugin for SaucerSwap V2 DeFi operations on Hedera',
  tools: (context: Context) => {
    return [
        // Discovery first: an agent that can list and resolve tokens does not need to
        // recall token ids, which is where hallucinated pairs come from.
        listSaucerSwapTokensTool(context),
        findSaucerSwapTokenTool(context),
        listSaucerSwapPoolsTool(context),
        getSwapQuoteV2Tool(context),
        swapV2Tool(context),
    ];
  }
};

export const saucerSwapPluginToolNames = {
  LIST_TOKENS_TOOL,
  FIND_TOKEN_TOOL,
  LIST_POOLS_TOOL,
  GET_SWAP_QUOTE_V2_TOOL,
  SWAP_V2_TOOL
} as const;

export {
  SaucerSwapTokenRegistry,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from "./service/token-registry-service";
export type {
  SaucerSwapTokenInfo,
  SaucerSwapPoolSummary,
  SaucerSwapSwapRoute,
  TokenResolution,
} from "./service/token-registry-service";
export {
  SaucerSwapError,
  PoolNotFoundError,
  TokenNotFoundError,
  AmbiguousTokenError,
} from "./errors";

export default { saucerSwapPlugin, saucerSwapPluginToolNames };
