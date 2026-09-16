/**
 * Types for the SaucerSwap V3 Orderbook API.
 *
 * Shapes mirror the authoritative reference client
 * (saucerswap-server/src/scripts/orderbook/api/client.ts) and the
 * orderbook_api_integration_guide.md, and were verified field-by-field
 * against the LIVE deployed API on both networks on 2026-09-15
 * (mainnet https://orderbook-api.saucerswap.finance, testnet
 * https://testnet-orderbook-api.saucerswap.finance).
 */

export type OrderbookRestNetwork = "MAINNET" | "TESTNET";

// ---------------------------------------------------------------------------
// GET /books
// ---------------------------------------------------------------------------

export interface OrderbookItem {
  /** Market id — serialized as a decimal STRING by the live API (e.g. "5"). */
  id: string;
  baseTokenId: string;
  quoteTokenId: string;
  baseTokenEvmAddress: string;
  quoteTokenEvmAddress: string;
  status: string;
  /** Serialized as 0/1 by the live API; treat as truthy/falsy. */
  isAMMEnabled: boolean | 0 | 1;
  /** Serialized as 0/1 by the live API; treat as truthy/falsy. */
  isMarketHalted: boolean | 0 | 1;
  baseTokenSymbol: string | null;
  quoteTokenSymbol: string | null;
  baseTokenDecimals: number | null;
  quoteTokenDecimals: number | null;
  quotePrice: string | null;
  quotePrice24hPct: string | null;
  quotePrice24hHigh: string | null;
  quotePrice24hLow: string | null;
  baseVol24h: string | null;
  quoteVol24h: string | null;
  tickStep: string;
  sizeStep: string;
  lotSize: string;
  minNotional: string;
  /** Taker fee in pips (1 pip = 1e-6) — NOT basis points. */
  takerFeePips: number;
  /** Maker fee in pips (1 pip = 1e-6) — NOT basis points. */
  makerFeePips: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedOrderbooksResult {
  orderbooks: OrderbookItem[];
  total: number;
  page: number;
  limit: number;
}

export interface GetOrderbooksQuery {
  page?: number;
  limit?: number;
  orderbookId?: number;
  tokenId?: string;
  symbol?: string;
  status?: "OPEN" | "CLOSED";
}

// ---------------------------------------------------------------------------
// GET /depth/:orderbookId
// ---------------------------------------------------------------------------

export interface DepthSnapshot {
  orderbookId: string;
  timestamp: number;
  baseTokenId: string;
  quoteTokenId: string;
  bestBidQuote: string | null;
  bestAskQuote: string | null;
  /** Mid-relative spread pre-formatted to 3 dp (e.g. "1.244"); null if a side is empty */
  spreadPercent: string | null;
  /** [price, size][] sorted ask-ascending */
  asks: [string, string][];
  /** [price, size][] sorted bid-descending */
  bids: [string, string][];
  lastUpdateId: number;
}

// ---------------------------------------------------------------------------
// GET /trades/:orderbookId
// ---------------------------------------------------------------------------

export interface TradeItem {
  /** Unix milliseconds. */
  timestamp: number;
  /** Human-readable quote-per-base price string. */
  price: string;
  /** Base-token amount, HUMAN-READABLE decimals-adjusted string (NOT raw units). */
  amountBase: string;
  direction: "buy" | "sell";
  transactionHash: string;
}

export interface RecentTradesResult {
  orderbookId: string;
  timestamp: number;
  trades: TradeItem[];
  total: number;
  page: number;
  limit: number;
}

export interface GetTradesQuery {
  sort?: "asc" | "desc";
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// GET /books/:id/quote/exact-input | exact-output
// ---------------------------------------------------------------------------

export interface ExactInputQuoteResult {
  outputToken: string;
  /** Input floored to the lot/size grid — submit THIS as inputAmount when building. */
  snappedInputAmount: string;
  /**
   * How much of snappedInputAmount the current book absorbs. Emitted by the
   * live API on both networks (verified 2026-09-15); kept optional so the
   * tool stays tolerant of older deployments that omit it.
   */
  consumedInputAmount?: string;
  /** Raw expected fill, no slippage applied. */
  expectedOutputAmount: string;
  /** Use as outputAmount in POST /orders/build. */
  suggestedOutputAmount: string;
  /** Fixed applied slippage buffer in bps — NOT market impact. */
  slippageBps: number;
  /** false when no liquidity exists at all. */
  fillable: boolean;
}

export interface ExactOutputQuoteResult {
  inputToken: string;
  /** Echo of the requested output amount. */
  requestedOutputAmount: string;
  /** What you'll actually receive (= requested when on-grid) — submit THIS as outputAmount. */
  snappedOutputAmount: string;
  /** Raw cost, no slippage applied. */
  expectedInputAmount: string;
  /** Bumped UP by slippage — use as inputAmount in POST /orders/build. */
  suggestedInputAmount: string;
  /** Fixed applied slippage buffer in bps — NOT market impact. */
  slippageBps: number;
  /** false when book depth < outputAmount. */
  fillable: boolean;
}

// ---------------------------------------------------------------------------
// Orders (JWT-gated)
// ---------------------------------------------------------------------------

export type OrderStatus =
  | "ACTIVE"
  | "CANCELED"
  | "FILLED"
  | "EXPIRED"
  | "FAILED"
  | "CLOSED"
  | "PARTIAL_FILLED"
  | "CORRECTED";

export type OrderDirection = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

export interface OrderListItem {
  id: number;
  createdAt: string;
  pair: string;
  type: OrderType;
  direction: OrderDirection;
  price: string;
  amount: string;
  percentFilled: string;
  status: OrderStatus;
  total: string;
  hcsInitialTransactionId: string | null;
  nonce: string;
  /** Order deadline as a Unix timestamp in seconds, decimal string. */
  deadline: string;
  /** Partner order id if part of an OCO pair, else null. */
  ocoLinkedOrderId: number | null;
}

export interface PaginatedOrdersResult {
  orders: OrderListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface GetOrdersQuery {
  page?: number;
  limit?: number;
  sort?: "asc" | "desc";
  /** Comma-separated OrderStatus values, e.g. "ACTIVE,PARTIAL_FILLED" */
  statusFilter?: string;
  directionFilter?: OrderDirection;
  typeFilter?: OrderType;
  orderbookId?: number;
  /** Unix milliseconds (inclusive lower bound on createdAt) */
  startTimestamp?: number;
  /** Unix milliseconds (inclusive upper bound on createdAt) */
  endTimestamp?: number;
}

// ---------------------------------------------------------------------------
// Order build / sign / save
// ---------------------------------------------------------------------------

export interface OrderRequestInput {
  orderbookId: string;
  type: OrderType;
  /** Unix seconds as a decimal string. REQUIRED for LIMIT; MUST be omitted for MARKET. */
  deadline?: string;
  inputToken: string;
  /** Raw token units — uint256 as a decimal string. Never a JS number. */
  inputAmount: string;
  outputToken: string;
  /** Raw token units — uint256 as a decimal string. Never a JS number. */
  outputAmount: string;
  recipient?: string;
  makerOnly?: boolean;
  takerOnce?: boolean;
  isAMMEnabled?: boolean;
}

export interface SerializedOrderInfo {
  reactor: string;
  swapper: string;
  nonce: string;
  deadline: string;
  additionalValidationContract: string;
  additionalValidationData: string;
}

export interface SerializedOrder {
  info: SerializedOrderInfo;
  input: { token: string; amount: string };
  output: { token: string; amount: string; recipient: string };
  makerOnly: boolean;
  takerOnce: boolean;
  maxTakerFeePips: number;
  maxMakerFeePips: number;
  meta?: {
    id?: string;
    orderbookId?: string;
    status?: string;
    orderHash?: string;
    type?: string;
    filledAmount?: string;
    createdAt?: string;
    updatedAt?: string;
    isAMMEnabled?: boolean;
    hcsInitialTransactionId?: string | null;
  };
}

export interface SaveOrderItem {
  order: SerializedOrder;
  signature: string;
  orderbookId: string;
  type: OrderType;
}

export interface SaveOrdersResponse {
  orders: SerializedOrder[];
}

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

// ---------------------------------------------------------------------------
// Cancel (asynchronous — 202 / status PENDING)
// ---------------------------------------------------------------------------

export interface CancelOrdersResponse {
  status: "PENDING";
  message: string;
  accepted: number[];
  skipped: { orderId: number; reason: "NOT_FOUND" | "ALREADY_TERMINAL" }[];
}

export interface EmergencyCancelResponse {
  status: "PENDING";
  message: string;
  nonceFloor: string;
  accepted: number[];
}
