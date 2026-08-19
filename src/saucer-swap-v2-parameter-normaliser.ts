import { Context, AccountResolver, IHederaMirrornodeService, contractExecuteTransactionParametersNormalised } from "@hashgraph/hedera-agent-kit";
import { getSwapQuoteV2Parameters, getSwapQuoteV2ParametersNormalised, swapV2Parameters } from './saucer-swap.zod'
import { Client } from "@hiero-ledger/sdk";
import { ethers } from "ethers";
import z from 'zod';
import { feeTierToPercent, toBaseUnitBigInt, toSafeExactNumber } from "./utils";
import SwapRouterAbi from './abi/SwapRouter.json'
import { SaucerSwapV2ConfigService } from "./service/saucer-swap-v2-config-service";
import { buildEncodedPath } from "./utils/swap-path";
import { SAUCER_SWAP_CONFIG } from "./constants";
import {
    SaucerSwapTokenInfo,
    SaucerSwapTokenRegistry,
} from "./service/token-registry-service";
import { InvalidAmountError, SaucerSwapError } from "./errors";

/** Tokens and amounts as they were resolved from what the user typed. */
export type ResolvedSwapV2Context = {
    tokenIn: SaucerSwapTokenInfo;
    tokenOut: SaucerSwapTokenInfo;
    /** amountIn in the input token's base units. */
    amountInBase: bigint;
    /** amountIn as the user expressed it. */
    amountInDisplay: number;
    isInputWrappedHBAR: boolean;
    isOutputWrappedHBAR: boolean;
    recipientAccountId: string;
    feePercent: number;
};

export type NormalisedSwapV2Params = {
    contractParams: z.infer<ReturnType<typeof contractExecuteTransactionParametersNormalised>>;
    resolved: ResolvedSwapV2Context;
};

export default class SaucerSwapV2ParameterNormaliser {
    static parseParamsWithSchema(
        params: any,
        schema: any,
        context: Context = {},
      ): z.infer<ReturnType<typeof schema>> {
        let parsedParams: z.infer<ReturnType<typeof schema>>;
        try {
          parsedParams = schema(context).parse(params);
        } catch (e) {
          if (e instanceof z.ZodError) {
            const issues = this.formatZodIssues(e);
            throw new Error(`Invalid parameters: ${issues}`);
          }
          throw e;
        }
        return parsedParams;
      }

    private static formatZodIssues(error: z.ZodError): string {
        return error.errors.map(err => `Field "${err.path.join('.')}" - ${err.message}`).join('; ');
    }

    /**
     * Resolves both token references against live pool data.
     *
     * @throws {AmbiguousTokenError} when a symbol or name matches several tokens
     * @throws {TokenNotFoundError} when nothing tradable matches
     */
    private static resolveTokenPair(
        tokenIn: string,
        tokenOut: string,
        registry: SaucerSwapTokenRegistry,
    ): { tokenIn: SaucerSwapTokenInfo; tokenOut: SaucerSwapTokenInfo } {
        const resolvedIn = registry.resolveOrThrow(tokenIn, 'tokenIn');
        const resolvedOut = registry.resolveOrThrow(tokenOut, 'tokenOut');

        if (resolvedIn.id === resolvedOut.id) {
            throw new SaucerSwapError(
                `tokenIn and tokenOut both resolve to ${resolvedIn.symbol} (${resolvedIn.id}). ` +
                `Ask the user which two different tokens they want to trade.`,
                'SAME_TOKEN',
            );
        }

        return { tokenIn: resolvedIn, tokenOut: resolvedOut };
    }

    /**
     * Catches amounts that survive the `> 0` check but floor to zero base units,
     * e.g. 0.001 of a 2-decimal token. Without this the failure surfaces from the
     * quoter as a bare "Invalid amount: 0".
     */
    private static assertTradableAmount(
        amountInBase: bigint,
        amountInDisplay: number,
        tokenIn: SaucerSwapTokenInfo,
    ): void {
        if (amountInBase > 0n) return;
        const smallest = (1 / 10 ** tokenIn.decimals).toFixed(tokenIn.decimals);
        throw new SaucerSwapError(
            `${amountInDisplay} ${tokenIn.symbol} is below the smallest tradable amount: ` +
            `${tokenIn.symbol} has ${tokenIn.decimals} decimals, so the minimum is ${smallest}.`,
            'AMOUNT_BELOW_MINIMUM',
        );
    }

    static async normaliseGetSwapQuoteV2Params(
        params: z.infer<ReturnType<typeof getSwapQuoteV2Parameters>>,
        context: Context,
        registry: SaucerSwapTokenRegistry,
    ) : Promise<z.infer<ReturnType<typeof getSwapQuoteV2ParametersNormalised>>> {
        const parsedParams: z.infer<ReturnType<typeof getSwapQuoteV2Parameters>> =
        this.parseParamsWithSchema(params, getSwapQuoteV2Parameters, context);
        if (parsedParams.amountIn <= 0) {
            throw new InvalidAmountError(parsedParams.amountIn);
        }

        const { tokenIn, tokenOut } = this.resolveTokenPair(
            parsedParams.tokenIn,
            parsedParams.tokenOut,
            registry,
        );

        const pool = registry.findPoolForTokens(tokenIn.id, tokenOut.id);
        const poolFeesInHexFormat = `0x${pool.fee?.toString(16).padStart(6, '0')}`;
        const amountIn = toBaseUnitBigInt(parsedParams.amountIn, tokenIn.decimals);
        this.assertTradableAmount(amountIn, parsedParams.amountIn, tokenIn);

        return {
            tokenIn: tokenIn.evmAddress,
            tokenOut: tokenOut.evmAddress,
            amountIn,
            poolFeesInHexFormat,
            tokenInId: tokenIn.id,
            tokenInSymbol: tokenIn.symbol,
            tokenInDecimals: tokenIn.decimals,
            tokenOutId: tokenOut.id,
            tokenOutSymbol: tokenOut.symbol,
            tokenOutDecimals: tokenOut.decimals,
            feePercent: feeTierToPercent(pool.fee),
            isInputWrappedHBAR: registry.isWrappedHbar(tokenIn.id),
            isOutputWrappedHBAR: registry.isWrappedHbar(tokenOut.id),
        };
    }

    static async normaliseSwapV2Params(
        params: z.infer<ReturnType<typeof swapV2Parameters>>,
        context: Context,
        saucerSwapV2ConfigService: SaucerSwapV2ConfigService,
        registry: SaucerSwapTokenRegistry,
        mirrorNode: IHederaMirrornodeService,
        client: Client,
    ) : Promise<NormalisedSwapV2Params> {
        const parsedParams: z.infer<ReturnType<typeof swapV2Parameters>> =
        this.parseParamsWithSchema(params, swapV2Parameters, context);

        if (parsedParams.amountIn <= 0) {
            throw new InvalidAmountError(parsedParams.amountIn);
        }

        const { tokenIn, tokenOut } = this.resolveTokenPair(
            parsedParams.tokenIn,
            parsedParams.tokenOut,
            registry,
        );

        const recipient = AccountResolver.resolveAccount(parsedParams.recipientAddress, context, client);
        const recipientAddress = await AccountResolver.getHederaEVMAddress(recipient, mirrorNode);

        const pool = registry.findPoolForTokens(tokenIn.id, tokenOut.id);
        const poolFees = pool.fee;
        const amountIn = toBaseUnitBigInt(parsedParams.amountIn, tokenIn.decimals);
        this.assertTradableAmount(amountIn, parsedParams.amountIn, tokenIn);
        const poolFeesInHexFormat = `0x${poolFees?.toString(16).padStart(6, '0')}`;
        const routeDataWithFee = buildEncodedPath(tokenIn.evmAddress, poolFeesInHexFormat.toLowerCase(), tokenOut.evmAddress);
        const abiSwapRouterInterface = new ethers.Interface(SwapRouterAbi)
        const swapRouterContractId = saucerSwapV2ConfigService.getSwapRouterContractId()
        const wrappedHBarEvmAddress = saucerSwapV2ConfigService.getWrappedHBarEvmAddress()

        const isInputWrappedHBAR =
          tokenIn.evmAddress.toLowerCase() === wrappedHBarEvmAddress.toLowerCase();
        const isOutputWrappedHBAR =
          tokenOut.evmAddress.toLowerCase() === wrappedHBarEvmAddress.toLowerCase();

        const exactInputParams = {
            path: routeDataWithFee,
            recipient: isOutputWrappedHBAR
                ? saucerSwapV2ConfigService.getRouterAddress()
                : recipientAddress,
            deadline: Math.floor(Date.now() / 1000) + SAUCER_SWAP_CONFIG.DEFAULT_DEADLINE_SECONDS,
            amountIn: amountIn,
            amountOutMinimum: 0
        };

        const swapEncoded = abiSwapRouterInterface.encodeFunctionData('exactInput', [exactInputParams]);

        const multiCallParam = [
            swapEncoded,
            isOutputWrappedHBAR
                ? abiSwapRouterInterface.encodeFunctionData('unwrapWHBAR', [0, recipientAddress])
                : abiSwapRouterInterface.encodeFunctionData('refundETH'),
        ];

        const encodedData = abiSwapRouterInterface.encodeFunctionData('multicall', [multiCallParam]);

        const functionParameters = ethers.getBytes(encodedData);

        const contractParams = {
          contractId: swapRouterContractId.toString(),
          functionParameters,
          gas: SAUCER_SWAP_CONFIG.SWAP_GAS_LIMIT,
          payableAmount: isInputWrappedHBAR ? toSafeExactNumber(amountIn) : undefined,
        };

        return {
            contractParams,
            resolved: {
                tokenIn,
                tokenOut,
                amountInBase: amountIn,
                amountInDisplay: parsedParams.amountIn,
                isInputWrappedHBAR,
                isOutputWrappedHBAR,
                recipientAccountId: recipient,
                feePercent: feeTierToPercent(poolFees),
            },
        };
    }
}
