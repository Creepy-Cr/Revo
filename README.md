<p align="center">
  <a href="https://therevo.xyz">
    <img src="docs/assets/readme-banner.png" alt="Revo. Autonomous treasury intelligence, built on Arc." width="100%" />
  </a>
</p>

<h1 align="center">Revo</h1>

<p align="center">
  Plain-English policy in. Enforced, on-chain settlement out.<br />
  An AI treasury agent that can only act inside the lines you set, settling in USDC on Arc.
</p>

<p align="center">
  <a href="https://arc.network"><img alt="Built on Arc" src="https://img.shields.io/badge/Built%20on-Arc-FC3B00?style=flat-square" /></a>
  <a href="https://therevo.xyz"><img alt="Live at therevo.xyz" src="https://img.shields.io/badge/live-therevo.xyz-111111?style=flat-square" /></a>
  <a href="https://github.com/Creepy-Cr/Revo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Creepy-Cr/Revo/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="./LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-2A2A2A?style=flat-square" /></a>
  <a href="https://x.com/RevoLabsHQ"><img alt="Follow on X" src="https://img.shields.io/badge/X-%40RevoLabsHQ-000000?style=flat-square&logo=x&logoColor=white" /></a>
  <img alt="Arc mainnet" src="https://img.shields.io/badge/network-Arc%20mainnet-6B6B6B?style=flat-square" />
</p>

<p align="center">
  <a href="https://therevo.xyz">Website</a> ·
  <a href="https://therevo.xyz/app">Console</a> ·
  <a href="https://therevo.xyz/docs">Product docs</a> ·
  <a href="./docs/architecture/README.md">Architecture</a> ·
  <a href="https://therevo.xyz/risk">Risk disclosure</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./SECURITY.md">Security</a>
</p>

---

## What Revo is

Most treasuries, from a DAO with millions to a solo builder with 500 USDC, are managed the
same way: someone remembers to move money, someone else has to approve it, and nobody can say
exactly what the rules are. Revo replaces that with three things:

1. **An agent you talk to.** Arcus, the treasury agent, turns an instruction like
   "keep at least 40% liquid and never put more than a quarter into euro exposure" into a
   policy draft with concrete numbers.
2. **A policy engine that does not trust the agent.** Every number the model produces is
   clamped to server-side guardrails before it becomes a proposal. The model never signs, never
   broadcasts and never sees a key.
3. **Real settlement on Arc.** Deposits, withdrawals and approved rebalances are real
   transactions on Arc mainnet, paid for in USDC, confirmed from receipts and reconciled by
   background workers that survive restarts.

Revo custodies and moves real tokens on Arc mainnet: USDC, EURC, syrupUSDC, cirBTC and WETH,
plus wARS which it holds and values but never trades. The chain guard refuses any chain
other than Arc (chain id `5042`). Use involves smart contract, custody, stablecoin, liquidity
and operational risk, including possible loss of funds.

<p align="center">
  <img src="docs/assets/console.jpg" alt="The Revo treasury console with the Arcus agent panel open" width="100%" />
  <br />
  <sub>The operator console: net asset value, deployed capital, risk score, NAV history, live allocations, and Arcus explaining the current state.</sub>
</p>

## How it works

| Step | What happens | Who or what is in control |
| --- | --- | --- |
| **Instruct** | A strategist types an instruction in plain English. Arcus (OpenAI) compiles it into a structured policy draft. | Human writes, model drafts |
| **Decide** | The deterministic policy engine clamps allocation, reserve and drawdown targets to hard limits, then opens a proposal. An approver approves or rejects. In Autonomous mode, in-policy rebalance drafts are approved automatically. | Server enforces, human approves |
| **Settle** | An approved rebalance is quoted on Uniswap v4, preflighted, signed by the treasury's custody key, broadcast on Arc and confirmed from the receipt. Deposits and withdrawals move real USDC the same way. | Custody key, under pause and cap checks |
| **Control** | Guardians can drop the treasury into Safe mode or trigger the emergency pause at any time. Everything is written to a hash-chained audit trail. Arcus can explain any of it, but cannot override any of it. | Human, always |

The short version: **the model drafts, the engine clamps, a human approves, Arc settles.**

## Built on Arc

Revo is built on [Arc](https://arc.network), Circle's Layer 1 for stablecoin finance. Arc is
the reason a treasury product like this can be simple:

- **USDC is the native gas token.** A treasury never has to hold a separate volatile asset just
  to pay fees. Revo checks spendable USDC, not just held USDC, before every send.
- **A pinned token registry, not a token list.** Revo trades only tokens whose contract
  address is confirmed against the issuer's own documentation or the Arc registry: native
  USDC and EURC (Circle), syrupUSDC (Maple), cirBTC (Circle) and WETH (Arc bridge). wARS
  (Ripio) is held and valued at the official BCRA rate but never traded, because the Arc pool
  sits about 5% away from the only independent reference. Tokens named after stocks or
  companies on Arc's venue are anonymous mints and are refused outright.
- **Circle Gateway** gives the custody wallet a unified USDC balance view across every
  Gateway-supported chain, read through Circle App Kit and shown per chain in the console.
- **Deterministic finality and predictable fees**, which is what lets settlement reconcile
  from receipts rather than from hope.

| Arc mainnet | Value |
| --- | --- |
| Chain id | `5042` |
| RPC | Multiple public Arc mainnet providers with automatic failover; optional `ARC_RPC_URLS` supplies a comma-separated override list |
| Explorer | [explorer.arc.io](https://explorer.arc.io) |
| Native USDC | [`0x3600000000000000000000000000000000000000`](https://explorer.arc.io/address/0x3600000000000000000000000000000000000000) (6 decimals) |
| EURC | [`0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`](https://explorer.arc.io/address/0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1) (6 decimals) |
| syrupUSDC | [`0x0dC6b79F3c3854E4d74514fD4d29BE6c96Beee39`](https://explorer.arc.io/address/0x0dC6b79F3c3854E4d74514fD4d29BE6c96Beee39) (6 decimals, Maple) |
| cirBTC | [`0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`](https://explorer.arc.io/address/0x171A4217b86A807A64eB94757Db6849fb4bDbAA0) (8 decimals, Circle) |
| WETH | [`0x128cC466B61f542da60c70e3aA11c10e19B84EDB`](https://explorer.arc.io/address/0x128cC466B61f542da60c70e3aA11c10e19B84EDB) (18 decimals, Arc bridge) |
| wARS | [`0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D`](https://explorer.arc.io/address/0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D) (held only, never traded) |
| Pinned pools | Every pool has USDC on one side and no hook: EURC/USDC (`fee 10, 100, 500, 3000, 10000`), syrupUSDC/USDC (`fee 500`), cirBTC/USDC (`fee 3000`), WETH/USDC (`fee 2500`), wARS/USDC (`fee 100`, read only). Every rebalance is one swap per proposal; a target that needs more than one leg (any risk-to-risk move goes through USDC) is walked leg by leg, each settled proposal saying whether the target is reached and drafting the next leg from live balances. Managed mode approves each leg; Autonomous mode auto-approves them under the same gates, at most 12 an hour per policy. |
| Swap venue | Uniswap v4: PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, V4Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`, StateView `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b`, UniversalRouter `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Token registry | [Tower Exchange](https://docs.tower.exchange) public API, used as a secondary cross-check of token addresses; it never authorises a trade |

Useful Arc links: [Arc docs](https://docs.arc.network) ·
[Connect to Arc](https://docs.arc.network/arc/references/connect-to-arc) ·
[Circle Gateway](https://developers.circle.com/gateway) ·
[Circle developer docs](https://developers.circle.com)

### Proof of mainnet execution

Everything below is public and can be checked on [explorer.arc.io](https://explorer.arc.io) or over
any Arc mainnet RPC. On 22 September 2026 the product's own proposal path (approve, size from
live balances, quote the pool, check the independent price, simulate, sign, confirm, reconcile)
executed one buy and one sell-back through each pinned pool from a treasury holding about
3 USDC. Every fill landed at quote and the whole round trip cost about 0.07 USDC in gas.

Custody wallet (the `from` address on every transaction):
[`0x2BD4A80730b8cA21D1d523564C58D1B048583Ac0`](https://explorer.arc.io/address/0x2BD4A80730b8cA21D1d523564C58D1B048583Ac0)

| Pool | Buy | Sell back |
| --- | --- | --- |
| EURC/USDC | [`0xd31f6ae3`](https://explorer.arc.io/tx/0xd31f6ae3dac37e88aae4e153d7ba6f70ec426998da08a80d9edee885623319aa) | [`0xb12bc4a7`](https://explorer.arc.io/tx/0xb12bc4a79d88f0688b052e3f72efee151b36735d3d81af690b7cfe209345448b) |
| syrupUSDC/USDC | [`0xe4409f4b`](https://explorer.arc.io/tx/0xe4409f4b7f76d57ddd30544aeb15373a3d0240c8e97c0160ad59acb5dff7489f) | [`0x8d2cddbb`](https://explorer.arc.io/tx/0x8d2cddbb7ebfb7e9d593c88471e78c8fd708b21f2dfd195d608c819186997d06) |
| cirBTC/USDC | [`0x4aedd907`](https://explorer.arc.io/tx/0x4aedd907a11261240a08720094acb2124d3a364290af94e4423c28bbc69cf8d8) | [`0x5e784552`](https://explorer.arc.io/tx/0x5e784552cc9778326ff5fab7a4e61d4a8b1ecc260e794d482c9152c1fc5a0af9) |
| WETH/USDC | [`0xd77b2884`](https://explorer.arc.io/tx/0xd77b28849cb74226e4617a52e005f9ab807f04a459a289adb85152c1602f6d5b) | [`0x82ebf6a9`](https://explorer.arc.io/tx/0x82ebf6a9338ecdc7ea49495fc1ed39170bb2172b87f2db019a937105726a8323) |

Each transaction is a Uniswap v4 swap through the UniversalRouter listed above, paid for in
USDC, with the swap's transfer logs used to measure the realised fill. Nothing here is a
simulation: the only simulated feature in Revo is the risk drill, and it says so on screen.

## Architecture

<p align="center">
  <a href="docs/architecture/README.md">
    <img src="docs/architecture/revo-architecture.png" alt="Revo system architecture: identity, decision and settlement planes plus durable workers" width="100%" />
  </a>
</p>

Four planes, one database, no shared mutable state outside PostgreSQL:

- **Identity.** Any injected wallet (EIP-6963). The wallet signs a server nonce (EIP-191), the
  server issues an HttpOnly session scoped to exactly one treasury. Enabling autonomous
  execution and lifting the emergency pause require a sign-in less than 15 minutes old.
- **Decision.** Express 5 API. Arcus compiles and explains; the policy engine clamps; proposals
  move through draft, approve, settle and reconcile. One active policy per treasury.
- **Settlement.** Per-treasury custody wallet with the key sealed under AES-256-GCM envelope
  encryption and unsealed in memory only for a single signing call. Deposits are indexed from
  logs at 12 confirmations with reorg rewind. Withdrawals reserve balance under a lock, re-check
  the pause under the same lock, sign locally and broadcast. Rebalances quote, preflight, set
  the token allowance, swap, persist the transaction hash before broadcast and read the
  realised fill from the receipt.
- **Durable workers.** A single leader elected by lease with fencing, ticking every 15 seconds:
  `deposit-indexer` (30 s), `withdrawal-reconciler` (30 s), `rebalance-reconciler` (30 s) and
  `drawdown-monitor` (60 s). A restart mid-settlement is picked up rather than lost: a swap
  that was broadcast is confirmed or returned to pending from its receipt, one that never
  broadcast is returned to pending, and one Arc has no record of is flagged for manual review
  instead of being re-sent.

### Custody and limits

- Each treasury uses a server-side sealed key. The signer allowlist permits only transfers
  and approvals of pinned tokens, Permit2 approvals and UniversalRouter execution.
- The emergency pause is re-checked at signing. Rebalances have absolute USD caps per trade and
  per day, and signing refuses stale prices or a token whose issuer has paused it or blocked
  the wallet. Only the controls each issuer contract really exposes are read.
- Swaps allow at most 1% price impact, 2% reference-price deviation, 30 bps slippage and 10% of
  the pool's 2% depth. The deadline is 180 seconds, and exact-amount Permit2 approvals expire
  with the swap.
- Ledger balances are reconciled against chain balances. A shortfall pauses execution.

The full write-up, including the custody model and what is real versus displayed, is in
[`docs/architecture`](./docs/architecture/README.md). The diagram is maintained as SVG and
re-rendered with `pnpm --filter @workspace/scripts run render-architecture`.

## Features

**Arcus, the treasury agent**
- Natural-language policy compilation with the numbers clamped server-side
- Grounded Q&A over live treasury state, signals and recent activity
- No execution authority: it cannot approve, sign, pause or change modes

**Deterministic policy engine**
- Allocation caps 5 to 35% per sleeve, liquid reserve 25 to 80%, max drawdown 5 to 30%
- Risk sleeve sized by risk tolerance (4, 10 or 16%), split across EURC, syrupUSDC, cirBTC and
  WETH by policy weights (whole sleeve in EURC when none are given), 1 percentage point drift threshold
- One active policy, superseding the previous one; every proposal carries its rationale

**Custody and settlement on Arc**
- Per-treasury EOA, envelope-encrypted, never persisted in plaintext
- Real USDC deposits and withdrawals with confirmation depth, reorg handling and refunds
- Real swaps through Uniswap v4, always with USDC on one side, with price impact and pool share limits, gas paid in USDC
- Circle Gateway unified balance reads, per chain, through Circle App Kit

**Controls operators actually have**
- Operating modes: Safe, Managed and Autonomous
- Emergency pause that blocks withdrawals, approvals and autonomous execution
- Withdrawal caps per transaction, per wallet per 24 h and global per 24 h
- Role-based access with five roles and a fresh sign-in requirement for the riskiest changes
- Hash-chained audit trail, alerts and an exploit drill that rehearses the response without touching funds

**Signals and monitoring**
- CoinGecko market data and Frankfurter official FX fixes, with 24 h momentum and USDC peg deviation, scored into 0 to 100 composites
- Arc whale watch on USDC transfers, issuer GitHub activity, crypto news RSS
- Optional X and Discord feeds; a drawdown monitor that alerts when the active policy's limit is breached

## Operating modes and roles

| Mode | What the agent may do | What humans must do |
| --- | --- | --- |
| **Safe** | Nothing that changes state. Policies and proposals are review-only. | Everything |
| **Managed** | Draft policies and rebalance proposals. | Approve every proposal |
| **Autonomous** | Draft and auto-approve rebalance proposals that sit inside the active policy. | Set the policy, watch the audit trail, pause if needed |

| Role | Can |
| --- | --- |
| **Viewer** | Read the console and ask Arcus |
| **Strategist** | Everything a viewer can, plus issue commands, request swap quotes and run drills |
| **Approver** | Approve or reject policies and proposals |
| **Guardian** | Switch the treasury to Safe mode and activate the emergency pause |
| **Admin** | Everything, including operators, withdrawal caps, lifting the pause and enabling Managed or Autonomous mode |

Every role can read the security page and acknowledge alerts. Enabling Autonomous mode and
lifting the pause both require a session that is less than 15 minutes old.

## Repository layout

```
.
├── artifacts/
│   ├── revo-treasury/        React + Vite web app: marketing site, docs, legal pages and the console
│   ├── api-server/           Express 5 API: auth, policy engine, custody, settlement, workers
│   ├── revo-demo-video/      Product demo video rendered from React
│   ├── revo-intro-film/      Introduction film rendered from React
│   └── mockup-sandbox/       Design preview sandbox for isolated component previews
├── lib/
│   ├── api-spec/             OpenAPI contract (source of truth) and orval codegen config
│   ├── api-zod/              Generated Zod schemas shared by server and client
│   ├── api-client-react/     Generated React Query client
│   ├── db/                   Drizzle ORM schema and PostgreSQL connection
│   └── integrations-anthropic-ai/  Legacy package; Arcus no longer uses it
├── scripts/                  Maintenance scripts (architecture diagram render, post-merge setup)
└── docs/                     Architecture write-up, diagram source and README assets
```

The repo is a pnpm workspace with TypeScript project references. Contract first: routes are
described in `lib/api-spec`, and both the server-side validators and the browser client are
generated from it.

## Getting started

### Prerequisites

- Node 22 (20.19 or newer also works) and pnpm 10
- Linux x64, or WSL on Windows. The lockfile pins native binaries to Linux x64 because that is
  what the hosted environment runs; on macOS or ARM, remove the platform `overrides` block in
  `pnpm-workspace.yaml` before `pnpm install` (see the note there)
- PostgreSQL (any recent version; a connection string is enough)
- An OpenAI API key for external hosting, or the Replit OpenAI integration for local previews
- A browser wallet (MetaMask, Rabby, Phantom or OKX) with Arc mainnet added and real USDC

### Install and run

```bash
git clone https://github.com/Creepy-Cr/Revo.git
cd Revo
pnpm install

# Apply the schema to your database
export DATABASE_URL=postgres://user:pass@localhost:5432/revo
pnpm --filter @workspace/db push

# Terminal 1: API on http://localhost:8080
export CUSTODY_MASTER_SECRET=$(openssl rand -hex 32)
export OPENAI_API_KEY=...
PORT=8080 pnpm --filter @workspace/api-server run dev

# Terminal 2: web app on http://localhost:5173, forwarding /api to the API
PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:8080 pnpm --filter @workspace/revo-treasury run dev
```

The browser calls the API over relative `/api/...` URLs so that one build works everywhere. In
development the two servers are on different ports, so the Vite dev server forwards `/api` to
`API_PROXY_TARGET`; the session cookie stays same-origin and `http://localhost:5173` is already
an allowed origin outside production.

Open the console, connect a wallet on Arc mainnet and sign the nonce. A first-time wallet gets
its own treasury provisioned on the spot and becomes its admin.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | yes | Port for the API server and, separately, the Vite dev server |
| `BASE_PATH` | web only | Base path the web app is served from (`/` locally) |
| `API_PROXY_TARGET` | web, local only | API origin the Vite dev server forwards `/api` to, for example `http://localhost:8080` |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `CUSTODY_MASTER_SECRET` | yes in production | Master secret (16+ chars) for custody key envelope encryption. Outside production `SESSION_SECRET` is accepted as a fallback |
| `SESSION_SECRET` | no | Development-only fallback for `CUSTODY_MASTER_SECRET`. Sessions themselves are random database-backed tokens and need no signing key |
| `OPENAI_API_KEY` | yes for external hosting | Direct OpenAI API key for Arcus; store only on the API host |
| `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL` | alternative in Replit | Automatically provisioned Replit OpenAI proxy credentials for development |
| `OPENAI_POLICY_MODEL`, `OPENAI_CHAT_MODEL` | no | Optional OpenAI model overrides; both default to `gpt-5.6-terra` |
| `WORKER_ENABLED` | no | Worker runs by default in production and stays off in development; set `false` for a production pause or `true` to opt in during development |
| `ARC_RPC_URLS` | no | Comma-separated Arc mainnet RPC override list; otherwise the built-in public providers use automatic failover |
| `ALERT_WEBHOOK_URL` | no | POST target for operator alerts; Slack and private-channel Discord incoming webhooks are supported. Treat the URL as a secret |
| `REBALANCE_MAX_USD_PER_TRADE` | no | Absolute rebalance cap per trade, defaults to `25000` |
| `REBALANCE_MAX_USD_PER_DAY` | no | Absolute rebalance cap per rolling day, defaults to `100000` |
| `APP_ORIGINS` | production | Comma-separated browser origins allowed to call the API |
| `OWNER_WALLET_ADDRESSES` | no | Wallets that are admins of the founding treasury |
| `DRAWDOWN_AUTO_DERISK` | no | `true` records when the automatic de-risk gate is reached in Autonomous mode. Execution is not armed; no trade is made |
| `WHALE_THRESHOLD_USDC` | no | Whale watch threshold, defaults to `10000` |
| `TOWER_API_KEY` | no | Enables the Tower token registry cross-check on swap quotes |
| `X_API_BEARER_TOKEN` | no | Enables the X signal feed |
| `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_IDS` | no | Enables the Discord community signal |
| `JSON_BODY_LIMIT` | no | Request body limit, defaults to `256kb` |
| `LOG_LEVEL` | no | pino log level, defaults to `info` |
| `NODE_ENV` | no | `production` tightens cookies, origins and secrets checks |

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm run typecheck` | Typechecks the whole workspace (libs by project reference, then every artifact) |
| `pnpm run build` | Typecheck, then build every package that has a build step |
| `pnpm run test` | Runs the API test suite with vitest (integration tests need `DATABASE_URL`) |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerates the Zod schemas and React client from the OpenAPI spec |
| `pnpm --filter @workspace/db push` | Applies the Drizzle schema to the database |
| `pnpm --filter @workspace/scripts run render-architecture` | Re-renders the architecture PNG from its SVG |
| `pnpm run format` | Formats the repo with Prettier |

## Testing

```bash
pnpm run test
```

The suite covers the policy contract, rebalance planning and settlement, Uniswap v4 and Tower
quoting, App Kit reads, auth origin checks, withdrawal caps, the custody lock, worker fencing
and the dashboard and proposal routes. Route and worker tests run against a real PostgreSQL
database and stub the chain, so `DATABASE_URL` must point at a database you are happy to write
to. CI runs the pure unit suites on every push and pull request.

## Deploy the website to Vercel

The repository-root `vercel.mjs` builds **only the static web app** from
`artifacts/revo-treasury`. Import this repository into Vercel with **Root
Directory = repository root (`.`)**; leave the build and output settings on
their repository defaults so `vercel.mjs` supplies them. The configuration
installs dependencies with pnpm, builds the prerendered public pages and
client-only console, and maps `/docs`, `/privacy`, `/terms`, `/risk`, `/app`
and `/dashboard` (including trailing slashes) to the right HTML files.
No `PORT` or `BASE_PATH` build variables are needed. The two video artifacts
are not included in this website deployment.

For a **functional console**, run the existing Express API and its durable
worker on a persistent Node host with PostgreSQL. Do **not** deploy
`artifacts/api-server/src/index.ts` as a Vercel Function: the 15-second worker,
leases, on-chain reconciliation and in-flight settlement require a continuously
running process. Set `REVO_API_ORIGIN` in the Vercel project's environment to
the backend's **HTTPS origin only**, such as `https://api.example.com` (no
`/api` suffix). At build time the Vercel config then rewrites `/api/*` to that
backend, keeping browser requests and the HttpOnly session cookie same-origin.
Without `REVO_API_ORIGIN`, the website and console shell deploy, but `/api/*`
does not exist and wallet sign-in and live data will not work.

On the API host set `APP_ORIGINS` to the exact Vercel frontend origin(s);
the **first** entry is embedded in the wallet sign-in message. Also configure
the backend's `DATABASE_URL`, dedicated `CUSTODY_MASTER_SECRET`, and
`OPENAI_API_KEY` (or the Replit OpenAI integration in development). Verify the backend
health endpoint and wallet sign-in on the intended domain **before** enabling
any live treasury operation. Vercel preview deployments use changing hostnames;
add their exact origins to `APP_ORIGINS` if sign-in is needed there. Never place
custody or AI secrets in `VITE_*` variables or in the Vercel frontend project.

### Run the API and worker on Railway

Deploy the API and worker as **one persistent service**. The API's production
start script starts the 15-second worker automatically; do not create a second
worker service or a Railway cron job. Railway's legacy `railway.json` Config as
Code is not available for new services, so set the service options in Railway
(or manage them with Railway's current Infrastructure as Code workflow).

1. Connect the repository to a Railway service. Keep **Root Directory** at the
   repository root (`/`) so pnpm can install workspace dependencies. Select
   Railpack; set **Build Command** to
   `pnpm --filter @workspace/api-server run build` and **Start Command** to
   `NODE_ENV=production pnpm --filter @workspace/api-server run start`.
   Railway supplies `PORT`. Leave **Serverless** (app sleeping) disabled,
   leave the cron schedule empty, and initially run **one replica**. Set
   **Healthcheck Path** to `/api/healthz`, **Healthcheck Timeout** to 300
   seconds, and **Restart Policy** to Always. Give the service a public HTTPS
   domain for the Vercel `/api` rewrite.
2. Provision PostgreSQL separately (a Railway Postgres service or an existing
   managed database, such as Supabase). Set the API service's `DATABASE_URL`
   to its **PostgreSQL connection string**, not a Supabase Data API URL or
   publishable key, in Railway variables. Check the target and take a backup
   before applying the schema. Review and run
   `pnpm --filter @workspace/db push` **manually against that database before
   starting the API**; never push schema on every deploy.
3. In the Railway API service variables, set `CUSTODY_MASTER_SECRET` (a stable,
   dedicated production secret of at least 16 characters), `APP_ORIGINS`
   (comma-separated exact frontend origins, with the primary production URL
   first), and `OPENAI_API_KEY` (a direct OpenAI key for Railway). The start command forces
   `NODE_ENV=production`; `SESSION_SECRET` is **not** a production custody
   fallback. If migrating existing sealed treasury keys, preserve the original
   custody master secret or those keys cannot be opened. Optional values
   including `ARC_RPC_URLS` and `ALERT_WEBHOOK_URL` are described in the table
   below.
4. Check `https://<railway-api-domain>/api/healthz`. It returns 503 when
   required database, Arc RPC, or swap venue checks fail, so Railway will not
   mark an unhealthy deployment as ready. It can report `degraded` with HTTP
   200 for optional feeds. Then set `REVO_API_ORIGIN` in Vercel to that HTTPS
   origin **without `/api`**, redeploy the website, and verify same-origin
   `/api/healthz` and wallet sign-in. Do not test deposits, withdrawals, or
   swaps with real funds merely to validate deployment.

The worker starts as soon as the API listens, including before Railway's health
check passes. Configure and verify the intended database, environment, and Arc
mainnet custody controls **before the first production start**. No private keys
or database URLs belong in Git, Vercel's public frontend variables, or chat.

## Deployment

<p align="center">
  <a href="https://therevo.xyz">
    <img src="docs/assets/landing.jpg" alt="The Revo landing page at therevo.xyz" width="720" />
  </a>
</p>

The public instance at [therevo.xyz](https://therevo.xyz) runs on Replit. The API listens on
port 8080 with a health check at `/api/healthz`, and the web app is served as a static build
from `artifacts/revo-treasury/dist/public` with per-page rewrites so deep links and the
prerendered marketing pages work. Any host that can run a Node process, serve static files and
route `/api` to the process will do.

For production set `NODE_ENV=production`, a dedicated `CUSTODY_MASTER_SECRET`, `APP_ORIGINS`
and run a single API instance or rely on the worker lease if you run several; only one leader
runs the background jobs at a time.

## Security

Revo is pre-release software that moves real funds on Arc mainnet. It includes server-side clamps,
custody key sealing, pause and cap checks under locks, a chain guard and a hash-chained audit, but it
has not been independently audited. Please read the [risk disclosure](https://therevo.xyz/risk)
before using it for anything beyond experimentation, and report vulnerabilities privately as
described in [SECURITY.md](./SECURITY.md).

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for the
local setup, conventions and the areas that need extra care. Please follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Links

- Website: [therevo.xyz](https://therevo.xyz)
- Product docs: [therevo.xyz/docs](https://therevo.xyz/docs)
- Risk disclosure: [therevo.xyz/risk](https://therevo.xyz/risk)
- X: [@RevoLabsHQ](https://x.com/RevoLabsHQ)
- Arc: [arc.network](https://arc.network) · [docs](https://docs.arc.network) · [explorer](https://explorer.arc.io)
- Circle: [Gateway](https://developers.circle.com/gateway) · [developer docs](https://developers.circle.com)
- Venue and registry: [Uniswap v4 Arc deployments](https://docs.uniswap.org/contracts/v4/deployments) · [Tower Exchange](https://docs.tower.exchange)
- Model: [OpenAI](https://platform.openai.com/docs)

## Licence

[MIT](./LICENSE) © 2026 Revo Labs. Built on Arc.

---

<p align="center">
  <a href="https://x.com/Cr3ePy_007"><img alt="Built by @Cr3ePy_007" src="https://img.shields.io/badge/Built%20by-%40Cr3ePy__007-000000?style=flat-square&logo=x&logoColor=white" /></a>
  <a href="https://x.com/RevoLabsHQ"><img alt="Follow Revo on X" src="https://img.shields.io/badge/Revo-%40RevoLabsHQ-000000?style=flat-square&logo=x&logoColor=white" /></a>
  <a href="https://arc.network"><img alt="Built on Arc" src="https://img.shields.io/badge/Built%20on-Arc-FC3B00?style=flat-square" /></a>
</p>

<p align="center">
  <sub>
    Built by <a href="https://x.com/Cr3ePy_007"><strong>@Cr3ePy_007</strong></a>
    &nbsp;·&nbsp; Follow Revo on <a href="https://x.com/RevoLabsHQ"><strong>@RevoLabsHQ</strong></a>
    &nbsp;·&nbsp; Questions and feedback are welcome in
    <a href="https://github.com/Creepy-Cr/Revo/issues">issues</a>
  </sub>
</p>
