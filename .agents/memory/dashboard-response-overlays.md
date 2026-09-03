---
name: Dashboard response overlays
description: Why adding a required field to the dashboard response contract breaks in a state that normal testing never reaches.
---

The treasury dashboard response is not produced by one function. A simulated
safety-drill overlay intercepts the computed dashboard and rewrites it —
substituting figures and prepending its own synthetic activity rows — before the
response is validated against the schema.

**Why:** adding a required field to the activity contract updated the real
producer but not the overlay. The overlay's rows lacked the field, schema
validation rejected the whole response, and the route degraded to a generic 503.
It only reproduces when the drill is active *and* the treasury is funded, so the
ordinary request path, the type checker at the time, and the whole test suite all
passed. The drill is also precisely what gets demonstrated live, so the failure
was aimed at the worst possible moment.

**How to apply:**

- Treat any change to the dashboard response shape as a change to two producers.
  Grep for the overlay before assuming one edit is enough.
- Prefer typing the overlay against the same element type the real producer
  returns, rather than a looser structural copy. When the two are identical the
  compiler catches the drift immediately; when the overlay uses widened types
  (`string` instead of the literal union) it silently accepts the mismatch.
- Be suspicious of a route that catches validation failures and returns a
  generic server error. It converts a precise schema complaint into a symptom
  with no stack trace pointing at the real cause.
