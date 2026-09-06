---
name: Worker-job tests run against the shared dev database
description: API tests hit the real dev Postgres, and a worker job's entry point fans out over every treasury row, so drive the per-treasury function instead.
---

The API artifact's tests run against the live development database, not a
fixture or an in-memory instance. The established pattern is: create a
uniquely-suffixed treasury id, seed only the rows the test needs, and delete
them in afterAll.

**The trap:** a worker job's `run` entry point loops over *every* treasury row
in the database. Driving it from a test therefore executes the job against real
development treasuries, and the loop's own error handling writes a durable
critical alert against whichever treasury it was processing. Cleanup keyed to
the test's id prefix will not remove that.

**How to apply:** test the per-treasury function, not the loop. Export it if it
is private - that is a smaller and safer change than trying to fence the loop
off. Do not rely on inner try/catch blocks to absorb a deliberately throwing
stub for the other treasuries: whether a failure is swallowed silently or
escalated into an alert depends on exactly where in the job it is thrown, which
is not a property a test should be pinned to. Afterwards, confirm no rows
carrying the test id prefix survived.

**Also:** the custody-lock test opens as many connections as the pool allows
with a short deadline, so adding DB-touching test files can make it flake for
reasons unrelated to the change. Re-run it isolated before treating it as a
regression.
