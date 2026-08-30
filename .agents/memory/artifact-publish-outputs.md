---
name: Artifact publish outputs
description: Why generated artifact build directories must remain eligible for the final publish image.
---

Do not add a broad `**/dist` exclusion to `.replitignore` in an artifact-based project.

**Why:** Artifact production builds can succeed and create their configured API bundle and static `publicDir`, but the publish image assembly still honors `.replitignore`. Excluding `dist` removes both outputs before startup, producing missing-module, missing-public-directory, and port-readiness failures.

**How to apply:** Keep source-only temporary directories and dependency stores excluded, but allow each artifact's configured production output directory into the publish image. If a build succeeds yet production cannot find its bundle or static directory, inspect `.replitignore` first.