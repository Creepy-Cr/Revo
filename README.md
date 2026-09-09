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
  <img alt="Arc Testnet only" src="https://img.shields.io/badge/network-Arc%20Testnet%20only-6B6B6B?style=flat-square" />
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
   transactions on Arc Testnet, paid for in USDC, confirmed from receipts and reconciled by
   background workers that survive restarts.

Revo is **testnet only**. No real funds are involved anywhere in this codebase, and the chain
guard refuses to talk to any network other than Arc Testnet (chain id `5042002`).

<p align="center">
  <img src="docs/assets/console.jpg" alt="The Revo treasury console with the Arcus agent panel open" width="100%" />
  <br />
  <sub>The operator console: net asset value, deployed capital, risk score, NAV history, live allocations, and Arcus explaining the current state.</sub>
</p>

## How it works

| Step | What happens | Who or what is in control |
| --- | --- | --- |
| **Instruct** | A strategist types an instruction in plain English. Arcus (Claude, via the Anthropic API) compiles it into a structured policy draft. | Human writes, model drafts |
| **Decide** | The deterministic policy engine clamps allocation, reserve and drawdown targets to hard limits, then opens a proposal. An approver approves or rejects. In Autonomous mode, in-policy rebalance drafts are approved automatically. | Server enforces, human approves |
| **Settle** | An approved rebalance is quoted on Synthra, simulated, signed by the treasury's custody key, broadcast on Arc and confirmed from the receipt. Deposits and withdrawals move real USDC the same way. | Custody key, under pause and cap checks |
| **Control** | Guardians can drop the treasury into Safe mode or trigger the emergency pause at any time. Everything is written to a hash-chained audit trail. Arcus can explain any of it, but cannot override any of it. | Human, always |

The short version: **the model drafts, the engine clamps, a human approves, Arc settles.**

## Built on Arc

Revo is built on [Arc](https://arc.network), Circle's Layer 1 for stablecoin finance. Arc is
the reason a treasury product like this can be simple:

- **USDC is the native gas token.** A treasury never has to hold a separate volatile asset just
  to pay fees. Revo checks spendable USDC, not just held USDC, before every send.
- **Circle-issued stablecoins on both sides of the book.** The two sleeves Revo rebalances
  between are native USDC and EURC, with cirBTC held and valued but not routed.
- **Circle Gateway** gives the custody wallet a unified USDC balance view across every
  Gateway-supported testnet, read through Circle App Kit and shown per chain in the console.
- **Deterministic finality and predictable fees**, which is what lets settlement reconcile
  from receipts rather than from hope.

| Arc Testnet | Value |
| --- | --- |
| Chain id | `5042002` |
| Default RPC | `https://rpc.testnet.arc.io` (override with `ARC_TESTNET_RPC_URL`) |
| Explorer | [testnet.arcscan.app](https://testnet.arcscan.app) |
| Faucet | [faucet.circle.com](https://faucet.circle.com) |
| Native USDC | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) (6 decimals) |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| cirBTC | `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` (held, not tradable) |
| Swap venue | [Synthra](https://synthra.org) router, quoter and pools on Arc Testnet |
| Token registry | [Tower Exchange](https://docs.tower.exchange) public API, used as a secondary cross-check of token addresses; it never authorises a trade |

Useful Arc links: [Arc docs](https://docs.arc.network) ·
[Connect to Arc](https://docs.arc.network/arc/references/connect-to-arc) ·
[Circle Gateway](https://developers.circle.com/gateway) ·
[Circle developer docs](https://developers.circle.com)

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
  the pause under the same lock, sign locally and broadcast. Rebalances quote, simulate, set
  the token allowance, swap, persist the transaction hash before broadcast and read the
  realised fill from the receipt.
- **Durable workers.** A single leader elected by lease with fencing, ticking every 15 seconds:
  `deposit-indexer` (30 s), `withdrawal-reconciler` (30 s), `rebalance-reconciler` (30 s) and
  `drawdown-monitor` (60 s). A restart mid-settlement is picked up rather than lost: a swap
  that was broadcast is confirmed or returned to pending from its receipt, one that never
  broadcast is returned to pending, and one Arc has no record of is flagged for manual review
  instead of being re-sent.

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
- EURC sleeve sized by risk tolerance (4, 10 or 16%) with a 1 percentage point drift threshold
- One active policy, superseding the previous one; every proposal carries its rationale

**Custody and settlement on Arc**
- Per-treasury EOA, envelope-encrypted, never persisted in plaintext
- Real USDC deposits and withdrawals with confirmation depth, reorg handling and refunds
- Real USDC and EURC swaps through Synthra with price impact and pool share limits, gas paid in USDC
- Circle Gateway unified balance reads, per chain, through Circle App Kit

**Controls operators actually have**
- Operating modes: Safe, Managed and Autonomous
- Emergency pause that blocks withdrawals, approvals and autonomous execution
- Withdrawal caps per transaction, per wallet per 24 h and global per 24 h
- Role-based access with five roles and a fresh sign-in requirement for the riskiest changes
- Hash-chained audit trail, alerts and an exploit drill that rehearses the response without touching funds

**Signals and monitoring**
- CoinGecko market data with 24 h momentum and USDC peg deviation, scored into 0 to 100 composites
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
│   └── integrations-anthropic-ai/  Anthropic client wired to the Replit AI proxy
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
- An Anthropic-compatible endpoint for Arcus (`AI_INTEGRATIONS_ANTHROPIC_*`, see below)
- A browser wallet (MetaMask, Rabby, Phantom or OKX) with Arc Testnet added and some
  [faucet USDC](https://faucet.circle.com)

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
export AI_INTEGRATIONS_ANTHROPIC_API_KEY=...
export AI_INTEGRATIONS_ANTHROPIC_BASE_URL=https://api.anthropic.com
PORT=8080 pnpm --filter @workspace/api-server run dev

# Terminal 2: web app on http://localhost:5173, forwarding /api to the API
PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:8080 pnpm --filter @workspace/revo-treasury run dev
```

The browser calls the API over relative `/api/...` URLs so that one build works everywhere. In
development the two servers are on different ports, so the Vite dev server forwards `/api` to
`API_PROXY_TARGET`; the session cookie stays same-origin and `http://localhost:5173` is already
an allowed origin outside production.

Open the console, connect a wallet on Arc Testnet and sign the nonce. A first-time wallet gets
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
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | yes | API key for Arcus |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | yes | Anthropic-compatible base URL |
| `ARC_TESTNET_RPC_URL` | no | Arc Testnet RPC, defaults to `https://rpc.testnet.arc.io` |
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

The suite covers the policy contract, rebalance planning and settlement, Synthra and Tower
quoting, App Kit reads, auth origin checks, withdrawal caps, the custody lock, worker fencing
and the dashboard and proposal routes. Route and worker tests run against a real PostgreSQL
database and stub the chain, so `DATABASE_URL` must point at a database you are happy to write
to. CI runs the pure unit suites on every push and pull request.

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

Revo is pre-release software on a test network. It is built defensively (server-side clamps,
custody key sealing, pause and cap checks under locks, chain guard, hash-chained audit) but it
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
- Arc: [arc.network](https://arc.network) · [docs](https://docs.arc.network) · [explorer](https://testnet.arcscan.app) · [faucet](https://faucet.circle.com)
- Circle: [Gateway](https://developers.circle.com/gateway) · [developer docs](https://developers.circle.com)
- Venue and registry: [Synthra](https://synthra.org) · [Tower Exchange](https://docs.tower.exchange)
- Model: [Anthropic](https://docs.anthropic.com)

## Licence

[MIT](./LICENSE) © 2026 Revo Labs. Built on Arc.
