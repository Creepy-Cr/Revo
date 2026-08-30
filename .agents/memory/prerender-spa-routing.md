---
name: Prerender and SPA routing
description: The routing constraints that keep crawlable public documents compatible with Revo's client-only console.
---

When adding or changing public routes, keep build-time prerender output, exact extensionless-path rewrites, and the public route manifest synchronized. Keep authenticated SPA routes backed by explicit empty client shells rather than the prerendered homepage.

**Why:** A catch-all SPA rewrite can otherwise return homepage HTML for extensionless public URLs or protected console URLs. That makes crawlers see the wrong document and can cause hydration mismatches before the client router corrects the page.

**How to apply:** Emit one route-specific `index.html` per public canonical path, add an exact rewrite from each extensionless path to that file before the catch-all, and emit noindex empty-root shells for client-only routes. Verify direct HTTP responses, not only client navigation.