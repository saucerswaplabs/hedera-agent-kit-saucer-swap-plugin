export interface SaucerSwapV2QueryService {
    getSwapQuote(inputToken: string, outputToken: string, amountIn: bigint, poolFeesInHexFormat: string): Promise<bigint>
}