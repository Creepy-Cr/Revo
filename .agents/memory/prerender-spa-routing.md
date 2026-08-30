---
name: Prerender and SPA routing
description: The routing constraints that keep crawlable public documents compatible with Revo's client-only console.
---

When adding or changing public routes, keep the public route manifest, flat build-time prerender files, and exact rewrites for both extensionless and trailing-slash paths synchronized. Keep authenticated SPA routes backed by flat, empty client shells rather than the prerendered homepage.

**Why:** Replit's static host lets physical directories shadow rewrites, redirecting an extensionless route to its slash form before the exact rule runs. The catch-all then serves homepage HTML for that slash URL, so crawlers see the wrong canonical document and may report noindex or missing content.

**How to apply:** Emit route documents as flat files such as `docs.html`, map both `/docs` and `/docs/` to that file before the catch-all, normalize trailing slashes for client metadata, and use flat noindex shells for protected routes. Verify direct production HTTP responses after publishing, not only client navigation.