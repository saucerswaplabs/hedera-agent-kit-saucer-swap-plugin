# SaucerSwap Plugin for Hedera Agent Kit

A plugin for the Hedera Agent Kit that supports token discovery, SaucerSwap V2 AMM swaps and quotes, and V3 orderbook market data and trading.

## Features

- **Token Discovery**: List what is tradable, ranked by liquidity, so an agent never has to recall token ids
- **Name Resolution**: Accept symbols and names in chat, and ask the user to choose when one matches several tokens
- **Token Swaps**: Execute token swaps on SaucerSwap V2 protocol
- **Quote Queries**: Get swap quotes to estimate output amounts before executing swaps
- **V3 Orderbook Market Data**: List markets, depth, trades and quotes
- **V3 Orderbook Trading**: Place, list and cancel off-chain-signed orders
- **Network Support**: Works with Hedera Mainnet and Testnet
- **Automatic Pool Discovery**: Picks the deepest fee tier for a token pair

### Why discovery matters

Given only `tokenIn` / `tokenOut` address parameters, an LLM asked to "swap 100 HBAR for USDC"
will invent plausible-looking ids — Hedera system accounts such as `0.0.2` and `0.0.3` are a
common guess — and every swap then fails with `POOL_NOT_FOUND`. The discovery tools remove the
need to guess: the model lists real tokens, resolves what the user said against live pool data,
and asks a clarifying question when a symbol is shared.

## Installation

```bash
npm install saucer-swap-plugin
```

## Prerequisites

Before using this plugin, you need to set up the following environment variables:

- `SAUCERSWAP_API_KEY` - API key for SaucerSwap REST API access
- `ACCOUNT_ID` - Your Hedera account ID
- `PRIVATE_KEY` - Your Hedera account private key (ECDSA format)

See [SETUP.md](./SETUP.md) for detailed setup instructions.

## Usage

### With Hedera Agent Kit

```typescript
import { HederaAIToolkit, AgentMode } from "hedera-agent-kit";
import { saucerSwapPlugin } from "saucer-swap-plugin";

const hederaAgentToolkit = new HederaAIToolkit({
  client,
  configuration: {
    plugins: [saucerSwapPlugin],
    context: {
      mode: AgentMode.RETURN_BYTES,
    },
  },
});
```

### With LangChain

```typescript
import { HederaLangchainToolkit, AgentMode } from "hedera-agent-kit";
import { saucerSwapPlugin } from "saucer-swap-plugin";

const hederaAgentToolkit = new HederaLangchainToolkit({
  client,
  configuration: {
    plugins: [saucerSwapPlugin],
    context: {
      mode: AgentMode.AUTONOMOUS,
    },
  },
});
```

## Available Tools

### V2 token references

Every `tokenIn` / `tokenOut` / `token` parameter accepts any of:

- a symbol — `USDC`
- a token name — `USD Coin`
- a Hedera token id — `0.0.456858`
- an EVM address — `0x000000000000000000000000000000000006f89a`
- `HBAR` or `WHBAR`, both routed through the network's WHBAR token

Resolution runs against live pool data, in this order: identifier, HBAR alias, exact symbol,
exact name, then substring. The first tier that matches wins, and a tier matching more than one
token raises `AMBIGUOUS_TOKEN` rather than silently picking the largest — Hedera lets anyone mint
a token called `USDC`, so the choice belongs to the user.

V2 amounts are in display units: `swap 100 HBAR` means `amountIn: 100`, not 10 000 000 000.
For swaps, the user must also approve an exact minimum output. Pass it as the decimal string
`amountOutMinimum`, using the **output** token's display units; for example, `"6.6"` means at
least 6.6 USDC when USDC is the output. A quote alone does not authorize that minimum.

### Discovery tools

- **`list_saucerswap_tokens_tool`** - List tokens that can be swapped, deepest liquidity first
  - Parameters:
    - `limit` (number, optional): How many to return, 1–100 (default 25)
    - `search` (string, optional): Filter on symbol or name, e.g. `"usd"`
  - Returns: Symbol, name, Hedera id, decimals, USD price, USD liquidity and pool count per token

- **`find_saucerswap_token_tool`** - Resolve what the user typed to one token id
  - Parameters:
    - `query` (string, required): Symbol, name, Hedera id or EVM address
  - Returns: The matched token plus what it can be swapped for; or the candidate list when the
    query is ambiguous; or suggestions when nothing matches

- **`list_saucerswap_pools_tool`** - Show swap routes and pool depth
  - Parameters:
    - `token` (string, optional): When given, returns everything this token can be swapped for
    - `limit` (number, optional): How many to return, 1–100 (default 25)
  - Returns: Counterpart tokens with fee tier and USD liquidity, or the busiest pools network-wide

### Trading tools

- **`get_swap_quote_v2_tool`** - Get a quote for swapping tokens
  - Parameters:
    - `tokenIn` (string, required): The token being sold
    - `tokenOut` (string, required): The token being bought
    - `amountIn` (number, required): The amount of `tokenIn` to sell, in display units
  - Returns: The output amount in display units, the rate, and the fee tier used

- **`swap_v2_tool`** - Execute a token swap on SaucerSwap V2
  - Parameters:
    - `tokenIn` (string, required): The token being sold
    - `tokenOut` (string, required): The token being bought
    - `amountIn` (number, required): The amount of `tokenIn` to sell, in display units
    - `amountOutMinimum` (string, required): The user's positive minimum `tokenOut` amount in display units, as a plain decimal string
    - `recipientAddress` (string, optional): The address to receive the output tokens (defaults to operator account)
  - Returns: Transaction ID and a confirmation naming both tokens and the minimum output
  - The minimum is converted exactly using the resolved output token's decimals and enforced by
    the router, including native-HBAR unwrapping. Missing, malformed, nonpositive, nonrepresentable
    and uint256-overflow minimums are rejected before association, allowance or transaction
    execution. Insignificant trailing zeros are accepted; nonzero excess precision is never rounded down.
  - Ask the user for the minimum when it is absent. Never invent a default, derive a replacement
    from a fresh quote, or lower it after a failed swap.

### Error codes

Failures carry a `code` so the agent can react instead of only apologising:

| Code | Meaning | What the agent should do |
| --- | --- | --- |
| `AMBIGUOUS_TOKEN` | The symbol or name matches several tokens | Show the candidates, ask which id |
| `TOKEN_NOT_FOUND` | Nothing tradable matches | Offer the listed alternatives |
| `POOL_NOT_FOUND` | The pair shares no pool | Suggest a counterpart from the error's route list |
| `SAME_TOKEN` | Both sides resolved to one token | Ask which two tokens were meant |
| `AMOUNT_BELOW_MINIMUM` | The amount floors to zero base units | Ask for at least the stated minimum |

### V3 Orderbook Tools

The V3 orderbook tools talk to the SaucerSwap Orderbook API
(`https://orderbook-api.saucerswap.finance` on mainnet,
`https://testnet-orderbook-api.saucerswap.finance` on testnet; selected from
the client's ledger ID).

| Tool | Type | Auth | Description |
|---|---|---|---|
| `get_orderbooks_v3_tool` | read | none | List orderbook markets (pagination + filters): token ids/EVM addresses, decimals, price/volume stats, `tickStep`/`sizeStep`/`lotSize`/`minNotional`, `takerFeePips`/`makerFeePips`, `status`, `isAMMEnabled` |
| `get_orderbook_depth_v3_tool` | read | none | Depth snapshot for one market: best bid/ask, spread, `[price, size]` string ladders, `lastUpdateId` |
| `get_orderbook_trades_v3_tool` | read | none | Public trade tape: timestamp (ms), human-readable price and `amountBase`, direction, transaction hash |
| `get_orderbook_quote_v3_tool` | read | none | Market-order simulation (exact-input / exact-output). `slippageBps` is a fixed applied buffer, not market impact. Returned `snapped*`/`suggested*` amounts map directly onto order building |
| `place_orderbook_order_v3_tool` | **write** | JWT + operator key | Full placement flow: JWT auth (challenge → operator-signed nonce → verify), server-side build (server-assigned nonces), EIP-712 signing of the returned order structs with the operator key, save. Places REAL orders — requires explicit user opt-in |
| `cancel_orderbook_orders_v3_tool` | **write** | JWT + operator key | Cancel by order ids (≤500) or emergency nonce-floor cancel-all. Asynchronous: the 202/PENDING response acknowledges forwarding, not completion — confirm via order history |
| `get_my_orderbook_orders_v3_tool` | read (authenticated) | JWT + operator key | Paginated list of the operator account's own orders with status/direction/type/time filters |

Notes:

- All uint256 amounts (`inputAmount`, `outputAmount`, nonces, deadlines) travel
  as **decimal strings** end to end — never JavaScript numbers.
- Trading tools sign off-chain messages with the agent-kit client's operator
  key (ED25519 or ECDSA), so they require `AgentMode.AUTONOMOUS` with an
  operator configured; `RETURN_BYTES` mode is not supported for orderbook
  trading. Keys, JWTs, and signatures are never logged.
- Fee-related values on this API are expressed in **pips** (1 pip = 1e-6), not
  basis points.
- The `orderbookId` filter of `get_orderbooks_v3_tool` is applied client-side:
  the server-side `orderbookId` query parameter on `GET /books` returns 404
  for every id on the current live deploy (both networks, observed
  2026-09-15), so the plugin fetches the listing and narrows locally.
- The place-order tool refuses to sign any built order whose tokens, amounts,
  flags, or recipient deviate from the request (anti-blind-signing guard);
  only the server-assigned nonce/reactor and a documented deadline clamp may
  differ, and the signed economics are echoed back in the tool output.
- This local `0.4.0-rc.1` candidate integrates the previously checked V3 tools
  with upstream token discovery and V2 fixes. The earlier V3 public-read
  evidence was collected on 2026-09-15; it does not qualify this combined
  candidate or a release. Live place/cancel/list-own-orders testing with a
  funded testnet operator remains outstanding.

## Configuration

The plugin uses pre-configured network addresses for SaucerSwap V2 contracts. The configuration is automatically selected based on the Hedera client's ledger ID (Mainnet or Testnet).

Network addresses are defined in the plugin configuration:
- **Router**: Handles swap execution
- **Factory**: Manages pool creation
- **Quoter**: Provides quote calculations
- **Wrapped HBAR**: Wrapped HBAR **token** id — note this is not the WHBAR contract id, which is
  one lower on both networks (`0.0.1456986` vs `0.0.1456985` on mainnet, `0.0.15058` vs
  `0.0.15057` on testnet). Pool data only ever names the token id, and using the contract id
  breaks HBAR-funded swaps.

Addresses are verified against [SaucerSwap's contract deployments](https://docs.saucerswap.finance/developerx/contract-deployments).

The `GET /v2/pools` response is cached for 30 seconds per network, so a single chat turn that
lists tokens, resolves a symbol and then quotes makes one HTTP request rather than three.

## Known limitations

- **Single-hop routing.** A swap only works when both tokens share a pool. `POOL_NOT_FOUND`
  reports what each token *can* be traded against so the agent can propose a workable pair.
- **No automatic slippage calculation.** The caller must supply the user's approved minimum
  output. A swap below that floor reverts; changing the minimum requires a new user instruction.
  Published 0.3.1 does not enforce this requirement; these changes belong to the local 0.4.0-rc.1 candidate.

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Type check without building
npm run type-check

# Watch mode for development
npm run dev
```

## Example

See the `examples/` directory for a complete example of using the plugin with LangChain and OpenAI.

### A swap from scratch, entirely in chat

```
user  > what can I swap on saucerswap?
        -> list_saucerswap_tokens_tool { limit: 25 }
agent > Top 25 of 44 swappable tokens on mainnet, deepest liquidity first:
         1. HBAR — WHBAR [new] — id 0.0.1456986 — 8 decimals — $0.07 — $3,948,624 liquidity across 37 pool(s)
         2. USDC — USD Coin — id 0.0.456858 — 6 decimals — $0.97 — $818,617 liquidity across 9 pool(s)
         ...

user  > what can I get for USD Coin?
        -> list_saucerswap_pools_tool { token: "USD Coin" }
agent > "USD Coin" matches 2 different tokens. Which do you mean?
         1. USDC — USD Coin — id 0.0.456858 — $818,617 liquidity
         2. USDC[hts] — USD Coin — id 0.0.1055459 — $28,870 liquidity

user  > the first one
        -> list_saucerswap_pools_tool { token: "0.0.456858" }
agent > USDC (0.0.456858) can be swapped directly for HBAR, USDC[hts], USDT0, ...

user  > quote 100 hbar to usdc
        -> get_swap_quote_v2_tool { tokenIn: "HBAR", tokenOut: "0.0.456858", amountIn: 100 }
agent > Swapping 100 HBAR returns about 6.68 USDC. Rate: 1 HBAR ≈ 0.0668 USDC.
        Routed through the 0.15% fee pool.

user  > swap it, but receive at least 6.6 USDC
        -> swap_v2_tool { tokenIn: "HBAR", tokenOut: "0.0.456858", amountIn: 100, amountOutMinimum: "6.6" }
agent > Swapped 100 native HBAR for USDC (0.0.456858), with a minimum of 6.6 USDC, through the 0.15% fee pool.
        Transaction ID: 0.0.5273913@1755164231.123456789
```

## License

MIT
