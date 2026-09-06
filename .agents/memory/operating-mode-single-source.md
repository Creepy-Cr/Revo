---
name: The operating mode has exactly one home
description: Why nothing may store or re-derive the treasury's safe/managed/autonomous mode, and where its readers already are.
---

The mode lives in the treasury settings row and nowhere else. Anything that
reports it - the dashboard status the console badges, the agent's chat context,
an activity line - derives its label at read time from that row. Never store a
second copy, not even one written at initialisation.

**Why:** a stored copy is only correct until the first mode switch, and it fails
in the dangerous direction. A frozen "AUTONOMOUS" left the console badging
AUTO-EXECUTE while the treasury sat in Safe mode and every guard was refusing to
act, so the header told operators the agent had authority it did not have. The
same argument retired the stored chain name: it duplicated the chain config, and
a duplicate is a thing that can disagree.

**How to apply:**

- Read the mode through the shared helper in the api-server lib rather than
  querying the settings table again; the fallback for a missing or unrecognised
  value must be the review-required mode, never the autonomous one.
- Derive the mode and its display label in the same read that produces the rest
  of a response, so the badge and the mode control in one payload cannot
  disagree.
- The mode also has readers that only enforce it (approvals, policy activation,
  the engine, the drawdown worker's auto-de-risk gate). Adding a mode, or
  changing what one permits, means visiting all of them - nothing enumerates
  them for you.
- The risk drill deliberately overlays its own status label on top of the
  mode-derived one. That overlay is display-only and must never write anything
  back.
