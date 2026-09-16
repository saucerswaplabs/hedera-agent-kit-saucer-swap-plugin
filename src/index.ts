import type { Context, Plugin } from "@hashgraph/hedera-agent-kit";
import { version } from "../package.json";

import getSwapQuoteV2Tool, { GET_SWAP_QUOTE_V2_TOOL } from "./tools/get-swap-quote-v2";
import swapV2Tool, { SWAP_V2_TOOL } from "./tools/swap-v2";
import listSaucerSwapTokensTool, { LIST_TOKENS_TOOL } from "./tools/list-saucerswap-tokens";
import findSaucerSwapTokenTool, { FIND_TOKEN_TOOL } from "./tools/find-saucerswap-token";
import listSaucerSwapPoolsTool, { LIST_POOLS_TOOL } from "./tools/list-saucerswap-pools";

import getOrderbooksV3Tool, { GET_ORDERBOOKS_V3_TOOL } from "./tools/get-orderbooks-v3";
import getOrderbookDepthV3Tool, { GET_ORDERBOOK_DEPTH_V3_TOOL } from "./tools/get-orderbook-depth-v3";
import getOrderbookTradesV3Tool, { GET_ORDERBOOK_TRADES_V3_TOOL } from "./tools/get-orderbook-trades-v3";
import getOrderbookQuoteV3Tool, { GET_ORDERBOOK_QUOTE_V3_TOOL } from "./tools/get-orderbook-quote-v3";
import placeOrderbookOrderV3Tool, { PLACE_ORDERBOOK_ORDER_V3_TOOL } from "./tools/place-orderbook-order-v3";
import cancelOrderbookOrdersV3Tool, { CANCEL_ORDERBOOK_ORDERS_V3_TOOL } from "./tools/cancel-orderbook-orders-v3";
import getMyOrderbookOrdersV3Tool, { GET_MY_ORDERBOOK_ORDERS_V3_TOOL } from "./tools/get-my-orderbook-orders-v3";

export const saucerSwapPlugin: Plugin = {
  name: 'saucer-swap-plugin',
  version,
  description: 'A plugin for SaucerSwap token discovery, V2 AMM swaps and quotes, and V3 orderbook market data and trading',
  tools: (context: Context) => {
    return [
        // Discovery first: an agent that can list and resolve tokens does not need to
        // recall token ids, which is where hallucinated pairs come from.
        listSaucerSwapTokensTool(context),
        findSaucerSwapTokenTool(context),
        listSaucerSwapPoolsTool(context),
        getSwapQuoteV2Tool(context),
        swapV2Tool(context),
        getOrderbooksV3Tool(context),
        getOrderbookDepthV3Tool(context),
        getOrderbookTradesV3Tool(context),
        getOrderbookQuoteV3Tool(context),
        placeOrderbookOrderV3Tool(context),
        cancelOrderbookOrdersV3Tool(context),
        getMyOrderbookOrdersV3Tool(context),
    ];
  }
};

export const saucerSwapPluginToolNames = {
  LIST_TOKENS_TOOL,
  FIND_TOKEN_TOOL,
  LIST_POOLS_TOOL,
  GET_SWAP_QUOTE_V2_TOOL,
  SWAP_V2_TOOL,
  GET_ORDERBOOKS_V3_TOOL,
  GET_ORDERBOOK_DEPTH_V3_TOOL,
  GET_ORDERBOOK_TRADES_V3_TOOL,
  GET_ORDERBOOK_QUOTE_V3_TOOL,
  PLACE_ORDERBOOK_ORDER_V3_TOOL,
  CANCEL_ORDERBOOK_ORDERS_V3_TOOL,
  GET_MY_ORDERBOOK_ORDERS_V3_TOOL,
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
