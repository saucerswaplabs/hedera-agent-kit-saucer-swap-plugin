import { Context } from "@hashgraph/hedera-agent-kit";
import { Client, LedgerId } from "@hiero-ledger/sdk";
import {
  ConfigurationError,
  OrderbookApiError,
  OrderbookAuthError,
} from "../errors";
import {
  CancelOrdersResponse,
  DepthSnapshot,
  EIP712Domain,
  EmergencyCancelResponse,
  ExactInputQuoteResult,
  ExactOutputQuoteResult,
  GetOrderbooksQuery,
  GetOrdersQuery,
  GetTradesQuery,
  OrderRequestInput,
  OrderbookRestNetwork,
  PaginatedOrderbooksResult,
  PaginatedOrdersResult,
  RecentTradesResult,
  SaveOrderItem,
  SaveOrdersResponse,
  SerializedOrder,
} from "./orderbook-api-service.interface";
import { getOperatorSigner, signAuthChallenge } from "./orderbook-signing-service";

/**
 * Service for the SaucerSwap V3 Orderbook API.
 *
 * Follows the plugin's REST-service pattern (see
 * saucer-swap-rest-pools-service.ts): base URL selected from the client's
 * ledger ID; mainnet is the fallback for unsupported ledgers.
 *
 * Auth follows the reference client
 * (saucerswap-server/src/scripts/orderbook/api/client.ts):
 * POST /auth/challenge → operator-signed nonce → POST /auth/verify → JWT.
 * JWTs are cached per (baseUrl, accountId) for the session and refreshed
 * automatically on 401. JWTs and signatures are never logged.
 */

const ORDERBOOK_API_BASE_URLS: Record<OrderbookRestNetwork, string> = {
  MAINNET: "https://orderbook-api.saucerswap.finance",
  TESTNET: "https://testnet-orderbook-api.saucerswap.finance",
};

/** JWTs are issued with a 6 hour lifetime; refresh 5 minutes early. */
const JWT_TTL_MS = 6 * 60 * 60 * 1000 - 5 * 60 * 1000;

/** Session-level JWT cache, keyed `${baseUrl}|${accountId}`. Values are never logged. */
const jwtCache = new Map<string, { token: string; expiresAt: number }>();

/** Session-level EIP-712 domain cache, keyed by baseUrl (environment-specific, market-independent). */
const domainCache = new Map<string, EIP712Domain>();

/** Test/maintenance hook: clear session caches. */
export const clearOrderbookSessionCaches = () => {
  jwtCache.clear();
  domainCache.clear();
};

export class OrderbookApiService {
  private readonly baseUrl: string;

  constructor(ledgerId: LedgerId | null | undefined, baseUrlOverride?: string) {
    if (!ledgerId) {
      throw new ConfigurationError(
        "Orderbook API requires a client with a known ledger ID (mainnet or testnet); custom networks are not supported",
      );
    }
    const network = this.mapLedgerToNetwork(ledgerId);
    this.baseUrl = (baseUrlOverride ?? ORDERBOOK_API_BASE_URLS[network]).replace(/\/$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // -------------------------------------------------------------------------
  // Public market data (no JWT — live on both networks, verified 2026-09-15)
  // -------------------------------------------------------------------------

  /**
   * List orderbook markets. Public (unauthenticated).
   *
   * The server-side `orderbookId` query filter is broken on the live deploy
   * (it 404s "Orderbook not found" for every id, on both networks — observed
   * 2026-09-15), so that one filter is applied CLIENT-side: the listing is
   * fetched (single page, max 100 markets) and narrowed locally. All other
   * filters are passed through to the server.
   */
  async getOrderbooks(query: GetOrderbooksQuery = {}): Promise<PaginatedOrderbooksResult> {
    const params = new URLSearchParams();
    if (query.orderbookId === undefined) {
      if (query.page !== undefined) params.set("page", String(query.page));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
    } else {
      // Client-side id filter: pull the largest single page the API allows.
      params.set("page", "1");
      params.set("limit", "100");
    }
    if (query.tokenId !== undefined) params.set("tokenId", query.tokenId);
    if (query.symbol !== undefined) params.set("symbol", query.symbol);
    if (query.status !== undefined) params.set("status", query.status);
    const qs = params.toString();
    const result = await this.rawRequest<PaginatedOrderbooksResult>(
      "GET",
      `/books${qs ? `?${qs}` : ""}`,
    );
    if (query.orderbookId === undefined) return result;
    const wanted = String(query.orderbookId);
    const matches = result.orderbooks.filter((b) => String(b.id) === wanted);
    return { orderbooks: matches, total: matches.length, page: 1, limit: result.limit };
  }

  /**
   * Depth snapshot. Public (unauthenticated). A JSON 404 ("not found or not
   * open") is a real missing/closed-orderbook error and is surfaced as-is.
   */
  async getDepth(orderbookId: string): Promise<DepthSnapshot> {
    return this.rawRequest<DepthSnapshot>("GET", `/depth/${encodeURIComponent(orderbookId)}`);
  }

  /** Public trade tape. Public (unauthenticated). */
  async getTrades(orderbookId: string, query: GetTradesQuery = {}): Promise<RecentTradesResult> {
    const params = new URLSearchParams();
    if (query.sort !== undefined) params.set("sort", query.sort);
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.rawRequest<RecentTradesResult>(
      "GET",
      `/trades/${encodeURIComponent(orderbookId)}${qs ? `?${qs}` : ""}`,
    );
  }

  /** Exact-input market-order quote. Public (unauthenticated). */
  async getQuoteExactInput(
    orderbookId: string,
    inputToken: string,
    inputAmount: string,
  ): Promise<ExactInputQuoteResult> {
    const params = new URLSearchParams({ inputToken, inputAmount });
    return this.rawRequest<ExactInputQuoteResult>(
      "GET",
      `/books/${encodeURIComponent(orderbookId)}/quote/exact-input?${params.toString()}`,
    );
  }

  /** Exact-output market-order quote. Public (unauthenticated). */
  async getQuoteExactOutput(
    orderbookId: string,
    outputToken: string,
    outputAmount: string,
  ): Promise<ExactOutputQuoteResult> {
    const params = new URLSearchParams({ outputToken, outputAmount });
    return this.rawRequest<ExactOutputQuoteResult>(
      "GET",
      `/books/${encodeURIComponent(orderbookId)}/quote/exact-output?${params.toString()}`,
    );
  }

  // -------------------------------------------------------------------------
  // Authenticated endpoints (live today)
  // -------------------------------------------------------------------------

  async getOrders(client: Client, context: Context, query: GetOrdersQuery = {}): Promise<PaginatedOrdersResult> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.sort !== undefined) params.set("sort", query.sort);
    if (query.statusFilter !== undefined) params.set("statusFilter", query.statusFilter);
    if (query.directionFilter !== undefined) params.set("directionFilter", query.directionFilter);
    if (query.typeFilter !== undefined) params.set("typeFilter", query.typeFilter);
    if (query.orderbookId !== undefined) params.set("orderbookId", String(query.orderbookId));
    if (query.startTimestamp !== undefined) params.set("startTimestamp", String(query.startTimestamp));
    if (query.endTimestamp !== undefined) params.set("endTimestamp", String(query.endTimestamp));
    const qs = params.toString();
    return this.authedRequest<PaginatedOrdersResult>(client, context, "GET", `/orders${qs ? `?${qs}` : ""}`);
  }

  /**
   * Fetch the EIP-712 domain (cached per environment). GET /signature/domain
   * is public on the live API, but the trading flow has already
   * authenticated by the time the domain is needed, so the session JWT is
   * sent along (harmless on a public endpoint).
   */
  async getDomain(client: Client, context: Context): Promise<EIP712Domain> {
    const cached = domainCache.get(this.baseUrl);
    if (cached) return cached;
    const domain = await this.authedRequest<EIP712Domain>(client, context, "GET", "/signature/domain");
    domainCache.set(this.baseUrl, domain);
    return domain;
  }

  /** Build unsigned orders with server-assigned nonces. All uint256 values stay strings. */
  async buildOrders(
    client: Client,
    context: Context,
    orderRequests: OrderRequestInput[],
  ): Promise<SerializedOrder[]> {
    const result = await this.authedRequest<{ orders: SerializedOrder[] }>(
      client,
      context,
      "POST",
      "/orders/build",
      { orderRequests },
    );
    return result.orders;
  }

  /** Save signed orders to be stored and published to the matching engine. */
  async saveOrders(client: Client, context: Context, items: SaveOrderItem[]): Promise<SaveOrdersResponse> {
    return this.authedRequest<SaveOrdersResponse>(client, context, "POST", "/orders/save", { items });
  }

  /** Request async cancellation of specific orders (HTTP 202 — NOT final). */
  async cancel(client: Client, context: Context, orderIds: number[]): Promise<CancelOrdersResponse> {
    return this.authedRequest<CancelOrdersResponse>(client, context, "POST", "/cancel", { orderIds });
  }

  /** Request async emergency cancellation of all live orders with nonce < nonceFloor. */
  async cancelAll(client: Client, context: Context, nonceFloor: string): Promise<EmergencyCancelResponse> {
    return this.authedRequest<EmergencyCancelResponse>(client, context, "POST", "/cancel/all", { nonceFloor });
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * Ensure a valid session JWT for the client's operator account.
   * challenge → operator-sign → verify, cached until shortly before expiry.
   */
  private async ensureAuthenticated(client: Client, context: Context, forceRefresh = false): Promise<string> {
    const signer = getOperatorSigner(client, context);
    const cacheKey = `${this.baseUrl}|${signer.accountId}`;

    if (!forceRefresh) {
      const cached = jwtCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.token;
    }
    jwtCache.delete(cacheKey);

    const challenge = await this.rawRequest<{ message: string }>("POST", "/auth/challenge", {
      accountId: signer.accountId,
    });
    if (!challenge?.message) {
      throw new OrderbookAuthError("challenge response did not include a message to sign");
    }
    const signature = await signAuthChallenge(signer, challenge.message);
    const verify = await this.rawRequest<{ token: string }>("POST", "/auth/verify", {
      accountId: signer.accountId,
      signature,
    });
    if (!verify?.token) {
      throw new OrderbookAuthError("verify response did not include a token");
    }
    jwtCache.set(cacheKey, { token: verify.token, expiresAt: Date.now() + JWT_TTL_MS });
    return verify.token;
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  /** Authenticated request with a single automatic re-auth + retry on 401. */
  private async authedRequest<T>(
    client: Client,
    context: Context,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.ensureAuthenticated(client, context);
    try {
      return await this.rawRequest<T>(method, path, body, token);
    } catch (error) {
      if (error instanceof OrderbookApiError && error.statusCode === 401) {
        const freshToken = await this.ensureAuthenticated(client, context, true);
        return await this.rawRequest<T>(method, path, body, freshToken);
      }
      throw error;
    }
  }

  private async rawRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (method === "POST") headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      let hasJsonErrorBody = false;
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        const serverMessage = parsed.error ?? parsed.message;
        if (serverMessage) {
          message = `HTTP ${response.status}: ${serverMessage}`;
          hasJsonErrorBody = true;
        }
      } catch {
        // Non-JSON body (e.g. an HTML 404 page) — keep the bare status message.
      }
      const error = new OrderbookApiError(message, response.status);
      error.hasJsonErrorBody = hasJsonErrorBody;
      throw error;
    }
    return JSON.parse(text) as T;
  }

  private mapLedgerToNetwork(ledgerId: LedgerId): OrderbookRestNetwork {
    switch (ledgerId.toString()) {
      case LedgerId.MAINNET.toString():
        return "MAINNET";
      case LedgerId.TESTNET.toString():
        return "TESTNET";
      default:
        // Fallback to MAINNET base URL if an unsupported ledger is used.
        return "MAINNET";
    }
  }
}
