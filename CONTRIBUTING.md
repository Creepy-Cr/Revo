# Contributing to Revo

Thanks for taking the time. Revo is a small project with a large blast radius: it signs
transactions on behalf of a treasury. That shapes how we work. Changes are welcome, and the
bar for anything that touches money movement, custody or authorisation is deliberately high.

## Ground rules

- Be respectful. See the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Open an issue before starting anything larger than a bug fix, so we can agree on the shape.
- Keep pull requests focused. One concern per PR is much easier to review than a grab bag.
- Never commit secrets, private keys, RPC credentials or `.env` files. The repo is public.
- Mainnet only. Revo runs on Arc mainnet (chain 5042) and moves real value: never add a testnet mode, a bypass of the chain guard, or a code path that signs outside the custody boundary.

## Getting set up

Requirements: Node 22 (20.19 or newer works), pnpm 10, a PostgreSQL database, and Linux x64 or
WSL. The lockfile pins native binaries to Linux x64; on macOS or ARM remove the platform
`overrides` block in `pnpm-workspace.yaml` before installing.

```bash
git clone https://github.com/Creepy-Cr/Revo.git
cd Revo
pnpm install
```

Export the environment described in the [README](./README.md#environment) (at minimum
`DATABASE_URL`, `CUSTODY_MASTER_SECRET`, the Anthropic variables and `PORT`), push the schema,
then run the API and the web app in two terminals:

```bash
pnpm --filter @workspace/db push

PORT=8080 pnpm --filter @workspace/api-server run dev
PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:8080 pnpm --filter @workspace/revo-treasury run dev
```

The web client calls the API over relative `/api` URLs. `API_PROXY_TARGET` makes the Vite dev
server forward `/api` to the API so the browser stays same-origin and the session cookie works.

## Before you open a pull request

```bash
pnpm run typecheck    # whole workspace, this is the only typecheck that is trusted
pnpm run test         # api-server unit and integration tests (needs DATABASE_URL)
```

- The API contract lives in `lib/api-spec`. If you change a route's shape, edit the OpenAPI
  document first and run `pnpm --filter @workspace/api-spec run codegen`; never hand-edit the
  generated client or Zod schemas.
- Database changes go in `lib/db/src/schema` and are applied with `pnpm --filter @workspace/db push`.
- Server code logs through `req.log` or the shared `logger`, not `console.log`.
- Format the files you touched with `pnpm exec prettier --write <files>`. We do not reformat
  untouched files in feature PRs.
- Run only the root `pnpm run typecheck`; per-package `tsc` runs can report phantom errors from
  stale reference declarations.

## Areas that need extra care

Changes in these areas should come with tests and a short note in the PR describing the
failure mode you considered:

- `artifacts/api-server/src/lib/custody*` and anything that signs or broadcasts
- Withdrawal reservation, caps and the emergency pause
- Policy engine clamps and the proposal or policy approval routes
- Rebalance planning, settlement and reconciliation
- Session, nonce and step-up (fresh sign-in) handling

If you believe you have found a security issue, please do not open a public issue. Follow the
process in [SECURITY.md](./SECURITY.md).

## Commit and PR conventions

- Write commit messages in the imperative ("Add reserve check", not "Added").
- Explain why in the PR description, not just what. Link the issue.
- Screenshots or a short clip help a lot for anything visible in the console or on the site.
- Keep the README and `docs/` in step with behaviour changes. Stale docs are bugs.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE).
