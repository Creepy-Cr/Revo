---
name: AI latency measurement
description: How to measure the Replit Anthropic integration in this workspace without fighting declaration-only package resolution.
---

Measure production-representative AI latency through the instrumented API route and its structured request logs, rather than importing the integration workspace package from an ad hoc Node script.

**Why:** The integration library is a composite, declaration-emitting package that the API build bundles. Its source entrypoint and dependency resolution are not configured as a standalone Node or TSX runtime, so isolated benchmark scripts can fail before reaching the model and produce no useful timing.

**How to apply:** Log model generation duration and token counts inside the authenticated AI route without logging prompts or responses. Compare those fields after publishing a model or prompt change.