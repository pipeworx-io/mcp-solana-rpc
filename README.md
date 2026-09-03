# @pipeworx/solana-rpc

SPL token holdings, SOL balance and transaction history for any Solana address, and the top
holders of any SPL token mint, read live from public Solana JSON-RPC endpoints — no API key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1503+ live data sources.

## Tools

- `solana_wallet_tokens(wallet, limit?, offset?, min_amount?, include_zero?, program?)` — every SPL token position
  a wallet holds: mint address, balance, decimals, token-account address, across both the SPL Token and
  Token-2022 programs. Zero balances dropped, sorted largest first, paginated.
- `solana_wallet_balance(wallet)` — native SOL balance in lamports and SOL, with the slot it was read at.
- `solana_wallet_transactions(wallet, limit?, before?, until?)` — recent signatures with block time, slot,
  success/failure and memo, newest first; `next_before` pages further back.
- `solana_transaction(signature)` — one transaction summarised: fee, status, signers, programs and instruction
  types invoked, SOL balance changes, SPL token balances before and after, first log lines.
- `solana_token_holders(mint, limit?)` — the largest token accounts of an SPL token mint, ranked by balance,
  each with its owner wallet, token-account address, raw and decimal balance and percentage of total supply;
  plus the mint's supply, decimals and the share the returned holders control together. 20 holders from most
  endpoints, up to 100 where the node allows.
- `solana_rpc_health()` — live per-endpoint, per-method reachability probe. Use it when a lookup comes back empty
  and you need to tell an endpoint block apart from an idle wallet.

## Auth

Keyless.

## Data sources

- <https://solana-rpc.publicnode.com> — Solana mainnet JSON-RPC operated by PublicNode/Allnodes.
- <https://solana.leorpc.com/?api_key=FREE> — Solana mainnet JSON-RPC operated by LeoRPC (free shared key).
- <https://rpc.magicblock.app/mainnet> — Solana mainnet JSON-RPC operated by MagicBlock (public endpoint). The
  only keyless endpoint found that serves `getTokenLargestAccounts`; first in line for mint-level calls, last
  resort for wallet calls.

## Things worth knowing before you touch this

**The endpoint that works on your laptop is not the endpoint that works in production.**
`api.mainnet-beta.solana.com` returns 200 locally and HTTP 403 *"Your IP or provider is blocked from this
endpoint"* from a Cloudflare Worker. Twelve free RPC endpoints were probed **from a deployed Worker**; ankr,
rpcpool and mainnet-beta 403, drpc 400s for a paid plan, blockeden 402, onfinality and omniatech 429, grove
1016, public-rpc 526, shyft 401. Two survived, and neither serves everything:

| Endpoint | From Cloudflare |
|---|---|
| `solana-rpc.publicnode.com` | 200 for `getSignaturesForAddress`, `getBalance`, `getTransaction`, `getSlot`; **`-32602 "Request blocked"` for `getTokenAccountsByOwner`** (method allowlist) |
| `solana.leorpc.com/?api_key=FREE` | 200 for `getTokenAccountsByOwner` (2.37 MB for a 4,513-account wallet); intermittent `-32603` on signature queries |

So failover is the architecture, not a safety net. Calls walk `PROVIDERS` in order, retry once on a transient
failure, and skip a provider that refuses the method outright (`-32601`/`-32602`/`-32000`/403). A refusal is
remembered per isolate so later calls go straight to the endpoint that serves it; a flake is not remembered,
because flakes recover. Every response carries `providers_tried` with the outcome and latency of each hop, so a
caller can see exactly where the answer came from.

**Response size is the other constraint.** One wallet returned 4,513 token accounts / 2,376,758 bytes from a
single `getTokenAccountsByOwner`. Returning that unfiltered would blow both the response budget and the Worker
CPU limit, so `solana_wallet_tokens` drops zero balances (2,605 of 4,513 survived on that wallet), sorts by
balance and returns a page, reporting `total_token_accounts`, `holdings_with_balance` and `upstream_bytes` so
the caller knows what was left behind.

**Public nodes prune history.** An empty `solana_wallet_transactions` result means "outside this node's
retention window" as often as "no activity" — the tool says so in its `note` rather than implying the wallet
is idle. Full history needs an archival endpoint (the `helius` or `solscan` packs, with your own key).

**Entity attribution is a different product.** "Which wallets belong to <person/company/exchange>" cannot be
answered from RPC — it is addressed by public key alone. A name passed as `wallet` fails base58 validation and
returns `{found: false, reason: 'not_an_address'}` with a hint naming Arkham/Nansen-class labelling, rather
than quietly returning something adjacent.

**Token holders are a third provider's problem.** `getTokenLargestAccounts` is the one method BOTH original
providers refuse — publicnode answers `-32602 "Request blocked"`, `api.mainnet-beta.solana.com` answers
`429 "Too many requests for a specific RPC call"` even on the first call — and it is the method behind "who
holds this token". Of ~50 public endpoints probed on 2026-09-03, `rpc.magicblock.app/mainnet` was the only
keyless one that serves it (and returns 100 largest accounts where the validator default is 20). So
`solana_token_holders` walks a separate provider order with MagicBlock first, then resolves each token
account's owner with `getMultipleAccounts` and the percentage against `getTokenSupply`. If MagicBlock ever
blocks datacenter egress, the tool degrades to `{found: false, reason: 'upstream_unavailable'}` naming the
keyed alternatives — the wiring for a dedicated endpoint (`PLATFORM_SOLANA_RPC_URL`) is deliberately not
declared on the gateway until a key exists, because a declared-but-unset key books as our provisioning gap.

**`-32602` means two different things.** publicnode uses it for "this method is not on the allowlist"
(provider-level, remembered for the isolate); every node also uses it for "Invalid param: not a Token mint"
(caller-level). The walker tells them apart by message: an `Invalid param` is thrown straight back as the
caller's problem and never poisons the provider for the method.

**Mints come back bare.** Solana RPC carries no token names, symbols or prices; `birdeye`, `solscan` and
`helius` cover token metadata with a key.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "solana-rpc": {
      "url": "https://gateway.pipeworx.io/solana-rpc/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/solana-rpc/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1503+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Solana Rpc data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
