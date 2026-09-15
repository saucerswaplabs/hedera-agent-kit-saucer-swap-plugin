import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { Client } from "@hiero-ledger/sdk";
import {
  AccountResolver, AgentMode, Context, handleTransaction, HederaBuilder,
} from "@hashgraph/hedera-agent-kit";
import { SwapV2Tool } from "../src/tools/swap-v2";
import { SaucerSwapV2ConfigService } from "../src/service/saucer-swap-v2-config-service";
import { SaucerSwapApiServiceImpl } from "../src/service/saucer-swap-rest-pools-service";
import { SaucerSwapV2CompactPool } from "../src/service/saucer-swap-rest-pools-service.interface";
import { isTokenAssociated } from "../src/utils/token-association";
import { ensureTokenAllowance } from "../src/utils/token-allowance";
import SwapRouterAbi from "../src/abi/SwapRouter.json";

// No transaction builder, submission handler, allowance or association can sign.
vi.mock("@hashgraph/hedera-agent-kit", async importOriginal => {
  const original = await importOriginal<typeof import("@hashgraph/hedera-agent-kit")>();
  return {
    ...original,
    HederaBuilder: {
      ...original.HederaBuilder,
      executeTransaction: vi.fn(() => ({ fixture: "unsigned-transaction" })),
      associateToken: vi.fn(() => ({ fixture: "unsigned-association" })),
    },
    handleTransaction: vi.fn(),
  };
});
vi.mock("../src/utils/token-association", () => ({ isTokenAssociated: vi.fn(async () => true) }));
vi.mock("../src/utils/token-allowance", () => ({ ensureTokenAllowance: vi.fn(async () => undefined) }));

const context: Context = { mode: AgentMode.RETURN_BYTES, accountId: "0.0.123" };
const recipient = "0x000000000000000000000000000000000000007b";
const router = new ethers.Interface(SwapRouterAbi);
const uint256Max = (1n << 256n) - 1n;

function pool(inputId: string, inputDecimals: number, outputId: string, outputDecimals: number): SaucerSwapV2CompactPool {
  const token = (id: string, decimals: number) => ({
    id, decimals, symbol: id === "0.0.15058" ? "HBAR" : id === "0.0.5449" ? "USDC" : "SAUCE",
    name: id, priceUsd: 1, price: "0", icon: "", dueDiligenceComplete: false, isFeeOnTransferToken: false,
  });
  return {
    id: 1, contractId: "0.0.900001", fee: 3000,
    tokenA: token(inputId, inputDecimals), tokenB: token(outputId, outputDecimals),
    amountA: "1000000000000000000000", amountB: "1000000000000000000000",
    sqrtRatioX96: "0", tickCurrent: 0, liquidity: "0",
  };
}

describe("V2 user minimum output", () => {
  let client: Client;
  let tool: SwapV2Tool;
  let pools: SaucerSwapV2CompactPool[];

  beforeEach(() => {
    vi.clearAllMocks();
    client = Client.forTestnet({ scheduleNetworkUpdate: false });
    tool = new SwapV2Tool(context);
    pools = [pool("0.0.5449", 6, "0.0.1183558", 8)];
    vi.spyOn(SaucerSwapV2ConfigService.prototype, "getSaucerSwapApiKey").mockReturnValue("fixture-key");
    vi.spyOn(SaucerSwapApiServiceImpl.prototype, "getAllPoolsCompact").mockImplementation(async () => pools);
    vi.spyOn(AccountResolver, "getHederaEVMAddress").mockResolvedValue(recipient);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network or quote is permitted"); }));
  });

  afterEach(() => {
    client.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const baseParams = () => ({ tokenIn: "0.0.5449", tokenOut: "0.0.1183558", amountIn: 1 });

  function expectNoEffects() {
    expect(AccountResolver.getHederaEVMAddress).not.toHaveBeenCalled();
    expect(isTokenAssociated).not.toHaveBeenCalled();
    expect(ensureTokenAllowance).not.toHaveBeenCalled();
    expect(HederaBuilder.associateToken).not.toHaveBeenCalled();
    expect(HederaBuilder.executeTransaction).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }

  it.each([
    ["missing", undefined], ["null", null], ["number", 1], ["empty", ""],
    ["zero", "0"], ["decimal zero", "0.000"], ["negative", "-1"],
    ["exponent", "1e2"], ["NaN", "NaN"], ["infinity", "Infinity"],
    ["whitespace", " 1"], ["sign", "+1"], ["hex", "0x10"],
    ["trailing newline", "1\n"], ["carriage return", "1\r"], ["CRLF", "1\r\n"],
    ["line separator", "1\u2028"], ["paragraph separator", "1\u2029"], ["trailing tab", "1\t"],
    ["incomplete decimal", "1."], ["bare fraction", ".5"], ["separator", "1,000"],
    ["unbounded input", "1".repeat(513)],
  ])("rejects %s before pool reads or transaction effects", async (_label, minimum) => {
    // Deliberately exercise untyped tool-call input, including values TypeScript rejects.
    const raw = { ...baseParams(), amountOutMinimum: minimum };
    const result = await tool.execute(client, context, raw as Parameters<SwapV2Tool["execute"]>[2]);
    expect(result.raw.error).toBeTruthy();
    expect(SaucerSwapApiServiceImpl.prototype.getAllPoolsCompact).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it.each([
    ["less than one output base unit", "0.000000001"],
    ["nonzero excess precision", "1.000000001"],
    ["uint256 overflow", (uint256Max + 1n).toString()],
  ])("rejects %s after token resolution and before any transaction effects", async (_label, minimum) => {
    const result = await tool.execute(client, context, { ...baseParams(), amountOutMinimum: minimum });
    expect(result.raw.code).toBe("INVALID_MINIMUM_OUTPUT");
    expectNoEffects();
  });

  it.each([-1, 1.5, 256])("rejects invalid resolved output decimals %s", async decimals => {
    pools = [pool("0.0.5449", 6, "0.0.1183558", decimals)];
    const result = await tool.execute(client, context, { ...baseParams(), amountOutMinimum: "1" });
    // Fractional decimals can also fail in the existing registry before resolution.
    expect(result.raw.error).toBeTruthy();
    expectNoEffects();
  });

  it.each([
    [0, "1", 1n], [2, "1.23", 123n], [6, "0.000001", 1n],
    [8, "6.6", 660000000n], [18, "1.000000000000000001", 1000000000000000001n],
    [0, uint256Max.toString(), uint256Max],
    [6, "9007199254740993.000001", 9007199254740993000001n],
    [2, "1.23000", 123n],
  ])("converts output decimals %s and minimum %s exactly", async (decimals, minimum, expected) => {
    pools = [pool("0.0.5449", 6, "0.0.1183558", decimals)];
    const result = await tool.normalizeParams({ ...baseParams(), amountOutMinimum: minimum }, context, client);
    const calls = router.decodeFunctionData("multicall", result.contractParams.functionParameters)[0];
    const encoded = router.decodeFunctionData("exactInput", calls[0])[0];
    expect(encoded.amountOutMinimum).toBe(expected);
    expect(encoded.amountIn).toBe(1000000n);
    expect(result.resolved.amountOutMinimumBase).toBe(expected);
    expect(result.resolved.amountOutMinimumDisplay).toBe(minimum);
    expect(fetch).not.toHaveBeenCalled();
    expect(handleTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["token to token", "0.0.5449", 6, "0.0.1183558", 8, "1.2", 120000000n, false, false],
    ["HBAR to token", "0.0.15058", 8, "0.0.5449", 6, "1.2", 1200000n, true, false],
    ["token to HBAR", "0.0.5449", 6, "0.0.15058", 8, "1.2", 120000000n, false, true],
  ] as const)("preserves %s routing and carries the exact bound", async (_label, input, inputDecimals, output, outputDecimals, minimum, expected, nativeIn, nativeOut) => {
    pools = [pool(input, inputDecimals, output, outputDecimals)];
    const params = {
      tokenIn: nativeIn ? "HBAR" : input, tokenOut: nativeOut ? "HBAR" : output,
      amountIn: 1, amountOutMinimum: minimum,
    };
    const normalised = await tool.normalizeParams(params, context, client);
    const calls = router.decodeFunctionData("multicall", normalised.contractParams.functionParameters)[0];
    const swap = router.decodeFunctionData("exactInput", calls[0])[0];
    expect(swap.amountOutMinimum).toBe(expected);
    expect(swap.amountIn).toBe(10n ** BigInt(inputDecimals));
    expect(normalised.contractParams.payableAmount).toBe(nativeIn ? 100000000 : undefined);
    expect(normalised.resolved.isInputWrappedHBAR).toBe(nativeIn);
    expect(normalised.resolved.isOutputWrappedHBAR).toBe(nativeOut);
    if (nativeOut) {
      const unwrap = router.decodeFunctionData("unwrapWHBAR", calls[1]);
      expect(unwrap[0]).toBe(expected);
      expect(unwrap[1].toLowerCase()).toBe(recipient);
      expect(swap.recipient.toLowerCase()).toBe(new SaucerSwapV2ConfigService(client.ledgerId!).getRouterAddress().toLowerCase());
    } else {
      expect(router.parseTransaction({ data: calls[1] })!.name).toBe("refundETH");
      expect(swap.recipient.toLowerCase()).toBe(recipient);
    }
    await tool.coreAction(normalised, context, client);
    expect(isTokenAssociated).toHaveBeenCalledTimes(nativeOut ? 0 : 1);
    expect(ensureTokenAllowance).toHaveBeenCalledTimes(nativeIn ? 0 : 1);
    expect(HederaBuilder.executeTransaction).toHaveBeenCalledTimes(1);
    expect(handleTransaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
