import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMode, Context } from "@hashgraph/hedera-agent-kit";
import { Client } from "@hiero-ledger/sdk";
import { version } from "../package.json";
import {
  saucerSwapPlugin,
  saucerSwapPluginToolNames,
  SaucerSwapTokenRegistry,
  AmbiguousTokenError,
} from "../src/index";
import { SaucerSwapApiServiceImpl } from "../src/service/saucer-swap-rest-pools-service";
import { SaucerSwapV2ConfigService } from "../src/service/saucer-swap-v2-config-service";
import { clearOrderbookSessionCaches } from "../src/service/orderbook-api-service";
import { MockOrderbookServer, sampleOrderbookItem } from "./helpers/mock-orderbook-server";

const context: Context = { mode: AgentMode.RETURN_BYTES };

describe("combined V2 discovery and V3 plugin", () => {
  let client: Client;
  let server: MockOrderbookServer;

  beforeEach(() => {
    client = Client.forTestnet({ scheduleNetworkUpdate: false });
    clearOrderbookSessionCaches();
    server = new MockOrderbookServer().install();
    vi.spyOn(SaucerSwapV2ConfigService.prototype, "getSaucerSwapApiKey").mockReturnValue("fixture-key");
  });

  afterEach(() => {
    server.uninstall();
    vi.restoreAllMocks();
    client.close();
  });

  it("exposes both tool sets and keeps the published library exports", () => {
    const tools = saucerSwapPlugin.tools(context);
    const names = tools.map(tool => tool.method);
    expect(names).toHaveLength(12);
    expect(new Set(names).size).toBe(12);
    expect(names).toEqual(expect.arrayContaining(Object.values(saucerSwapPluginToolNames)));
    expect(saucerSwapPlugin.version).toBe(version);
    expect(SaucerSwapTokenRegistry).toBeTypeOf("function");
    expect(new AmbiguousTokenError("USDC", ["0.0.1", "0.0.2"]).code).toBe("AMBIGUOUS_TOKEN");
  });

  it("resolves native HBAR and reads V3 markets through the same unsigned plugin instance", async () => {
    const token = (id: string, symbol: string, decimals: number) => ({
      id, symbol, name: symbol, decimals, priceUsd: 1, price: "0", icon: "",
      dueDiligenceComplete: false, isFeeOnTransferToken: false,
    });
    vi.spyOn(SaucerSwapApiServiceImpl.prototype, "getAllPoolsCompact").mockResolvedValue([{
      id: 1, contractId: "0.0.900001",
      tokenA: token("0.0.15058", "HBAR", 8), amountA: "10000000000",
      tokenB: token("0.0.5449", "USDC", 6), amountB: "100000000",
      fee: 3000, sqrtRatioX96: "0", tickCurrent: 0, liquidity: "0",
    }]);
    server.on("GET", "/books", () => ({
      status: 200,
      body: { orderbooks: [sampleOrderbookItem], page: 1, limit: 20, total: 1 },
    }));

    const tools = saucerSwapPlugin.tools(context);
    const discovery = tools.find(tool => tool.method === "find_saucerswap_token_tool")!;
    const markets = tools.find(tool => tool.method === "get_orderbooks_v3_tool")!;
    const tokenResult = await discovery.execute(client, context, { query: "HBAR" });
    expect(tokenResult.raw.token.id).toBe("0.0.15058");
    expect(tokenResult.raw.routes[0].token.id).toBe("0.0.5449");

    const marketResult = await markets.execute(client, context, {});
    expect(marketResult.raw.orderbooks[0].id).toBe(sampleOrderbookItem.id);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].headers.authorization).toBeUndefined();
    expect(client.operatorAccountId).toBeNull();
  });
});
