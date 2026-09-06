---
name: Console refusal signposts
description: How the treasury console should surface an action the API will refuse, without becoming the thing that enforces it.
---

When the API refuses an operator action on state the console already knows about (an
emergency pause, a role, a mode), the control says so up front and the server keeps
refusing it. The UI is a signpost, never the gate.

Three parts to it:

- Reuse the refusal wording from the route, so the early warning and the eventual
  error toast cannot drift apart.
- Read the state off the query key the rest of the console already uses for it.
  Whoever clears the state (lifting a pause, changing a role) invalidates that key,
  so every control recovers on its own with no reload and no second poll to wire up.
- Guard the click handler as well as the styling. The state can be seconds stale, so
  the guard is what stops a pointless round trip, not the disabled attribute.

**Why:** during an incident the operator is clicking exactly the controls the pause
has taken away, and a failure toast after a round trip is the worst moment to learn
that. Enforcing in the UI instead would be worse: the state is polled, so the console
can be wrong in the unsafe direction, and a stale copy of a security decision is how
a refusal silently stops applying.

**How to apply:** any time a route answers 4xx from a condition the console already
fetches. Prefer `aria-disabled` plus dimming over the native `disabled` attribute
when the reason needs to be readable: disabled buttons drop their tooltip in some
browsers, and an operator who clicks anyway should get the explanation rather than
silence. Keep a visible line of text near the control too, since a tooltip is not
discoverable during an incident.
