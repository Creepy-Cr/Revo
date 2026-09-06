---
name: Workspace typecheck truth
description: Only the root typecheck is trustworthy here; a per-artifact tsc run reports convincing errors that do not exist.
---

Trust only the root `pnpm run typecheck`. It runs `tsc --build` first, which
regenerates the project-reference declarations, then checks each artifact.

A per-artifact `tsc --noEmit -p ...` run is fine as an inner loop but is not
evidence of anything. It resolves shared-lib imports against whatever `.d.ts`
files happen to be on disk, which can be arbitrarily out of date, so it invents
errors about fields that are present in the source right now.

**Why:** a direct per-artifact run produced a dozen confident "property does not
exist" errors about database columns that had been in the schema the whole time.
They were nearly reported as a broken build. The root typecheck on the same tree
was clean.

**How to apply:** never report, act on, or file a follow-up about a type error
involving a shared lib until the root typecheck reproduces it.
