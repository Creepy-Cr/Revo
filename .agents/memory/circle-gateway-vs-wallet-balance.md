---
name: Circle Gateway is not a wallet balance
description: Why a zero unified-balance reading must never be rendered as an empty treasury, plus App Kit surface gotchas.
---

Circle App Kit's "Unified Balance" does not sum a wallet's USDC across chains.
It reads Circle Gateway, which is a deposit contract: USDC appears only after it
has been explicitly deposited into Gateway, after which it becomes spendable on
any supported chain.

**Why:** the obvious reading of the product name is wrong, and the failure mode
is silent. A fully funded treasury returns `0.000000` on every chain, which
renders as "you have nothing" unless the UI distinguishes the two pots.
Depositing into Gateway is also a custody change — funds leave the custody
wallet for a Circle contract — so it cannot be done implicitly just to make the
number look populated.

**How to apply:**

- Carry an explicit "has anything been deposited into Gateway" flag through the
  API contract instead of inferring emptiness from a zero total.
- Wherever a Gateway figure appears, say plainly that it is separate from the
  settlement-chain custody balance.
- App Kit needs no API key for Gateway reads or chain metadata; a key is only
  recommended to lift Swap rate limits. Do not introduce a secret for this.
- The published SDK reference lists methods flat, but the real instance surface
  is namespaced — unified balance sits under its own sub-object alongside
  bridge, send, swap, and earn. Introspect the constructed instance rather than
  trusting the reference, or you will call a method that does not exist.
- The SDK carries full chain metadata (contract addresses, CCTP domain, RPC,
  explorer) for each supported chain. Read it from the SDK instead of
  hardcoding a second copy that can drift from the app's own chain config.
