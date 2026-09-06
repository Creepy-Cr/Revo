---
name: Treasury token set fan-out
description: A signal or card is scoped to a token the treasury can hold, or to no asset at all; and changing the holdable token set is always a multi-artifact sweep.
---

## A signal names a holdable token, or no asset at all

There is no third option. Not a placeholder ticker, not the DAO, not an empty
string. A ticker-shaped label in an asset slot reads as a position, and an
operator will take it as one.

**Why:** the feed shipped sentiment for an asset that does not exist on this
chain, long after every other surface had moved to the real token set. Nothing
failed, no test broke, and the console simply offered operators risk signals for
a position they could not take. The community-sentiment card had the same defect
in a quieter form: it is about the DAO's mood, not a holding, but it wore an
asset label anyway.

**How to apply:** scope the asset field to the pinned registry's symbol type
wherever the compiler can reach it. Where a signal genuinely is not about a
holding, leave the asset absent and let the UI render nothing.

## Changing the token set is a sweep, not an edit

The registry is the source of truth, but plenty of surfaces restate it in copy
that no type checks: chat prompt suggestions, marketing and video scenes, card
detail text. The API's asset field is intentionally free-form, because the
in-memory safety drill shares the signal shape, so schema validation will not
catch drift either.

**How to apply:** grep every artifact for both old and new symbols, including
video and marketing copy, not just the server. Where a surface only needs a
label rather than a decision, derive it from the registry at runtime so it
cannot drift again. Keep the invariant in a test, since the schema cannot hold
it.
