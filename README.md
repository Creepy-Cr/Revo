# Revo Treasury

**Live app**: [therevo.xyz](https://therevo.xyz)

An AI-managed DAO treasury command center on Arc Testnet. Deposit testnet USDC, give the on-board agent (Arcus) plain-English instructions, and watch it compile them into enforced treasury policies with guarded, simulated rebalances.

> Testnet-first product. No real funds are ever involved.

## What it does

- **Natural-language governance**: type "keep at least 40% of the treasury liquid at all times" and Arcus compiles it into an enforced policy with a rebalance draft for your approval.
- **Real on-chain custody**: per-treasury custody wallets on Arc Testnet with encrypted keys, deposit indexing, and signature-verified withdrawals.
- **Multi-source signals**: market data, USDC peg deviation, crypto news, GitHub activity, and Arc whale-watch feeds fused into allocation signals. X and Discord sources are optional and stay dormant unless their tokens are configured.
- **Hard guardrails**: max protocol exposure, minimum liquid reserve, emergency exit thresholds. The agent can propose, but never bypass approvals.
- **Zero mock data**: every number in the console is computed from on-chain deposits and persisted state.

## Stack

| Layer    | Tech                                                          |
| -------- | ------------------------------------------------------------- |
| Frontend | React 19, Vite, Tailwind CSS v4, Recharts, Framer Motion      |
| Backend  | Node.js, Express, Drizzle ORM, PostgreSQL                     |
| Chain    | viem on Arc Testnet (chain id 5042002), USDC as native gas    |
| AI       | Anthropic Claude (Opus) for the Arcus agent and strategy compiler |
| Contract | OpenAPI spec as source of truth, generated client hooks and Zod schemas |

## Architecture

![Revo architecture](docs/architecture/revo-architecture.png)

Full breakdown, including which flows are real on-chain transactions and which are
internal accounting, is in [`docs/architecture/`](docs/architecture/README.md).

## Monorepo layout

```
artifacts/
  revo-treasury/      # React frontend (landing + console)
  api-server/         # Express API (auth, custody, policies, signals, workers)
  revo-demo-video/    # Animated product demo
lib/
  api-spec/           # OpenAPI contract + codegen (orval)
  db/                 # Drizzle schema and migrations
scripts/              # Maintenance and ops scripts
docs/
  architecture/       # System architecture diagram (SVG + PNG)
```

## Getting started

Requires Node.js 20+, pnpm 9+, and a PostgreSQL database.

```bash
pnpm install

# Push the database schema
pnpm --filter @workspace/db run push

# Run the API server (port 8080)
pnpm --filter @workspace/api-server run dev

# Run the frontend (needs PORT and BASE_PATH, e.g.)
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/revo-treasury run dev
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `SESSION_SECRET` | yes | Session signing + custody key encryption fallback |
| `CUSTODY_MASTER_SECRET` | recommended | Dedicated master secret for custody key encryption |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | yes | Anthropic API key for Arcus |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | optional | Custom base URL for the Anthropic-compatible API |
| `X_BEARER_TOKEN` | optional | Enables the X sentiment source (dormant without it) |

### Build

```bash
pnpm run build   # typecheck + build all packages
```

## License

MIT
