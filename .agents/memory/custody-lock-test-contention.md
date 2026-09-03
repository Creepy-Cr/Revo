---
name: The custody advisory-lock test flakes under worker contention
description: A pre-existing timing-sensitive test that fails when unrelated test files are added; not a regression signal.
---

The api-server test that asserts custody operations do not starve on nested
database pool clients enforces a hard two-second acquisition deadline. That
deadline is measured in wall-clock time inside a shared vitest worker pool, so
it is sensitive to how many other test files are running beside it.

**Why:** adding an unrelated test file to the package has been enough to push it
over the limit and fail the suite, which reads exactly like a regression in
custody or pooling code. It is not — running the file on its own, or re-running
the full suite, passes.

**How to apply:**

- Before investigating a failure in that test, run it in isolation and re-run
  the whole suite. Two clean runs mean contention, not a real starvation bug.
- Do not "fix" it by widening the deadline without cause: the deadline is the
  assertion. If it fails deterministically, that is a genuine pooling problem.
- Keep new test files in this package light on long sequential async loops,
  which are the cheapest way to trigger the flake.
