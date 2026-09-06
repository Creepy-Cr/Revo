---
name: Emergency pause binds at the send, not the reservation
description: Why the pause is re-read under the custody lock, and the lock order that keeps it deadlock-free
---

A withdrawal reserves in one transaction and signs/broadcasts later, outside
it. Checking the emergency pause only at reservation therefore leaves the
seconds between the two unguarded, and that is the window a
compromised-signer pause exists to close. The pause must be re-read
immediately before the custody signer is reached, and the reservation
refunded (row failed, units returned) if it is on.

**Why:** a reservation is an intent, not permission to send. Anything that
moves money has to consult the halt at the moment it moves it, or the kill
switch only stops withdrawals that had not started yet - and the failure
direction is money leaving a treasury the operator believes is frozen.

**How to apply:** the per-treasury custody send lock is the linearization
point. Pause activation takes it too, so activating waits for a transfer
already in the air and every send that starts afterwards reads the pause
under the same lock. Take it BEFORE the treasury transition lock, everywhere:
nothing may hold the transition lock and then wait for a custody send, or the
two orders deadlock. The custody client's statements auto-commit (the signed
hash must be durable before broadcast), so this lock cannot be transaction
scoped on that side - it is a session lock there and a transaction lock in
the pause.

Testing it needs a parking spot that holds no lock: hold the request at its
audit write (after the reservation commits, before custody) to let a pause
commit underneath it. Gating the signer instead tests the opposite ordering -
that activation blocks - and any gate must be released in a `finally`, or a
failed assertion strands a request holding the custody lock and every later
test in the file fails for the wrong reason.
