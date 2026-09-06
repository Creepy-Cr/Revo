---
name: Proving a route-level lock in a test
description: Why a concurrency test that queues requests behind the treasury transition lock proves nothing, and how to force two transactions to overlap instead.
---

Treasury routes serialise on an advisory transition lock taken as the first
statement of their transaction. A test that wants to prove that lock is what
prevents a double-write must make two requests overlap *inside* the critical
section. Queueing them behind the lock does not do that: with the lock in
place they wait and pass, and with the lock removed they simply run
unblocked, finish sequentially, and pass again.

**Why:** the failure being guarded against is write skew, which needs both
transactions to be past their claims and uncommitted at the same instant.
Round trips a few milliseconds apart never produce it, so the test is
decorative unless the overlap is forced.

**How to apply:**

- Park both transactions on a statement they both must execute *after* their
  claim: hold a `FOR UPDATE` row lock in an outer transaction on a row both
  requests will update, start both, wait, then release. Both then commit at
  one instant.
- Remove every other accidental serialiser from the setup first, or the test
  passes for the wrong reason. Two matter here: rows both transactions would
  update (a policy already active makes both supersession sweeps contend on
  it), and rows created lazily on first use - the security-controls row is
  inserted on demand, and two concurrent inserts of the same primary key
  block each other for the whole transaction.
- Verify by breaking the guard and re-running the WHOLE file, never a
  name-filtered subset. Filtering skips the earlier tests that created those
  lazily-inserted rows, so the filtered run serialises on the insert and
  passes with the guard removed - the exact false negative this note exists
  to prevent.
