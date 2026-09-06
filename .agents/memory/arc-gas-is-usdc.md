---
name: Arc pays gas in USDC
description: On Arc, gas is settled in USDC from the same balance a transfer moves, so a full-balance USDC withdrawal always reverts. Read before debugging "transfer amount exceeds balance".
---

# Arc pays gas in USDC

USDC is Arc's native asset. The ERC20 at the USDC predeploy address is an
interface over the native balance, not a separate token sitting beside it. A
wallet's ERC20 `balanceOf` and its native balance are the same funds shown at
different precision (6 decimals vs 18).

The consequence that costs time: **gas for a USDC transfer is deducted from the
very balance being transferred.** Moving the entire balance is therefore always
impossible. Attempting it fails at gas estimation, before anything is
broadcast, with `execution reverted: ERC20: transfer amount exceeds balance`.

**Why:** this reads as a balance bug or an accounting mismatch, and sends you
hunting for a ledger discrepancy that does not exist. The symptom that gives it
away is a deposit ledger holding a round number while the chain holds the same
number minus a few hundred millionths, with the native balance matching the
chain figure digit for digit.

**How to apply:** any code path that decides whether a USDC amount can be sent
must compare against the chain balance minus an estimated gas reserve, never
against a deposit ledger figure and never against the raw chain balance. A
"withdraw max" affordance must offer spendable, not held. When a revert does
occur, the failure is definitively pre-broadcast and therefore safe to refund.

## Gas is treasury spend, so it is also something to report

Because it comes out of the treasury's own balance, gas is not a network fee
happening somewhere else: it is money the operation spent. An operation that
sends more than one transaction spent all of their gas, so the cost an
operator is shown covers every leg, not just the headline one.

**Why:** an amount taken from a receipt's transfer logs is gross of gas, which
is the correct fill but leaves the cost invisible unless it is reported
separately. And a total summed over only the legs that happened to be readable
understates the spend while looking authoritative, which is the same failure
as reporting an unreadable figure as zero.

**How to apply:** derive the cost from receipts already in hand rather than
re-reading the chain, and treat a leg with no readable gas as making the whole
total unknown. Zero is a real answer only if the chain genuinely says so, and
on Arc it never does, so treat a missing or zero gas field as not known.
