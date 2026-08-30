# Revo Treasury

Revo is a testnet-only DAO treasury command center for wallet-authenticated operators, combining Arc Testnet custody, live signals, governance, deterministic policy enforcement, and Claude Opus 5 treasury intelligence.

## Run & Operate

- Use the managed workflows `artifacts/revo-treasury: web` and `artifacts/api-server: API Server`; do not add replacement workflows.
- `pnpm run typecheck` — canonical full workspace typecheck.
- `pnpm run build` — typecheck and production-build every package.
- `pnpm --filter @workspace/api-server run test` — API/custody regression tests.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas after every OpenAPI change.
- `pnpm --filter @workspace/db run push` — apply schema changes to development only. Production schema changes are handled by Replit Publish.

## Stack

- pnpm workspaces, Node.js, TypeScript, React 19, Vite, Express 5
- PostgreSQL + Drizzle ORM
- OpenAPI + Orval-generated React Query and Zod packages
- viem for Arc Testnet wallet/RPC behavior
- Anthropic through Replit AI Integrations, using `claude-opus-5`

## Where things live

- Frontend artifact: `artifacts/revo-treasury`
- Shared API artifact: `artifacts/api-server`
- API contract: `lib/api-spec/openapi.yaml`
- Generated browser client: `lib/api-client-react`
- Generated server validation: `lib/api-zod`
- Database source of truth: `lib/db/src/schema`
- Anthropic client: `lib/integrations-anthropic-ai`

## Architecture decisions

- The browser and API communicate through relative `/api` URLs so the same build works in development and production.
- Wallet signatures establish server-side, HttpOnly sessions; every protected query is scoped to the operator's treasury.
- Claude compiles and explains policies, but deterministic server code applies governance and guardrails.
- Arc Testnet deposits and withdrawals are real testnet transactions. Strategic rebalances and risk drills remain explicitly simulated.
- Production requires a custody secret distinct from the session-signing secret.

## Product

- Public marketing, documentation, legal, and risk pages
- Wallet-based operator onboarding and role-aware administration
- Treasury dashboard, allocations, NAV, signals, and activity
- Natural-language policy compilation and approval
- Proposal governance and operating modes
- Claude-powered Arcus chat grounded in live treasury state
- Arc Testnet USDC custody, deposit verification, and withdrawal reconciliation
- Security limits, emergency pause, alerts, and verifiable audit export

## Gotchas

- Never present simulated portfolio rebalances as on-chain execution.
- Do not add startup or deployment-time database DDL; Replit Publish handles the production schema diff.
- Do not log wallet signatures, session tokens, private keys, custody ciphertext, or environment values.
- `CUSTODY_MASTER_SECRET` must exist before publishing.
- This app has long-running reconciliation workers; choose an always-running VM deployment rather than autoscale.

## Pointers

- See `README.md` for product and API usage details.
- See the `pnpm-workspace`, `react-vite`, database, and deployment skills before changing hosting or contracts.
