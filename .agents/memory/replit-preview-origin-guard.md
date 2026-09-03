---
name: Replit preview origin guard
description: How strict CSRF origin checks must account for Replit's proxied development preview.
---

Strict cookie-authenticated mutation guards must trust validated Replit preview hostnames in development as well as configured production origins. Never use a wildcard.

**Why:** Shell traffic reaches the shared proxy through localhost, but the user's browser sends an HTTPS `.replit.dev` origin. A localhost-only allowlist makes authenticated reads work while every state-changing request fails as cross-origin.

**How to apply:** Accept only platform-provided hostname values that pass strict hostname validation, convert them to exact HTTPS origins, retain explicit application origins, and test both accepted preview hosts and rejected wildcard/path-shaped inputs.