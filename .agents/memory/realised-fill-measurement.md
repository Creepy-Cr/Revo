---
name: Realised fill measurement
description: How a settled rebalance's actual fill is measured, why the receipt outranks the balance delta, and why that read must never be able to fail the settlement.
---

A swap's realised fill has two possible sources, and they are not equal. The
receipt's own ERC-20 transfer logs say exactly what the router paid into the
custody wallet. The output token's wallet balance delta measures the same
thing indirectly, and is distorted by anything else that touched the balance.

**Why:** the delta is understated by gas whenever the output is the token Arc
bills gas in, it is corrupted by any concurrent transfer, and it depends on a
pre-trade balance that stops existing the moment the settlement process dies.
The receipt has none of those problems and can be re-read forever.

**How to apply:** prefer the receipt, keep the delta as the fallback, and let
each caveat apply only to the source it belongs to. The gas caveat describes
the delta, so it must be dropped when the number came from a receipt. This
also means a recovery path with no pre-trade balance can still report a fill.

## The read is reporting, never control flow

Anything that runs after the swap confirms must not throw, must not change the
outcome, and must degrade to "not known" plus an explanatory note.

**Why:** the trade has already landed. An unreadable chain says nothing about
the trade, and a failed read rendered as a zero fill turns a good rebalance
into an apparent total loss. Same family of bug as reporting a failed holdings
read as an empty treasury.

**How to apply:** wrap the whole post-confirmation path, including receipt
parsing and the failure branch of the custody read, and return nulls with a
note. Never zeros, never a fallback to the quoted figure presented as the
fill. Absent evidence must be null rather than 0 at every layer, so that a
missing transfer log cannot be mistaken for a swap that returned nothing.

## Two independent measurements, two independent failures

The fill and the post-trade composition come from different reads, so one
failing must not suppress the other: an unreadable holdings read still leaves
the receipt's fill reportable, and vice versa.
