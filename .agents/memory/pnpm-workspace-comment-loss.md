---
name: pnpm update rewrites pnpm-workspace.yaml
description: pnpm update silently strips every comment from pnpm-workspace.yaml; treat those comments as load-bearing policy and restore them.
---

# `pnpm update` strips all comments from pnpm-workspace.yaml

Any recursive pnpm update that touches catalog entries rewrites the file wholesale:
sections reordered, quote style normalised, and every comment deleted.

**Why:** the comments in that file are policy, not decoration — a supply-chain
release-age guard marked "DO NOT DISABLE THIS SETTING", the reasoning behind the
platform-exclusion overrides, and the note that react and react-dom are pinned to
exact versions because Expo requires it. Losing them strands future readers with
pins and guards whose rationale is gone, and eventually someone removes them.

**How to apply:** after any pnpm update, diff the comment count against git HEAD. If
it dropped, rebuild the file from HEAD and re-apply only the genuine value changes
instead of hand-patching pnpm's reformatted output — most of the churn is quote-style
noise. A frozen-lockfile install is the check that the restored manifest still agrees
with what pnpm actually resolved.

## Related: an exact pin can hold a vulnerability open

An audit finding on a transitive package that already appears in the overrides block
usually means the pin itself is the cause: an exact version was pinned, later proved
vulnerable, and now blocks the upstream fix from reaching the tree. Bump the existing
pin rather than adding a second override, and record which advisories the new floor
clears so nobody lowers it again. Keep such pins exact rather than a caret range —
the goal is a deterministic audited version, not the newest one.
