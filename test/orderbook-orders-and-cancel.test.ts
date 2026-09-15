import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMode, Context } from "@hashgraph/hedera-agent-kit";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import cancelOrderbookOrdersV3Tool from "../src/tools/cancel-orderbook-orders-v3";
import getMyOrderbookOrdersV3Tool from "../src/tools/get-my-orderbook-orders-v3";
import { clearOrderbookSessionCaches } from "../src/service/orderbook-api-service";
import { MockOrderbookServer } from "./helpers/mock-orderbook-server";

const context: Context = { mode: AgentMode.AUTONOMOUS };
const OPERATOR_ID = "0.0.12345";

const installAuthRoutes = (server: MockOrderbookServer) =>
  server
    .on("POST", "/auth/challenge", () => ({ status: 200, body: { message: "nonce-to-sign" } }))
    .on("POST", "/auth/verify", () => ({ status: 200, body: { token: "test-jwt-token" } }));

describe("V3 orderbook order management tools", () => {
  let server: MockOrderbookServer;
  let client: Client;

  beforeEach(() => {
    clearOrderbookSessionCaches();
    server = new MockOrderbookServer().install();
    client = Client.forTestnet({ scheduleNetworkUpdate: false }).setOperator(
      OPERATOR_ID,
      PrivateKey.generateED25519(),
    );
  });

  afterEach(() => {
    server.uninstall();
    client.close();
  });

  describe("cancel_orderbook_orders_v3_tool", () => {
    it("cancels by id and reports the async PENDING semantics", async () => {
      installAuthRoutes(server).on("POST", "/cancel", () => ({
        status: 202,
        body: {
          status: "PENDING",
          message: "forwarded to order-core",
          accepted: [123],
          skipped: [{ orderId: 456, reason: "ALREADY_TERMINAL" }],
        },
      }));

      const result = await cancelOrderbookOrdersV3Tool(context).execute(client, context, {
        orderIds: [123, 456],
      });

      expect(server.callsTo("POST", "/cancel")[0].body).toEqual({ orderIds: [123, 456] });
      expect(server.callsTo("POST", "/cancel")[0].headers["authorization"]).toBe("Bearer test-jwt-token");
      expect(result.raw.status).toBe("PENDING");
      expect(result.humanMessage).toContain("accepted means forwarded, not final");
      expect(result.humanMessage).toContain("456 (ALREADY_TERMINAL)");
    });

    it("runs the nonce-floor cancel-all variant with the floor as a string", async () => {
      installAuthRoutes(server).on("POST", "/cancel/all", () => ({
        status: 202,
        body: {
          status: "PENDING",
          message: "forwarded",
          nonceFloor: "340282366920938463463374607431768211457",
          accepted: [1, 2, 3],
        },
      }));

      const result = await cancelOrderbookOrdersV3Tool(context).execute(client, context, {
        nonceFloor: "340282366920938463463374607431768211457",
      });

      const call = server.callsTo("POST", "/cancel/all")[0];
      expect(call.body).toEqual({ nonceFloor: "340282366920938463463374607431768211457" });
      expect(typeof (call.body as { nonceFloor: unknown }).nonceFloor).toBe("string");
      expect(result.humanMessage).toContain("not final");
    });

    it("rejects more than 500 order ids client-side", async () => {
      const orderIds = Array.from({ length: 501 }, (_, i) => i + 1);
      const result = await cancelOrderbookOrdersV3Tool(context).execute(client, context, { orderIds });
      expect(result.humanMessage).toContain("max 500");
      expect(server.calls.length).toBe(0);
    });

    it("requires exactly one of orderIds or nonceFloor", async () => {
      const tool = cancelOrderbookOrdersV3Tool(context);

      const neither = await tool.execute(client, context, {});
      expect(neither.humanMessage).toContain("exactly one of orderIds or nonceFloor");

      const both = await tool.execute(client, context, { orderIds: [1], nonceFloor: "10" });
      expect(both.humanMessage).toContain("exactly one of orderIds or nonceFloor");
      expect(server.calls.length).toBe(0);
    });

    it("marks itself as a write tool in the description", () => {
      const tool = cancelOrderbookOrdersV3Tool(context);
      expect(tool.description).toContain("WRITE TOOL");
      expect(tool.description).toContain("explicit user opt-in");
    });
  });

  describe("get_my_orderbook_orders_v3_tool", () => {
    it("lists the operator's orders with filters and a session JWT", async () => {
      installAuthRoutes(server).on("GET", "/orders", () => ({
        status: 200,
        body: {
          orders: [
            {
              id: 42,
              createdAt: "2026-01-01T00:00:00.000Z",
              pair: "SAUCE/USDC",
              type: "LIMIT",
              direction: "BUY",
              price: "0.0165",
              amount: "1000",
              percentFilled: "50",
              status: "PARTIAL_FILLED",
              total: "16.5",
              hcsInitialTransactionId: null,
              nonce: "340282366920938463463374607431768211457",
              deadline: "1893456000",
              ocoLinkedOrderId: null,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
        },
      }));

      const result = await getMyOrderbookOrdersV3Tool(context).execute(client, context, {
        statusFilter: "ACTIVE,PARTIAL_FILLED",
        orderbookId: 3,
        sort: "desc",
      });

      const call = server.callsTo("GET", "/orders")[0];
      const url = new URL(call.url);
      expect(url.searchParams.get("statusFilter")).toBe("ACTIVE,PARTIAL_FILLED");
      expect(url.searchParams.get("orderbookId")).toBe("3");
      expect(url.searchParams.get("sort")).toBe("desc");
      expect(call.headers["authorization"]).toBe("Bearer test-jwt-token");

      expect(result.raw.orders[0].nonce).toBe("340282366920938463463374607431768211457");
      expect(result.humanMessage).toContain("#42 SAUCE/USDC BUY LIMIT");
      expect(result.humanMessage).toContain("50% filled");
    });

    it("re-authenticates once on 401 and retries", async () => {
      let ordersAttempts = 0;
      installAuthRoutes(server).on("GET", "/orders", () => {
        ordersAttempts += 1;
        if (ordersAttempts === 1) return { status: 401, body: { error: "jwt expired" } };
        return { status: 200, body: { orders: [], total: 0, page: 1, limit: 20 } };
      });

      const result = await getMyOrderbookOrdersV3Tool(context).execute(client, context, {});
      expect(result.raw.total).toBe(0);
      expect(ordersAttempts).toBe(2);
      expect(server.callsTo("POST", "/auth/challenge").length).toBe(2);
    });

    it("refuses to run in RETURN_BYTES mode with a clear error", async () => {
      const returnBytesContext: Context = { mode: AgentMode.RETURN_BYTES, accountId: OPERATOR_ID };
      const result = await getMyOrderbookOrdersV3Tool(returnBytesContext).execute(
        client,
        returnBytesContext,
        {},
      );
      expect(result.humanMessage).toContain("RETURN_BYTES mode is not supported");
    });
  });
});
