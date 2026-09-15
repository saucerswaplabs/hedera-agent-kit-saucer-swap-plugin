import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMode, Context } from "@hashgraph/hedera-agent-kit";
import { Client } from "@hiero-ledger/sdk";
import getOrderbooksV3Tool from "../src/tools/get-orderbooks-v3";
import getOrderbookDepthV3Tool from "../src/tools/get-orderbook-depth-v3";
import getOrderbookTradesV3Tool from "../src/tools/get-orderbook-trades-v3";
import getOrderbookQuoteV3Tool from "../src/tools/get-orderbook-quote-v3";
import { clearOrderbookSessionCaches } from "../src/service/orderbook-api-service";
import { MockOrderbookServer, sampleOrderbookItem } from "./helpers/mock-orderbook-server";

const context: Context = { mode: AgentMode.AUTONOMOUS };

const TESTNET_BASE = "https://testnet-orderbook-api.saucerswap.finance";
const MAINNET_BASE = "https://orderbook-api.saucerswap.finance";

describe("V3 orderbook public read tools", () => {
  let server: MockOrderbookServer;
  let client: Client;

  beforeEach(() => {
    clearOrderbookSessionCaches();
    server = new MockOrderbookServer().install();
    client = Client.forTestnet({ scheduleNetworkUpdate: false });
  });

  afterEach(() => {
    server.uninstall();
    client.close();
  });

  describe("get_orderbooks_v3_tool", () => {
    it("lists orderbooks without authentication (happy path)", async () => {
      server.on("GET", "/books", () => ({
        status: 200,
        body: { orderbooks: [sampleOrderbookItem], total: 1, page: 1, limit: 20 },
      }));

      const result = await getOrderbooksV3Tool(context).execute(client, context, { status: "OPEN" });

      expect(result.raw.total).toBe(1);
      expect(result.raw.orderbooks[0].tickStep).toBe("0.0001");
      expect(result.raw.orderbooks[0].lotSize).toBe("100");
      expect(result.humanMessage).toContain("SAUCE/USDC");

      const call = server.callsTo("GET", "/books")[0];
      expect(call.url).toBe(`${TESTNET_BASE}/books?status=OPEN`);
      expect(call.headers["authorization"]).toBeUndefined();
    });

    it("targets the mainnet base URL on a mainnet client", async () => {
      const mainnetClient = Client.forMainnet({ scheduleNetworkUpdate: false });
      server.on("GET", "/books", () => ({
        status: 200,
        body: { orderbooks: [], total: 0, page: 1, limit: 20 },
      }));

      await getOrderbooksV3Tool(context).execute(mainnetClient, context, {});
      expect(server.calls[0].url).toBe(`${MAINNET_BASE}/books`);
      mainnetClient.close();
    });

    it("surfaces an unexpected 401 as a plain orderbook API error", async () => {
      server.on("GET", "/books", () => ({ status: 401, body: { error: "Unauthorized" } }));

      const result = await getOrderbooksV3Tool(context).execute(client, context, {});
      expect(result.humanMessage).toContain("HTTP 401: Unauthorized");
      expect(result.humanMessage).not.toContain("PR #1292");
    });

    it("applies the orderbookId filter client-side (live server-side filter is broken)", async () => {
      server.on("GET", "/books", () => ({
        status: 200,
        body: {
          orderbooks: [sampleOrderbookItem, { ...sampleOrderbookItem, id: "4", baseTokenSymbol: "WBTC" }],
          total: 2,
          page: 1,
          limit: 100,
        },
      }));

      const result = await getOrderbooksV3Tool(context).execute(client, context, { orderbookId: 4 });

      expect(result.raw.total).toBe(1);
      expect(result.raw.orderbooks).toHaveLength(1);
      expect(result.raw.orderbooks[0].id).toBe("4");
      // The broken server-side filter must NOT be sent.
      const call = server.callsTo("GET", "/books")[0];
      expect(call.url).not.toContain("orderbookId");
      expect(call.url).toContain("limit=100");
    });
  });

  describe("get_orderbook_depth_v3_tool", () => {
    it("returns the snapshot with lastUpdateId and string tuples", async () => {
      server.on("GET", "/depth/3", () => ({
        status: 200,
        body: {
          orderbookId: "3",
          timestamp: 1767225600000,
          baseTokenId: "0.0.1183558",
          quoteTokenId: "0.0.456858",
          bestBidQuote: "0.0164",
          bestAskQuote: "0.0166",
          spreadPercent: "1.212",
          asks: [["0.0166", "1000"]],
          bids: [["0.0164", "2000"]],
          lastUpdateId: 987,
        },
      }));

      const result = await getOrderbookDepthV3Tool(context).execute(client, context, { orderbookId: "3" });

      expect(result.raw.lastUpdateId).toBe(987);
      expect(result.raw.asks[0]).toEqual(["0.0166", "1000"]);
      expect(result.humanMessage).toContain("lastUpdateId 987");
    });

    it("surfaces a real JSON 404 (unknown orderbook) as-is, not as pending-deploy", async () => {
      server.on("GET", "/depth/999", () => ({
        status: 404,
        body: { error: "orderbook 999 not found" },
      }));

      const result = await getOrderbookDepthV3Tool(context).execute(client, context, { orderbookId: "999" });
      expect(result.humanMessage).toContain("orderbook 999 not found");
      expect(result.humanMessage).not.toContain("PR #1292");
    });

    it("surfaces a route-level (non-JSON) 404 as a plain HTTP error", async () => {
      server.on("GET", "/depth/3", () => ({
        status: 404,
        body: null,
        rawBody: "<html>Cannot GET /depth/3</html>",
      }));

      const result = await getOrderbookDepthV3Tool(context).execute(client, context, { orderbookId: "3" });
      expect(result.humanMessage).toContain("HTTP 404");
      expect(result.humanMessage).not.toContain("PR #1292");
    });
  });

  describe("get_orderbook_trades_v3_tool", () => {
    it("fetches the trade tape with human-readable amounts", async () => {
      server.on("GET", "/trades/3", () => ({
        status: 200,
        body: {
          orderbookId: "3",
          timestamp: 1767225600000,
          trades: [
            {
              timestamp: 1767225599000,
              price: "0.0165",
              amountBase: "150.5",
              direction: "buy",
              transactionHash: "0xdeadbeef",
            },
          ],
          total: 1,
          page: 1,
          limit: 50,
        },
      }));

      const result = await getOrderbookTradesV3Tool(context).execute(client, context, {
        orderbookId: "3",
        sort: "desc",
        page: 1,
        limit: 50,
      });

      expect(result.raw.trades[0].amountBase).toBe("150.5");
      expect(result.raw.trades[0].direction).toBe("buy");
      const call = server.callsTo("GET", "/trades/3")[0];
      expect(call.url).toBe(`${TESTNET_BASE}/trades/3?sort=desc&page=1&limit=50`);
      expect(call.headers["authorization"]).toBeUndefined();
    });

    it("surfaces the server 400 for a negative page", async () => {
      server.on("GET", "/trades/3", () => ({
        status: 400,
        body: { error: "page must be a positive integer" },
      }));

      const result = await getOrderbookTradesV3Tool(context).execute(client, context, {
        orderbookId: "3",
        page: -1,
      });
      expect(result.humanMessage).toContain("page must be a positive integer");
    });

    it("surfaces an unexpected 401 as a plain orderbook API error", async () => {
      server.on("GET", "/trades/3", () => ({ status: 401, body: { error: "Unauthorized" } }));

      const result = await getOrderbookTradesV3Tool(context).execute(client, context, { orderbookId: "3" });
      expect(result.humanMessage).toContain("HTTP 401: Unauthorized");
      expect(result.humanMessage).not.toContain("PR #1292");
    });
  });

  describe("get_orderbook_quote_v3_tool", () => {
    it("fetches an exact-input quote and explains the build mapping", async () => {
      // NOTE: no consumedInputAmount in this mock — the live API emits it
      // (verified 2026-09-15) but the tool must stay tolerant of older
      // deployments that omit it.
      server.on("GET", "/books/3/quote/exact-input", () => ({
        status: 200,
        body: {
          outputToken: "0x000000000000000000000000000000000006f89a",
          snappedInputAmount: "999900",
          expectedOutputAmount: "16500",
          suggestedOutputAmount: "16335",
          slippageBps: 100,
          fillable: true,
        },
      }));

      const result = await getOrderbookQuoteV3Tool(context).execute(client, context, {
        orderbookId: "3",
        quoteType: "exactInput",
        inputToken: "0x0000000000000000000000000000000000120f46",
        inputAmount: "1000000",
      });

      expect(result.raw.snappedInputAmount).toBe("999900");
      expect(result.raw.fillable).toBe(true);
      expect(result.humanMessage).toContain("inputAmount=999900");
      expect(result.humanMessage).toContain("outputAmount=16335");
      expect(result.humanMessage).toContain("not market impact");
      expect(result.humanMessage).not.toContain("undefined");

      const call = server.callsTo("GET", "/books/3/quote/exact-input")[0];
      const url = new URL(call.url);
      expect(url.searchParams.get("inputToken")).toBe("0x0000000000000000000000000000000000120f46");
      expect(url.searchParams.get("inputAmount")).toBe("1000000");
    });

    it("includes the absorbed amount when the server emits consumedInputAmount (live behavior)", async () => {
      server.on("GET", "/books/3/quote/exact-input", () => ({
        status: 200,
        body: {
          outputToken: "0x000000000000000000000000000000000006f89a",
          snappedInputAmount: "1000000",
          consumedInputAmount: "1000000",
          expectedOutputAmount: "998901",
          suggestedOutputAmount: "800000",
          slippageBps: 500,
          fillable: true,
        },
      }));

      const result = await getOrderbookQuoteV3Tool(context).execute(client, context, {
        orderbookId: "3",
        quoteType: "exactInput",
        inputToken: "0x000000000000000000000000000000000006f89a",
        inputAmount: "1000000",
      });

      expect(result.raw.consumedInputAmount).toBe("1000000");
      expect(result.humanMessage).toContain("book absorbs 1000000");
    });

    it("fetches an exact-output quote", async () => {
      server.on("GET", "/books/3/quote/exact-output", () => ({
        status: 200,
        body: {
          inputToken: "0x0000000000000000000000000000000000120f46",
          requestedOutputAmount: "16500",
          snappedOutputAmount: "16500",
          expectedInputAmount: "1000000",
          suggestedInputAmount: "1010000",
          slippageBps: 100,
          fillable: true,
        },
      }));

      const result = await getOrderbookQuoteV3Tool(context).execute(client, context, {
        orderbookId: "3",
        quoteType: "exactOutput",
        outputToken: "0x000000000000000000000000000000000006f89a",
        outputAmount: "16500",
      });

      expect(result.raw.suggestedInputAmount).toBe("1010000");
      expect(result.humanMessage).toContain("inputAmount=1010000");
      expect(result.humanMessage).toContain("outputAmount=16500");
    });

    it("rejects an exactInput quote missing inputToken/inputAmount", async () => {
      const result = await getOrderbookQuoteV3Tool(context).execute(client, context, {
        orderbookId: "3",
        quoteType: "exactInput",
      });
      expect(result.humanMessage).toContain("exactInput quotes require inputToken and inputAmount");
    });

    it("surfaces a route-level 404 on the quote route as a plain HTTP error", async () => {
      server.on("GET", "/books/3/quote/exact-input", () => ({
        status: 404,
        body: null,
        rawBody: "Cannot GET /books/3/quote/exact-input",
      }));

      const result = await getOrderbookQuoteV3Tool(context).execute(client, context, {
        orderbookId: "3",
        quoteType: "exactInput",
        inputToken: "0x0000000000000000000000000000000000120f46",
        inputAmount: "1000000",
      });
      expect(result.humanMessage).toContain("HTTP 404");
      expect(result.humanMessage).not.toContain("PR #1292");
    });
  });
});
