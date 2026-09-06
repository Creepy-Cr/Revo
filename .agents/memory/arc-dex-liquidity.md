---
name: Arc testnet DEX ground truth
description: Which Arc Testnet pools can actually be traded, and why the Tower aggregator's numbers must never be used to judge that.
---

# Read Arc pools directly, never judge them through Tower

Tower's aggregator API mangles amounts badly enough that its quotes say nothing
about whether a pool is usable. Every conclusion about liquidity, price or
minimum trade size must come from reading the DEX contracts over RPC.

**Why:** Tower reported that trades under 5000 USDC returned zero output, that
output quantised to whole tokens, and that a certain risk-asset pool held
roughly ten tokens priced near 4000 USDC. Reading the same pools directly
through the DEX factory and quoter showed all three claims were false: 0.01
USDC quotes fine, output scales linearly, and the pool actually held a fraction
of one token at roughly five times the real market price. The "no fractional
amounts" limit is a Tower request-encoding bug, not pool behaviour.

**How to apply:** Get the router and factory list from Tower's dex catalogue
endpoint, then go on-chain. The catalogue is the only part of Tower worth
trusting, and note that its live response omits fields the docs show, so read
the live payload rather than the documented example. Resolve pools through the
factory, read reserves as the token balances held by the pool contract, and
quote through the DEX's own quoter with `eth_call`. A quoter declared `view` in
a local ABI simulates fine without a signer even when it is nonpayable
on-chain.

# Pool quality varies enormously and is unrelated to depth

Depth and price sanity are independent on this testnet. A pool can hold
millions and still price its asset at more than double the real rate, because
nothing arbitrages testnet liquidity.

**Why:** Across the chain's DEXes, the euro stablecoin pair had both real depth
and a price within about fifteen percent of the real FX rate, while a
dollar-stablecoin pair with comparable depth priced its token at two and a half
dollars. The wrapped-BTC pair was both nearly empty and several hundred percent
off. Only the euro pair satisfied both conditions at once.

**How to apply:** Before picking a tradable pair, check depth and deviation
from an independent reference price separately, and re-check them rather than
trusting an earlier survey. Prefer the middle fee tier: the shallow tier drifts
under larger orders and the highest tier carries a permanently worse rate. Mark
positions against the real market price and treat the pool rate purely as an
execution detail, otherwise profit-taking logic can never fire against a
detached pool price.

# The major AMM is not on this testnet

Checking a partner announcement is not the same as checking the chain. The
best-known AMM was announced for Arc but only for mainnet, so it cannot be
reached from testnet at all. Enumerate the chain's actual deployed DEXes before
assuming any given venue exists.
