interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Solana RPC (keyless)
 *
 * SPL token holdings, SOL balance and transaction history for a Solana wallet,
 * and the top holders of an SPL token mint, read from public Solana JSON-RPC
 * endpoints.
 *
 * ── Why this pack exists, and the trap it is built around ─────────────────
 * `api.mainnet-beta.solana.com` answers fine from a laptop and returns HTTP 403
 * ("Your IP or provider is blocked from this endpoint") from a Cloudflare
 * Worker. Every endpoint below was probed from a deployed Worker, not locally.
 * Two providers survive that probe, and NEITHER serves every method:
 *
 *   solana-rpc.publicnode.com   200 for getSignaturesForAddress / getBalance /
 *                               getTransaction / getSlot; -32602 "Request
 *                               blocked" for getTokenAccountsByOwner.
 *   solana.leorpc.com?api_key=FREE
 *                               200 for getTokenAccountsByOwner (2.37 MB for a
 *                               4,513-account wallet); intermittently -32603 on
 *                               signature queries.
 *
 * So failover is the design, not a fallback: every call walks the provider list
 * in order, retries once on a transient failure, and moves on when a provider
 * refuses the method. A refusal ("this provider does not serve this method") is
 * remembered per isolate so later calls skip that provider; a flake is not,
 * because flakes come back. Every response carries `providers_tried` so a
 * caller can see which endpoint actually answered.
 *
 * ── The other design constraint is response size ──────────────────────────
 * One wallet returned 4,513 token accounts / 2,376,758 bytes. Passing that
 * through would blow the response budget and the Worker CPU limit, so
 * `solana_wallet_tokens` drops zero balances, sorts by size and paginates,
 * reporting the full counts alongside the page it returns.
 *
 * ── One question this data cannot answer ──────────────────────────────────
 * "Which wallets belong to <person/company/exchange>" is on-chain entity
 * labelling. Solana RPC is addressed by public key only, so a name arrives here
 * as an invalid address and the tool says so by name (`not_an_address`) rather
 * than quietly returning something else. Arkham/Nansen-class labelling products
 * cover that question.
 */


const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

interface Provider {
  name: string;
  url: string;
}

// Ordered. publicnode first because it is the steadier of the two; leorpc is
// the only one of twelve probed endpoints that serves account scans from CF.
const PROVIDERS: Provider[] = [
  { name: 'publicnode', url: 'https://solana-rpc.publicnode.com' },
  { name: 'leorpc', url: 'https://solana.leorpc.com/?api_key=FREE' },
  // Added 2026-09-03 (fleet #1211): the only keyless endpoint of 50 probed that
  // serves getTokenLargestAccounts (publicnode -32602 "Request blocked",
  // mainnet-beta 429 "Too many requests for a specific RPC call"). Last in the
  // general order so wallet calls keep their measured providers; first for the
  // mint-level methods below.
  { name: 'magicblock', url: 'https://rpc.magicblock.app/mainnet' },
];

// Mint-level methods (getTokenLargestAccounts, getTokenSupply,
// getMultipleAccounts) walk this order instead: the two wallet providers refuse
// or throttle the largest-accounts call outright, so trying them first only
// adds latency and a refusal entry to every holders query.
const MINT_PROVIDERS: Provider[] = [PROVIDERS[2], PROVIDERS[0], PROVIDERS[1]];

// `${provider}:${method}` → this provider refuses this method outright.
// Isolate-lifetime only: a wrong entry costs one extra hop after a cold start.
const METHOD_REFUSED = new Set<string>();

interface Attempt {
  provider: string;
  ok: boolean;
  error?: string;
  ms: number;
}

interface RpcResult {
  value: unknown;
  provider: string;
  attempts: Attempt[];
  bytes: number;
}

class RpcFailure extends Error {
  attempts: Attempt[];
  constructor(message: string, attempts: Attempt[]) {
    super(message);
    this.attempts = attempts;
  }
}

async function rpcOnce(
  provider: Provider,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<{ value: unknown; bytes: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err: Error & { refused?: boolean } = new Error(
        `HTTP ${res.status}: ${text.slice(0, 160)}`,
      );
      // 403/404 from these hosts is an endpoint-level block, not a blip.
      err.refused = res.status === 403 || res.status === 404 || res.status === 401;
      throw err;
    }
    let body: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response: ${text.slice(0, 160)}`);
    }
    if (body.error) {
      const code = body.error.code;
      // -32601 method not found, -32602 "Request blocked" (publicnode's
      // allowlist), -32000 disabled. -32603 is an internal blip — retryable.
      // -32602 is ALSO the code a node uses for a bad argument ("Invalid param:
      // not a Token mint"); that is the caller's input, not the provider, so it
      // must neither poison the provider for the method nor be retried elsewhere.
      const message = body.error.message ?? '';
      const inputError = code === -32602 && /invalid param/i.test(message);
      const err: Error & { refused?: boolean; inputError?: boolean } = new Error(
        `RPC ${code ?? '?'}: ${message || 'unknown error'}`,
      );
      err.inputError = inputError;
      err.refused = !inputError && (code === -32601 || code === -32602 || code === -32000);
      throw err;
    }
    if (body.result === undefined) throw new Error('RPC returned no result field');
    return { value: body.result, bytes: text.length };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(
  method: string,
  params: unknown[],
  opts: { timeoutMs?: number; providers?: Provider[] } = {},
): Promise<RpcResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const attempts: Attempt[] = [];
  for (const provider of opts.providers ?? PROVIDERS) {
    if (METHOD_REFUSED.has(`${provider.name}:${method}`)) {
      attempts.push({ provider: provider.name, ok: false, error: 'skipped (refuses this method)', ms: 0 });
      continue;
    }
    // One retry per provider: leorpc answers ~2 of 3 on signature queries.
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      const started = Date.now();
      try {
        const { value, bytes } = await rpcOnce(provider, method, params, timeoutMs);
        attempts.push({ provider: provider.name, ok: true, ms: Date.now() - started });
        return { value, provider: provider.name, attempts, bytes };
      } catch (e) {
        const err = e as Error & { refused?: boolean; inputError?: boolean };
        const message = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
        attempts.push({ provider: provider.name, ok: false, error: message, ms: Date.now() - started });
        // The argument is wrong: every provider will say the same, so stop here.
        if (err.inputError) throw new RpcFailure(`${method} rejected its arguments`, attempts);
        if (err.refused) {
          METHOD_REFUSED.add(`${provider.name}:${method}`);
          break;
        }
      }
    }
  }
  throw new RpcFailure(`no provider served ${method}`, attempts);
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decodes base58 and returns the decoded byte length, or -1 if the string is
 * not base58. Length is the point: a Solana public key is exactly 32 bytes and
 * a signature exactly 64, and character count alone does not pin either down.
 */
function base58ByteLength(s: string): number {
  if (!s || s.length > 128) return -1;
  // Little-endian accumulator, as in the reference base58 decoder.
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) return -1;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // High-order zero bytes carry no information; leading '1' characters are the
  // encoding of genuine leading zero bytes, so they count.
  let significant = bytes.length;
  while (significant > 0 && bytes[significant - 1] === 0) significant--;
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  return leadingZeros + significant;
}

function isPubkey(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58ByteLength(s) === 32;
}

function isSignature(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s) && base58ByteLength(s) === 64;
}

const ADDRESS_HINT =
  'Supply a base58 Solana address (32-44 characters, e.g. Gf9XgdmvNHt8fUTFsWAccNbKeyDXsgJyZN8iFJKg5Pbd). ' +
  'Solana RPC is addressed by public key alone: turning a person, company or exchange name into its wallet ' +
  'addresses is on-chain entity labelling, which Arkham- or Nansen-class products provide.';

function notAnAddress(value: unknown) {
  return {
    found: false,
    reason: 'not_an_address',
    given: typeof value === 'string' ? value.slice(0, 120) : String(value),
    hint: ADDRESS_HINT,
  };
}

function upstreamDown(e: RpcFailure) {
  return {
    found: false,
    reason: 'upstream_unavailable',
    hint:
      'Every public Solana RPC endpoint refused or timed out on this call. Public endpoints throttle hard; ' +
      'retry shortly, or use the helius / solscan / birdeye packs with your own API key for a dedicated endpoint.',
    providers_tried: e.attempts,
  };
}

function isoTime(unixSeconds: unknown): string | null {
  return typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000).toISOString() : null;
}

interface ParsedTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
        };
      };
    };
  };
}

async function walletTokens(args: Record<string, unknown>) {
  const wallet = args.wallet;
  if (!isPubkey(wallet)) return notAnAddress(wallet);

  const limit = Math.min(Math.max(Number(args.limit ?? 25) || 25, 1), 200);
  const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
  const includeZero = args.include_zero === true;
  const minAmount = Number(args.min_amount ?? 0) || 0;
  const program = String(args.program ?? 'both').toLowerCase();

  const programIds: Array<{ id: string; label: string }> = [];
  if (program === 'token' || program === 'both') programIds.push({ id: SPL_TOKEN_PROGRAM, label: 'spl-token' });
  if (program === 'token-2022' || program === 'both')
    programIds.push({ id: SPL_TOKEN_2022_PROGRAM, label: 'spl-token-2022' });

  const holdings: Array<Record<string, unknown>> = [];
  const attempts: Attempt[] = [];
  const providersUsed: string[] = [];
  let upstreamBytes = 0;
  let totalAccounts = 0;
  let served = 0;

  for (const p of programIds) {
    let out: RpcResult;
    try {
      out = await rpc(
        'getTokenAccountsByOwner',
        [wallet, { programId: p.id }, { encoding: 'jsonParsed' }],
        { timeoutMs: 20_000 },
      );
    } catch (e) {
      attempts.push(...(e as RpcFailure).attempts);
      // Token-2022 is a small tail; only fail the call if the main scan failed.
      if (p.id === SPL_TOKEN_PROGRAM || programIds.length === 1) {
        return { ...upstreamDown(e as RpcFailure), wallet, providers_tried: attempts };
      }
      continue;
    }
    served++;
    attempts.push(...out.attempts);
    if (!providersUsed.includes(out.provider)) providersUsed.push(out.provider);
    upstreamBytes += out.bytes;

    const accounts = ((out.value as { value?: ParsedTokenAccount[] }).value ?? []) as ParsedTokenAccount[];
    totalAccounts += accounts.length;
    for (const a of accounts) {
      const info = a.account?.data?.parsed?.info;
      if (!info) continue;
      const ui = info.tokenAmount?.uiAmount ?? 0;
      if (!includeZero && !(ui > 0)) continue;
      if (ui < minAmount) continue;
      holdings.push({
        mint: info.mint,
        ui_amount: ui,
        amount: info.tokenAmount?.amount,
        decimals: info.tokenAmount?.decimals,
        token_account: a.pubkey,
        program: p.label,
      });
    }
  }

  if (served === 0) {
    return {
      found: false,
      reason: 'upstream_unavailable',
      wallet,
      hint: upstreamDown(new RpcFailure('', [])).hint,
      providers_tried: attempts,
    };
  }

  holdings.sort((a, b) => (b.ui_amount as number) - (a.ui_amount as number));
  const page = holdings.slice(offset, offset + limit);

  return {
    found: page.length > 0,
    wallet,
    total_token_accounts: totalAccounts,
    holdings_with_balance: holdings.length,
    returned: page.length,
    offset,
    next_offset: offset + limit < holdings.length ? offset + limit : null,
    holdings: page,
    upstream_bytes: upstreamBytes,
    note:
      `The wallet's full token-account list was ${upstreamBytes.toLocaleString()} bytes across ` +
      `${totalAccounts.toLocaleString()} accounts; zero balances are dropped and the rest sorted by size, ` +
      'so page through with `offset` for the long tail. Mint addresses are returned as-is — Solana RPC ' +
      'carries no token names or symbols.',
    providers_tried: attempts,
    provider: providersUsed.join(','),
    source: 'Solana JSON-RPC getTokenAccountsByOwner (SPL Token + Token-2022 programs)',
  };
}

async function walletBalance(args: Record<string, unknown>) {
  const wallet = args.wallet;
  if (!isPubkey(wallet)) return notAnAddress(wallet);
  let out: RpcResult;
  try {
    out = await rpc('getBalance', [wallet]);
  } catch (e) {
    return { ...upstreamDown(e as RpcFailure), wallet };
  }
  const v = out.value as { value?: number; context?: { slot?: number; apiVersion?: string } };
  const lamports = v.value ?? 0;
  return {
    found: true,
    wallet,
    lamports,
    sol: lamports / 1e9,
    slot: v.context?.slot ?? null,
    providers_tried: out.attempts,
    provider: out.provider,
    source: 'Solana JSON-RPC getBalance',
  };
}

async function walletTransactions(args: Record<string, unknown>) {
  const wallet = args.wallet;
  if (!isPubkey(wallet)) return notAnAddress(wallet);
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
  const params: Record<string, unknown> = { limit };
  if (typeof args.before === 'string' && args.before) params.before = args.before;
  if (typeof args.until === 'string' && args.until) params.until = args.until;

  let out: RpcResult;
  try {
    out = await rpc('getSignaturesForAddress', [wallet, params]);
  } catch (e) {
    return { ...upstreamDown(e as RpcFailure), wallet };
  }
  const rows = (out.value as Array<Record<string, unknown>>) ?? [];
  const transactions = rows.map((r) => ({
    signature: r.signature,
    slot: r.slot,
    block_time: isoTime(r.blockTime),
    status: r.err ? 'failed' : 'success',
    error: r.err ?? null,
    memo: r.memo ?? null,
    confirmation_status: r.confirmationStatus ?? null,
  }));
  return {
    found: transactions.length > 0,
    wallet,
    returned: transactions.length,
    transactions,
    next_before: transactions.length === limit ? transactions[transactions.length - 1].signature : null,
    note:
      transactions.length === 0
        ? 'The endpoint that answered holds no signatures for this address — public nodes prune history, so ' +
          'an empty list here means "outside this node\'s retention window" as often as "no activity". A ' +
          'dedicated archival endpoint (helius, solscan) covers the full history.'
        : 'Pass the last signature as `before` to page further back.',
    providers_tried: out.attempts,
    provider: out.provider,
    source: 'Solana JSON-RPC getSignaturesForAddress',
  };
}

async function transaction(args: Record<string, unknown>) {
  const signature = args.signature;
  if (!isSignature(signature)) {
    return {
      found: false,
      reason: 'not_a_signature',
      given: typeof signature === 'string' ? signature.slice(0, 120) : String(signature),
      hint: 'Supply a base58 Solana transaction signature (about 88 characters). Signatures for a wallet come from solana_wallet_transactions.',
    };
  }
  let out: RpcResult;
  try {
    out = await rpc(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      { timeoutMs: 15_000 },
    );
  } catch (e) {
    return { ...upstreamDown(e as RpcFailure), signature };
  }
  if (out.value === null) {
    return {
      found: false,
      reason: 'not_found',
      signature,
      hint: 'The endpoint that answered has no record of this signature — public nodes prune older slots. A dedicated archival endpoint (helius, solscan) reaches further back.',
      providers_tried: out.attempts,
    };
  }
  const tx = out.value as {
    slot?: number;
    blockTime?: number;
    meta?: {
      fee?: number;
      err?: unknown;
      preBalances?: number[];
      postBalances?: number[];
      preTokenBalances?: Array<Record<string, unknown>>;
      postTokenBalances?: Array<Record<string, unknown>>;
      logMessages?: string[];
    };
    transaction?: {
      message?: {
        accountKeys?: Array<{ pubkey: string; signer?: boolean; writable?: boolean }>;
        instructions?: Array<{ program?: string; programId?: string; parsed?: { type?: string } }>;
      };
    };
  };

  const keys = tx.transaction?.message?.accountKeys ?? [];
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  const solChanges = keys
    .map((k, i) => ({
      account: k.pubkey,
      change_sol: ((post[i] ?? 0) - (pre[i] ?? 0)) / 1e9,
      signer: k.signer === true,
    }))
    .filter((c) => c.change_sol !== 0);

  const tokenBalance = (b: Record<string, unknown>) => ({
    account_index: b.accountIndex,
    mint: b.mint,
    owner: b.owner ?? null,
    ui_amount: (b.uiTokenAmount as { uiAmount?: number } | undefined)?.uiAmount ?? 0,
  });

  return {
    found: true,
    signature,
    slot: tx.slot ?? null,
    block_time: isoTime(tx.blockTime),
    status: tx.meta?.err ? 'failed' : 'success',
    error: tx.meta?.err ?? null,
    fee_sol: (tx.meta?.fee ?? 0) / 1e9,
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey),
    programs: [
      ...new Set(
        (tx.transaction?.message?.instructions ?? []).map((i) => i.program ?? i.programId ?? 'unknown'),
      ),
    ],
    instruction_types: (tx.transaction?.message?.instructions ?? [])
      .map((i) => i.parsed?.type)
      .filter(Boolean),
    sol_changes: solChanges.slice(0, 25),
    token_balances_before: (tx.meta?.preTokenBalances ?? []).slice(0, 25).map(tokenBalance),
    token_balances_after: (tx.meta?.postTokenBalances ?? []).slice(0, 25).map(tokenBalance),
    log_lines: (tx.meta?.logMessages ?? []).slice(0, 20),
    note: 'Summarised from the parsed transaction; balance changes and logs are capped so a large transaction stays readable.',
    providers_tried: out.attempts,
    provider: out.provider,
    source: 'Solana JSON-RPC getTransaction (jsonParsed)',
  };
}

interface LargestAccount {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
}

interface ParsedAccountInfo {
  owner?: string; // the PROGRAM that owns the account (Token / Token-2022)
  data?: {
    program?: string;
    parsed?: { type?: string; info?: { owner?: string; mint?: string; state?: string } };
  };
}

function isMintError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('could not find mint') || m.includes('invalid param') || m.includes('not a token mint');
}

async function tokenHolders(args: Record<string, unknown>) {
  const mint = args.mint;
  if (!isPubkey(mint)) {
    return {
      found: false,
      reason: 'not_an_address',
      given: typeof mint === 'string' ? mint.slice(0, 120) : String(mint),
      hint:
        'Supply the base58 MINT address of the token (32-44 characters, e.g. USDC is ' +
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). A token symbol or name is not an address: resolve it ' +
        'to a mint first (the birdeye or solscan packs search tokens by symbol with a key).',
    };
  }
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
  const attempts: Attempt[] = [];
  const providersUsed: string[] = [];
  const use = (out: RpcResult) => {
    attempts.push(...out.attempts);
    if (!providersUsed.includes(out.provider)) providersUsed.push(out.provider);
  };

  // 1. Supply first: it is the cheapest call and the one that tells a non-mint
  //    address apart from a mint nobody holds.
  let supplyOut: RpcResult;
  try {
    supplyOut = await rpc('getTokenSupply', [mint], { providers: MINT_PROVIDERS });
  } catch (e) {
    const fail = e as RpcFailure;
    attempts.push(...fail.attempts);
    if (fail.attempts.some((a) => a.error && isMintError(a.error))) {
      return {
        found: false,
        reason: 'not_a_mint',
        mint,
        hint:
          'This address is a valid Solana public key but not an SPL token mint — the RPC has no token supply ' +
          'for it. If it is a wallet, use solana_wallet_tokens; if it is a token account, its `mint` field ' +
          'names the mint to query here.',
        providers_tried: attempts,
      };
    }
    return { ...upstreamDown(fail), mint, providers_tried: attempts, hint: HOLDERS_UPSTREAM_HINT };
  }
  use(supplyOut);
  const supply = (supplyOut.value as { value?: LargestAccount }).value;
  const supplyRaw = supply?.amount ? BigInt(supply.amount) : 0n;
  const decimals = supply?.decimals ?? 0;

  // 2. The largest token accounts. The validator returns its top 20; some
  //    endpoints (apiVersion >= 2.x) return up to 100.
  let largestOut: RpcResult;
  try {
    largestOut = await rpc('getTokenLargestAccounts', [mint], { providers: MINT_PROVIDERS, timeoutMs: 15_000 });
  } catch (e) {
    const fail = e as RpcFailure;
    attempts.push(...fail.attempts);
    return { ...upstreamDown(fail), mint, providers_tried: attempts, hint: HOLDERS_UPSTREAM_HINT };
  }
  use(largestOut);
  const largest = ((largestOut.value as { value?: LargestAccount[] }).value ?? []).slice(0, limit);
  const available = ((largestOut.value as { value?: LargestAccount[] }).value ?? []).length;

  // 3. Owner wallet of each token account. One getMultipleAccounts per 100
  //    addresses (the RPC's per-call cap). A failure here degrades to owner:null
  //    rather than losing the balances we already have.
  const ownerByAccount = new Map<string, { owner: string | null; program: string | null; state: string | null }>();
  let ownerLookupError: string | null = null;
  for (let i = 0; i < largest.length; i += 100) {
    const chunk = largest.slice(i, i + 100).map((a) => a.address);
    try {
      const out = await rpc('getMultipleAccounts', [chunk, { encoding: 'jsonParsed' }], {
        providers: MINT_PROVIDERS,
        timeoutMs: 15_000,
      });
      use(out);
      const infos = ((out.value as { value?: Array<ParsedAccountInfo | null> }).value ?? []);
      infos.forEach((info, idx) => {
        const parsed = info?.data?.parsed?.info;
        ownerByAccount.set(chunk[idx], {
          owner: parsed?.owner ?? null,
          program: info?.data?.program ?? null,
          state: parsed?.state ?? null,
        });
      });
    } catch (e) {
      const fail = e as RpcFailure;
      attempts.push(...fail.attempts);
      ownerLookupError = fail.message;
    }
  }

  const pct = (raw: string): number | null => {
    if (supplyRaw === 0n) return null;
    // Two extra decimals of precision on the percentage, computed in integers.
    return Number((BigInt(raw) * 1_000_000n) / supplyRaw) / 10_000;
  };
  let topRaw = 0n;
  const holders = largest.map((a, idx) => {
    topRaw += BigInt(a.amount);
    const o = ownerByAccount.get(a.address);
    return {
      rank: idx + 1,
      owner: o?.owner ?? null,
      token_account: a.address,
      amount: a.amount,
      ui_amount: a.uiAmount ?? Number(a.uiAmountString ?? 0),
      pct_of_supply: pct(a.amount),
      program: o?.program ?? null,
      state: o?.state ?? null,
    };
  });
  const topPct = supplyRaw === 0n ? null : Number((topRaw * 1_000_000n) / supplyRaw) / 10_000;

  return {
    found: holders.length > 0,
    mint,
    decimals,
    supply: supply ? { amount: supply.amount, ui_amount: supply.uiAmount ?? Number(supply.uiAmountString ?? 0) } : null,
    returned: holders.length,
    largest_accounts_available: available,
    top_holders_pct_of_supply: topPct,
    holders,
    owner_lookup_error: ownerLookupError,
    note:
      'Ranked by token-account balance; `owner` is the wallet (or program) that controls each account, so one ' +
      'wallet holding several accounts of this mint appears once per account, and the largest owners are often ' +
      'exchanges, custodians, liquidity pools or bridges rather than individuals. Solana RPC returns at most ' +
      `${available} largest accounts for this mint from the endpoint that answered — deeper holder lists need an ` +
      'indexer (birdeye, solscan or helius, with a key). Percentages are of current total supply.',
    providers_tried: attempts,
    provider: providersUsed.join(','),
    source: 'Solana JSON-RPC getTokenLargestAccounts + getTokenSupply + getMultipleAccounts',
  };
}

const HOLDERS_UPSTREAM_HINT =
  'Every public Solana RPC endpoint refused or timed out on the largest-accounts call — most public nodes block ' +
  'or throttle getTokenLargestAccounts specifically. Retry shortly; a dedicated endpoint requires an API key ' +
  '(the birdeye, solscan and helius packs take yours and cover token holders).';

async function rpcHealth() {
  // The system program owns no token accounts, so this is a cheap way to ask a
  // provider whether it serves account scans at all.
  const SCAN_PROBE = '11111111111111111111111111111111';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const results: Array<Record<string, unknown>> = [];
  for (const provider of PROVIDERS) {
    const row: Record<string, unknown> = { provider: provider.name };
    for (const [label, method, params] of [
      ['slot', 'getSlot', []],
      ['token_scan', 'getTokenAccountsByOwner', [SCAN_PROBE, { programId: SPL_TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]],
      ['largest_accounts', 'getTokenLargestAccounts', [USDC_MINT]],
    ] as Array<[string, string, unknown[]]>) {
      const started = Date.now();
      try {
        const r = await rpcOnce(provider, method, params, 10_000);
        row[`${label}_ok`] = true;
        row[`${label}_ms`] = Date.now() - started;
        if (label === 'slot') row.slot = r.value;
      } catch (e) {
        row[`${label}_ok`] = false;
        row[`${label}_error`] = (e as Error).message.slice(0, 200);
        row[`${label}_ms`] = Date.now() - started;
      }
    }
    results.push(row);
  }
  return {
    found: true,
    providers: results,
    order: PROVIDERS.map((p) => p.name),
    refused_pairs: [...METHOD_REFUSED],
    note:
      'Measured from wherever this tool ran. Public Solana endpoints vary by caller IP and by method — an ' +
      'endpoint that answers a laptop can refuse a datacenter, which is why calls walk this list in order ' +
      'and take the first provider that serves the method.',
    source: 'Live probe of each configured public Solana JSON-RPC endpoint',
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'solana_wallet_tokens',
    description:
      'SPL token holdings of a Solana wallet: mint address, token balance, decimals and token-account address for ' +
      'every position, sorted largest first, covering both the SPL Token and Token-2022 programs. Answers "which ' +
      'tokens does this Solana address hold and how much of each". Sourced live from public Solana JSON-RPC ' +
      '(getTokenAccountsByOwner). Zero balances are dropped and results paginate, because a busy wallet can hold ' +
      'thousands of token accounts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: { type: 'string', description: 'Base58 Solana wallet address (32-44 chars)' },
        limit: { type: 'number', description: 'Holdings per page, 1-200 (default 25)' },
        offset: { type: 'number', description: 'Page offset into the balance-sorted list (default 0)' },
        min_amount: { type: 'number', description: 'Keep only holdings at or above this token balance' },
        include_zero: { type: 'boolean', description: 'Include emptied token accounts (default false)' },
        program: {
          type: 'string',
          enum: ['both', 'token', 'token-2022'],
          description: 'Which token program to scan (default both)',
        },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'solana_wallet_balance',
    description:
      'Native SOL balance of a Solana address, in lamports and SOL, with the slot it was read at. Answers "how ' +
      'much SOL does this address hold". Sourced live from public Solana JSON-RPC (getBalance).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: { type: 'string', description: 'Base58 Solana wallet address (32-44 chars)' },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'solana_wallet_transactions',
    description:
      'Recent transaction history for a Solana address: signature, slot, block time, success or failure, and memo ' +
      'for each transaction, newest first, with a cursor for paging further back. Answers "what has this Solana ' +
      'wallet done lately". Sourced live from public Solana JSON-RPC (getSignaturesForAddress).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet: { type: 'string', description: 'Base58 Solana wallet address (32-44 chars)' },
        limit: { type: 'number', description: 'Signatures to return, 1-100 (default 20)' },
        before: { type: 'string', description: 'Signature to page backwards from (from next_before)' },
        until: { type: 'string', description: 'Stop when this signature is reached' },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'solana_transaction',
    description:
      'Details of one Solana transaction by signature: block time, slot, fee, success or failure, signers, the ' +
      'programs and instruction types it invoked, SOL balance changes per account, and SPL token balances before ' +
      'and after. Answers "what did this Solana transaction actually do". Sourced live from public Solana ' +
      'JSON-RPC (getTransaction).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        signature: { type: 'string', description: 'Base58 transaction signature (~88 chars)' },
      },
      required: ['signature'],
    },
  },
  {
    name: 'solana_token_holders',
    description:
      'Top holders of a Solana SPL token by mint address: the largest token accounts ranked by balance, each ' +
      'with its owner wallet address, token-account address, raw and decimal balance and percentage of total ' +
      'supply, plus the mint\'s total supply, decimals and the share the top holders control together. Answers ' +
      '"who are the biggest holders of this Solana token" and "how concentrated is its supply". Sourced live ' +
      'from public Solana JSON-RPC (getTokenLargestAccounts, getTokenSupply, getMultipleAccounts); up to 20 ' +
      'holders from most endpoints, up to 100 where the node allows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mint: { type: 'string', description: 'Base58 SPL token mint address (e.g. USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)' },
        limit: { type: 'number', description: 'Holders to return, 1-100 (default 20; the RPC caps what it serves)' },
      },
      required: ['mint'],
    },
  },
  {
    name: 'solana_rpc_health',
    description:
      'Live reachability of each public Solana JSON-RPC endpoint this pack uses, per method: current slot, ' +
      'whether token-account scans are served, latency and the exact error text when one refuses. Answers "which ' +
      'Solana endpoint is answering right now, and for which calls" — useful when a wallet lookup comes back ' +
      'empty and you want to tell an endpoint block apart from an idle wallet.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'solana_wallet_tokens':
      return walletTokens(args);
    case 'solana_wallet_balance':
      return walletBalance(args);
    case 'solana_wallet_transactions':
      return walletTransactions(args);
    case 'solana_transaction':
      return transaction(args);
    case 'solana_token_holders':
      return tokenHolders(args);
    case 'solana_rpc_health':
      return rpcHealth();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
