---
name: Realised fill measurement
description: How a settled rebalance's actual fill is measured, and why that read must never be able to fail the settlement.
---

A swap's realised fill is measured as the output token's wallet balance delta:
the pre-trade custody read the planner already did, against a fresh custody
read taken after the swap confirms.

**Why:** the router's confirmation carries no output amount here, so the only
available evidence of what came back is the balance either side of the trade.

**How to apply:** carry the pre-trade balance out of the planner. It cannot be
re-read later, which is also why a swap recovered by the reconciler can report
composition but never a fill.

## The read is reporting, never control flow

Anything that runs after the swap confirms must not throw, must not change the
outcome, and must degrade to "not known" plus an explanatory note.

**Why:** the trade has already landed. An unreadable chain says nothing about
the trade, and a failed read rendered as a zero fill turns a good rebalance
into an apparent total loss. Same family of bug as reporting a failed holdings
read as an empty treasury.

**How to apply:** wrap the whole post-confirmation path, including the failure
branch of the custody read, and return nulls with a note. Never zeros, never a
fallback to the quoted figure presented as the fill.

## Known bias: a USDC fill is net of gas

Arc bills gas in USDC out of the same balance, so when the output token is
USDC the measured delta is the fill minus this trade's gas. It is stated in
the operator copy rather than corrected. Reading the receipt's transfer logs
would give the gross amount.
