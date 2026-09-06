---
name: Valuation gate is a caller-side contract
description: computeDashboard reports whether its total can be trusted, but nothing forces a consumer to look - each one must gate itself.
---

The dashboard computation returns a completeness flag alongside the total. It is
set false when the chain cannot be read or a held asset cannot be priced, and in
that state the total understates the treasury.

**The rule:** every consumer of the dashboard must check that flag before using
the total for anything that implies a loss, a trend, or an action. The type
system does not enforce it, and an understated total is silently valid input
everywhere.

**Why:** an understated total is indistinguishable from a drawdown. An
unreachable RPC read as an empty wallet gets written into NAV history, charted
as a crash, escalated by the drawdown monitor into a critical breach alert, or
narrated to an operator by the chat agent - all over a network blip. The
failure mode is not "wrong number on screen", it is "outage reported as lost
money".

**How to apply:** when adding a new consumer, or a new field derived from the
total, decide explicitly what it does on an incomplete valuation. Refusing
(503), staying idle, or labelling the degradation are all fine; passing the
number through unqualified is not. The gate lives in several independent
places - the snapshot write, the day-change figure, the monitor, the drill
route - so removing "the" gate is never a single edit, and each of those points
needs its own regression test.
