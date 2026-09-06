---
name: On-chain allocations vs ledger accounting
description: Why treasury composition is read from the custody wallet, and what that breaks in any path that used to move numbers instead of assets.
---

Treasury composition must be read from the custody wallet over RPC, not from
stored unit columns.

**Why:** the dashboard used to derive its allocation rows from four database
columns. Three of the four assets did not exist on this chain at all, and the
rebalance path "executed" by rewriting those columns, so approving a rebalance
changed the display and nothing else. A production withdrawal failed with
`ERC20: transfer amount exceeds balance` precisely because the interface was
quoting ledger numbers the wallet could not honour.

**How to apply:**

- A failed chain read must never render as a zero balance. "RPC is down" and
  "the treasury is empty" have to reach the UI as different states, otherwise
  the safest-looking screen is the most misleading one.
- Once composition is chain-derived, anything that used to mutate holdings in
  the database is dead weight: it can no longer move the displayed book, so
  leaving it in place produces an approval that silently does nothing. Either
  wire it to a real settlement path or reduce it to validation plus a recorded
  intent, and make the activity copy say which one it is.
- Keep the deposit ledger as the accounting record and reconcile against it.
  Ledger and chain agreeing is the invariant worth checking; when they diverge,
  the chain is the fact and the divergence is the bug.
- Seeded marketing/demo states share the dashboard's types on purpose. Give them
  the same real symbols, or the landing page ends up advertising assets the
  product cannot hold.
