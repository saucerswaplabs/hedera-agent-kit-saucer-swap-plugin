import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMode, Context } from "@hashgraph/hedera-agent-kit";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { ethers } from "ethers";
import placeOrderbookOrderV3Tool from "../src/tools/place-orderbook-order-v3";
import { clearOrderbookSessionCaches } from "../src/service/orderbook-api-service";
import { EIP712_ORDER_TYPES } from "../src/service/orderbook-signing-service";
import {
  HUGE_NONCE,
  MockOrderbookServer,
  RecordedCall,
  sampleBuiltOrder,
  sampleDomain,
} from "./helpers/mock-orderbook-server";

const context: Context = { mode: AgentMode.AUTONOMOUS };
const OPERATOR_ID = "0.0.12345";

const HEDERA_MSG_PREFIX = "\x19Hedera Signed Message:\n";
const CHALLENGE_MESSAGE = "Sign this message to authenticate: nonce-abc-123";

const limitOrderParams = {
  orders: [
    {
      orderbookId: "3",
      type: "LIMIT" as const,
      deadline: "1893456000",
      inputToken: "0x0000000000000000000000000000000000120f46",
      inputAmount: "1000000",
      outputToken: "0x000000000000000000000000000000000006f89a",
      outputAmount: "16500",
    },
  ],
};

/** Wire up the standard happy-path auth + build + save routes. */
const installTradingRoutes = (server: MockOrderbookServer, builtOrder = sampleBuiltOrder()) => {
  server
    .on("POST", "/auth/challenge", () => ({ status: 200, body: { message: CHALLENGE_MESSAGE } }))
    .on("POST", "/auth/verify", () => ({ status: 200, body: { token: "test-jwt-token" } }))
    .on("GET", "/signature/domain", () => ({ status: 200, body: sampleDomain }))
    .on("POST", "/orders/build", () => ({ status: 200, body: { orders: [builtOrder] } }))
    .on("POST", "/orders/save", (call: RecordedCall) => ({
      status: 200,
      body: {
        orders: (call.body as { items: { order: unknown }[] }).items.map((i) => ({
          ...(i.order as Record<string, unknown>),
          meta: { id: "42", orderbookId: "3", status: "ACTIVE", orderHash: "0xabc", type: "LIMIT" },
        })),
      },
    }));
};

const orderStructForSigning = (order: ReturnType<typeof sampleBuiltOrder>) => ({
  info: order.info,
  input: order.input,
  output: order.output,
  makerOnly: order.makerOnly,
  takerOnce: order.takerOnce,
  maxTakerFeePips: order.maxTakerFeePips,
  maxMakerFeePips: order.maxMakerFeePips,
});

describe("place_orderbook_order_v3_tool", () => {
  let server: MockOrderbookServer;
  let client: Client;
  let operatorKey: PrivateKey;

  beforeEach(() => {
    clearOrderbookSessionCaches();
    server = new MockOrderbookServer().install();
    operatorKey = PrivateKey.generateED25519();
    client = Client.forTestnet({ scheduleNetworkUpdate: false }).setOperator(OPERATOR_ID, operatorKey);
  });

  afterEach(() => {
    server.uninstall();
    client.close();
  });

  it("runs the full flow: challenge → sign → verify → domain → build → sign order → save (ED25519)", async () => {
    installTradingRoutes(server);

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);

    expect(result.humanMessage).toContain("Submitted 1 order(s)");
    expect(result.humanMessage).toContain("status ACTIVE");
    // The signed economics are surfaced verbatim to the user
    expect(result.humanMessage).toContain("signed to sell 1000000 of 0x0000000000000000000000000000000000120f46");
    expect(result.humanMessage).toContain("min 16500 of 0x000000000000000000000000000000000006f89a");
    expect(result.humanMessage).toContain("recipient 0x2222222222222222222222222222222222222222");
    expect(result.humanMessage).toContain("deadline 1893456000");

    // 1. Challenge sent for the operator account
    const challengeCall = server.callsTo("POST", "/auth/challenge")[0];
    expect(challengeCall.body).toEqual({ accountId: OPERATOR_ID });

    // 2. Challenge signature verifies against the operator key over the
    //    HIP-820 prefixed message, hex-encoded without 0x
    const verifyCall = server.callsTo("POST", "/auth/verify")[0];
    const { signature } = verifyCall.body as { accountId: string; signature: string };
    expect(signature).toMatch(/^[0-9a-f]+$/);
    const prefixed = Buffer.from(HEDERA_MSG_PREFIX + CHALLENGE_MESSAGE.length + CHALLENGE_MESSAGE);
    expect(operatorKey.publicKey.verify(prefixed, Buffer.from(signature, "hex"))).toBe(true);

    // 3. Build request carried the raw params with amounts as strings
    const buildCall = server.callsTo("POST", "/orders/build")[0];
    const buildBody = buildCall.body as { orderRequests: Record<string, unknown>[] };
    expect(buildBody.orderRequests[0].inputAmount).toBe("1000000");
    expect(typeof buildBody.orderRequests[0].deadline).toBe("string");
    expect(buildCall.headers["authorization"]).toBe("Bearer test-jwt-token");

    // 4. Save carried the RETURNED order untouched — uint256s stay strings
    const saveCall = server.callsTo("POST", "/orders/save")[0];
    const saveBody = saveCall.body as {
      items: { order: ReturnType<typeof sampleBuiltOrder>; signature: string; orderbookId: string; type: string }[];
    };
    const item = saveBody.items[0];
    expect(item.order.info.nonce).toBe(HUGE_NONCE);
    expect(typeof item.order.info.deadline).toBe("string");
    expect(typeof item.order.input.amount).toBe("string");
    expect(typeof item.order.output.amount).toBe("string");
    expect(item.orderbookId).toBe("3");
    expect(item.type).toBe("LIMIT");

    // 5. Signature carries the 0x00 EIP-712 mode byte and verifies over the
    //    typed-data hash (meta excluded) with the ED25519 operator key
    expect(item.signature.startsWith("0x00")).toBe(true);
    const hash = ethers.TypedDataEncoder.hash(
      sampleDomain,
      EIP712_ORDER_TYPES,
      orderStructForSigning(sampleBuiltOrder()),
    );
    const innerSig = ethers.getBytes("0x" + item.signature.slice(4));
    expect(innerSig.length).toBe(64);
    expect(operatorKey.publicKey.verify(ethers.getBytes(hash), innerSig)).toBe(true);
  });

  it("produces a recoverable 65-byte EVM signature for an ECDSA operator", async () => {
    const ecdsaKey = PrivateKey.generateECDSA();
    const ecdsaClient = Client.forTestnet({ scheduleNetworkUpdate: false }).setOperator(OPERATOR_ID, ecdsaKey);
    installTradingRoutes(server);

    const result = await placeOrderbookOrderV3Tool(context).execute(ecdsaClient, context, limitOrderParams);
    expect(result.humanMessage).toContain("Submitted 1 order(s)");

    // The ECDSA auth-challenge signature also verifies against the operator key
    const verifyCall = server.callsTo("POST", "/auth/verify")[0];
    const challengeSig = (verifyCall.body as { signature: string }).signature;
    const prefixed = Buffer.from(HEDERA_MSG_PREFIX + CHALLENGE_MESSAGE.length + CHALLENGE_MESSAGE);
    expect(ecdsaKey.publicKey.verify(prefixed, Buffer.from(challengeSig, "hex"))).toBe(true);

    const saveBody = server.callsTo("POST", "/orders/save")[0].body as {
      items: { signature: string }[];
    };
    const signature = saveBody.items[0].signature;
    expect(signature.startsWith("0x00")).toBe(true);

    const innerSig = "0x" + signature.slice(4);
    expect(ethers.getBytes(innerSig).length).toBe(65);

    const hash = ethers.TypedDataEncoder.hash(
      sampleDomain,
      EIP712_ORDER_TYPES,
      orderStructForSigning(sampleBuiltOrder()),
    );
    const expectedAddress = ethers.computeAddress(
      "0x" + Buffer.from(ecdsaKey.publicKey.toBytesRaw()).toString("hex"),
    );
    expect(ethers.recoverAddress(hash, innerSig)).toBe(expectedAddress);
    ecdsaClient.close();
  });

  it("refuses to sign when /orders/build returns a different order count", async () => {
    installTradingRoutes(server);
    server.on("POST", "/orders/build", () => ({
      status: 200,
      body: { orders: [sampleBuiltOrder(), sampleBuiltOrder()] },
    }));

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);

    expect(result.humanMessage).toContain("Refusing to sign");
    expect(result.humanMessage).toContain("returned 2 order(s) for 1 request(s)");
    expect(server.callsTo("POST", "/orders/save").length).toBe(0);
  });

  it("refuses to sign a built order whose economics deviate from the request", async () => {
    installTradingRoutes(server);
    server.on("POST", "/orders/build", () => ({
      status: 200,
      body: {
        orders: [
          sampleBuiltOrder({
            input: { token: "0x0000000000000000000000000000000000120f46", amount: "2000000" },
          }),
        ],
      },
    }));

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);

    expect(result.humanMessage).toContain("Refusing to sign");
    expect(result.humanMessage).toContain("inputAmount requested 1000000 but server returned 2000000");
    expect(server.callsTo("POST", "/orders/save").length).toBe(0);
  });

  it("refuses to sign a built order whose deadline was EXTENDED beyond the request", async () => {
    installTradingRoutes(server);
    server.on("POST", "/orders/build", () => ({
      status: 200,
      body: {
        orders: [
          sampleBuiltOrder({
            info: { ...sampleBuiltOrder().info, deadline: "4102444800" }, // year 2100
          }),
        ],
      },
    }));

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);

    expect(result.humanMessage).toContain("Refusing to sign");
    expect(result.humanMessage).toContain("deadline (extension beyond request)");
    expect(server.callsTo("POST", "/orders/save").length).toBe(0);
  });

  it("accepts a built order whose deadline was clamped DOWN by the server", async () => {
    installTradingRoutes(server);
    server.on("POST", "/orders/build", () => ({
      status: 200,
      body: {
        orders: [
          sampleBuiltOrder({
            info: { ...sampleBuiltOrder().info, deadline: "1893452400" }, // 1h earlier
          }),
        ],
      },
    }));

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);

    expect(result.humanMessage).toContain("Submitted 1 order(s)");
    expect(server.callsTo("POST", "/orders/save").length).toBe(1);
  });

  it("caches the JWT for the session (no second challenge)", async () => {
    installTradingRoutes(server);

    const tool = placeOrderbookOrderV3Tool(context);
    await tool.execute(client, context, limitOrderParams);
    await tool.execute(client, context, limitOrderParams);

    expect(server.callsTo("POST", "/auth/challenge").length).toBe(1);
    expect(server.callsTo("POST", "/orders/save").length).toBe(2);
  });

  it("re-authenticates once and retries when the JWT is rejected with 401", async () => {
    let buildAttempts = 0;
    installTradingRoutes(server);
    server.on("POST", "/orders/build", () => {
      buildAttempts += 1;
      if (buildAttempts === 1) {
        return { status: 401, body: { error: "jwt expired" } };
      }
      return { status: 200, body: { orders: [sampleBuiltOrder()] } };
    });

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);

    expect(result.humanMessage).toContain("Submitted 1 order(s)");
    expect(buildAttempts).toBe(2);
    expect(server.callsTo("POST", "/auth/challenge").length).toBe(2);
  });

  it("rejects batches above the 250-order policy cap client-side", async () => {
    const orders = Array.from({ length: 251 }, () => limitOrderParams.orders[0]);
    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, { orders });
    expect(result.humanMessage).toContain("max 250");
    expect(server.calls.length).toBe(0);
  });

  it("surfaces a server-side batch-cap 400 verbatim", async () => {
    installTradingRoutes(server);
    server.on("POST", "/orders/build", () => ({
      status: 400,
      body: { error: "orderRequests array cannot exceed 250 items" },
    }));

    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, limitOrderParams);
    expect(result.humanMessage).toContain("cannot exceed 250 items");
    expect(result.humanMessage).not.toContain("PR #1292");
  });

  it("rejects MARKET orders that set a deadline", async () => {
    const result = await placeOrderbookOrderV3Tool(context).execute(client, context, {
      orders: [{ ...limitOrderParams.orders[0], type: "MARKET" as const }],
    });
    expect(result.humanMessage).toContain("MARKET orders must not set a deadline");
    expect(server.calls.length).toBe(0);
  });

  it("defaults a LIMIT deadline to ~1 hour out when omitted", async () => {
    installTradingRoutes(server);
    const { deadline: _unused, ...orderWithoutDeadline } = limitOrderParams.orders[0];

    await placeOrderbookOrderV3Tool(context).execute(client, context, { orders: [orderWithoutDeadline] });

    const buildBody = server.callsTo("POST", "/orders/build")[0].body as {
      orderRequests: { deadline: string }[];
    };
    const deadline = Number(buildBody.orderRequests[0].deadline);
    const expected = Math.floor(Date.now() / 1000) + 3600;
    expect(Math.abs(deadline - expected)).toBeLessThan(30);
  });

  it("refuses to run in RETURN_BYTES mode with a clear error", async () => {
    const returnBytesContext: Context = { mode: AgentMode.RETURN_BYTES, accountId: OPERATOR_ID };
    const result = await placeOrderbookOrderV3Tool(returnBytesContext).execute(
      client,
      returnBytesContext,
      limitOrderParams,
    );
    expect(result.humanMessage).toContain("RETURN_BYTES mode is not supported");
    expect(server.calls.length).toBe(0);
  });

  it("marks itself as a write tool in the description", () => {
    const tool = placeOrderbookOrderV3Tool(context);
    expect(tool.description).toContain("WRITE TOOL");
    expect(tool.description).toContain("explicit user opt-in");
  });
});
