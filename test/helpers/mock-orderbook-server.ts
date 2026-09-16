import { vi } from "vitest";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (call: RecordedCall) => { status: number; body: unknown; rawBody?: string };

/**
 * Minimal fetch mock for orderbook API tests. Routes are matched by
 * "<METHOD> <path>" prefix (query string ignored for matching but preserved
 * on the recorded call). All calls are recorded for assertions.
 */
export class MockOrderbookServer {
  calls: RecordedCall[] = [];
  private routes = new Map<string, RouteHandler>();

  on(method: string, path: string, handler: RouteHandler) {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
    return this;
  }

  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method === method.toUpperCase() && new URL(c.url).pathname === path,
    );
  }

  install() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: globalThis.RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const call: RecordedCall = { url, method, headers, body };
        this.calls.push(call);

        const pathname = new URL(url).pathname;
        const handler = this.routes.get(`${method} ${pathname}`);
        if (!handler) {
          return new Response(JSON.stringify({ error: `no mock route for ${method} ${pathname}` }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const result = handler(call);
        const responseBody = result.rawBody ?? JSON.stringify(result.body);
        return new Response(responseBody, {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return this;
  }

  uninstall() {
    vi.unstubAllGlobals();
  }
}

export const sampleOrderbookItem = {
  // Live API serializes id as a decimal string and booleans as 0/1.
  id: "3",
  baseTokenId: "0.0.1183558",
  quoteTokenId: "0.0.456858",
  baseTokenEvmAddress: "0x0000000000000000000000000000000000120f46",
  quoteTokenEvmAddress: "0x000000000000000000000000000000000006f89a",
  status: "OPEN",
  isAMMEnabled: 1,
  isMarketHalted: 0,
  baseTokenSymbol: "SAUCE",
  quoteTokenSymbol: "USDC",
  baseTokenDecimals: 6,
  quoteTokenDecimals: 6,
  quotePrice: "0.0165",
  quotePrice24hPct: "1.2",
  quotePrice24hHigh: "0.017",
  quotePrice24hLow: "0.016",
  baseVol24h: "1000",
  quoteVol24h: "16.5",
  tickStep: "0.0001",
  sizeStep: "1",
  lotSize: "100",
  minNotional: "1000000",
  takerFeePips: 2000,
  makerFeePips: 2000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A nonce larger than 2^128 — silently corrupts if ever cast to a JS number. */
export const HUGE_NONCE = "340282366920938463463374607431768211457";

export const sampleBuiltOrder = (overrides: Record<string, unknown> = {}) => ({
  info: {
    reactor: "0x1111111111111111111111111111111111111111",
    swapper: "0x2222222222222222222222222222222222222222",
    nonce: HUGE_NONCE,
    deadline: "1893456000",
    additionalValidationContract: "0x0000000000000000000000000000000000000000",
    additionalValidationData: "0x",
  },
  input: { token: "0x0000000000000000000000000000000000120f46", amount: "1000000" },
  output: {
    token: "0x000000000000000000000000000000000006f89a",
    amount: "16500",
    recipient: "0x2222222222222222222222222222222222222222",
  },
  makerOnly: false,
  takerOnce: false,
  maxTakerFeePips: 1500,
  maxMakerFeePips: 500,
  meta: {
    id: "42",
    orderbookId: "3",
    status: "PENDING",
    orderHash: "0xabc",
    type: "LIMIT",
  },
  ...overrides,
});

export const sampleDomain = {
  name: "PartialFillLimitOrderReactor",
  version: "1",
  chainId: 296,
  verifyingContract: "0x3333333333333333333333333333333333333333",
};
