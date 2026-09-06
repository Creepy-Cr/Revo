---
name: The development database can lag the committed schema
description: Why an api-server test suddenly fails seeding a row on a column the schema no longer has, and the safe way to resync.
---

The API tests seed rows through the drizzle schema in the repository, but they
run against the shared development Postgres. When a commit drops a column, that
change only reaches the database through a schema push, and the push does not
always happen. The symptom is a seed insert failing with a NOT NULL violation on
a column that does not exist in any schema file, which reads like a broken test
rather than a stale database.

**Why:** `drizzle-kit push` treats a dropped column as a data-loss statement and
asks for confirmation. In a non-interactive shell (post-merge hooks, CI, agent
shells) that prompt cannot be answered and the push aborts, so the columns
survive in the database while the code has forgotten them.

**How to apply:**

- Recognise the shape first: an error naming a column no schema file mentions is
  drift, not a test defect. Do not work around it in the test.
- Confirm what the push wants to do before running it, by asking for the
  statements non-interactively. Expect exactly the diff the recent commits
  imply; anything wider means something else is out of sync and is worth
  understanding before applying.
- Only then apply it with the forcing variant, which skips the prompt. Check the
  columns being dropped hold nothing real first: they are usually the fictional
  or superseded ones a commit already removed.
- The same prompt is why a schema change can quietly fail to reach a fresh
  environment. Assume nothing about the database matching HEAD; check.
