## What and why

<!-- What does this change and what problem does it solve? Link the issue. -->

## How it was verified

- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run test` passes (or explain which suites were skipped and why)
- [ ] Manually exercised in the console or with curl where relevant

## Safety checklist

- [ ] Does not weaken any custody, approval, cap or pause check
- [ ] Still Arc mainnet only (chain guard, RPC defaults, no testnet mode)
- [ ] No secrets, keys or personal data in the diff
- [ ] Docs and README updated if behaviour changed
