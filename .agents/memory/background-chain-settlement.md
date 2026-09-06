---
name: Background chain settlement
description: Rule for any on-chain action that outlives the request that started it - hash before broadcast, that write is the claim, reconcilers only read.
---

An on-chain action that a request kicks off but does not await must satisfy
three things, or it strands value:

1. **Persist the transaction hash before broadcasting it.** A recovering
   process can then read "no hash" as proof that nothing was sent, and "hash"
   as the exact transaction whose receipt decides the outcome. Signing is
   deterministic here, so the hash is known before the mempool sees anything.
2. **Make that pre-broadcast write the claim.** Guard it on the row still
   being in the in-flight state; if it does not match, discard the signed
   payload unsent. This is the only thing standing between a reconciler and a
   duplicate trade, and it costs nothing because no nonce is consumed.
3. **Reconcile by reading receipts only.** Never re-sign, never re-send. Every
   status write stays guarded on the in-flight state, and operator-facing
   logs/alerts fire only when that guarded write actually claimed the row -
   otherwise several instances narrate the same event.

**Why:** approving a rebalance used to block the HTTP request on a swap
confirmation (~10s healthy, unbounded under congestion), and an unreadable
receipt parked the proposal forever with the treasury's real holdings
unknown. The withdrawal path had already been through this.

**How to apply:** whenever a route signs and broadcasts, ask what happens if
the process dies between signing and the receipt. If the answer needs the
process to survive, the design is wrong. A receipt probe that comes back
"missing" indefinitely is not resolvable automatically - escalate it to an
operator rather than guessing, since re-sending is forbidden and declaring it
failed could unwind a trade that is still live.

Grace windows matter: probe only after longer than a live confirmation wait,
or reconciliation races the settlement that is still working normally.
