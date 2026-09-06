---
name: Tower Exchange quoting on Arc Testnet
description: Non-obvious failure modes of Tower's public swap API, and why one of its quotes is never enough to authorise a trade.
---

Tower is the only venue that advertises `swaps` on Arc Testnet; every other chain
in its list is bridge-only. Its public API quotes and routes but has no
build/unsigned-transaction endpoint, so any executor must encode the router call
itself from the `dexRouter` it names.

Treat every number it returns as indicative.

- **Amounts are scaled by 10^(18 - decimals), not 10^decimals.** Verified across
  6, 8 and 18 decimal tokens. Forwarding its echoed input amount to a signer
  overspends a 6-decimal token by a factor of a million. Recompute base units
  locally from pinned decimals and never pass its figure onward.
- **It cannot parse a fractional input.** Any decimal point returns HTTP 500
  "Cannot convert 0.001 to a BigInt". The smallest quotable trade is therefore
  one whole token, which for a BTC-priced asset is thousands of dollars.
- **A quote can succeed with zero output and zero minOut.** Signing that is a
  swap with no floor on what comes back.
- **Its risk fields contradict each other.** The top-level `priceImpact` reports
  only the winning entry in `routeOptions`; the same response can carry an
  alternative route at 30% impact. It has also reported zero impact while
  routing through a pool it simultaneously calls zero-liquidity.
- **Pool prices are detached from the assets they name.** cirBTC has quoted near
  4,000-5,000 USDC while real BTC traded near 80,000, and output quantises to
  whole tokens, so 5,000 and 7,500 USDC buy the identical 1 cirBTC. A quote can
  be perfectly executable and still economically meaningless.

**Why:** all of these were observed live against the real API, and most would
have produced a silently wrong or unbounded trade rather than a visible error.

**How to apply:** pin token addresses and decimals locally and stop trading if
the venue's registry disagrees; derive the minimum output from an independent
market reference rather than the venue's own figure; refuse a route whose
implied rate is far from that reference; and simulate with eth_call before
anything is signed.
