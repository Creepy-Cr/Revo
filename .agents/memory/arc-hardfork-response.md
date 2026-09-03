---
name: Arc node hardfork response
description: How to evaluate an Arc Testnet/Mainnet node hardfork announcement for this project, which is an RPC client and not a node operator.
---

# Arc hardfork announcements are operator-facing by default

Arc ships recurring named hardforks (Zero7 mid-2026, Zero8 Sept 2026) carrying a
"node operators must upgrade or fall out of sync" warning. That warning does not
apply to this project.

**The rule:** this project runs no Arc node. It is a JSON-RPC client against public
Arc endpoints. Treat a hardfork notice as informational until proven otherwise, and
do not change application code on the strength of the announcement alone.

**Why:** nearly every Arc breaking change is CLI flags, node env vars,
consensus/execution-layer config, storage format, or snapshot tooling — none of it
observable from a client. Reacting anyway produces churn in a custody-signing path
where churn is expensive and risky.

**How to apply:** when a hardfork notice arrives, work in this order.

1. Read `BREAKING_CHANGES.md` and `CHANGELOG.md` in `circlefin/arc-node` and split
   operator-only items from anything touching the JSON-RPC surface. Circle tags
   items `[CLI]`, `[Config]`, `[Format]`, `[EL]`, `[CL]`. `[Format]` is the tag that
   tends to reach clients.
2. The realistic client risk is changed *error strings*, not removed methods. Zero8
   altered insufficient-balance `eth_call`/`eth_estimateGas` error text via a
   reth/revm upgrade. Before concluding "no impact", grep the chain layer for
   regexes over upstream error messages — this codebase does match on upstream text
   in its broadcast and receipt-lookup paths, so the question is always *which*
   strings it matches, not whether it matches any.
3. Verify empirically rather than by reasoning. POST straight at the RPC hosts and
   exercise the exact methods the app uses: chain id, fee and nonce reads, the USDC
   `decimals`/`balanceOf` calls, `eth_getLogs` in the deposit indexer's shape, and a
   batch request. Circle upgrades the public endpoints itself, so they are typically
   already running the new version before you look.

Two recurring sources of false alarm:

- Release notes saying Arc "does not support withdrawals" refer to Engine API
  validator withdrawals, not this project's USDC withdrawal feature.
- Denylist enforcement is mandatory and chain-derived, so a transfer involving a
  denylisted address fails network-wide regardless of node config. That is a genuine
  runtime failure mode, but it is not a regression introduced by any one fork.
