---
name: Browser timer typing
description: TypeScript timer and optional browser-API typing behavior in the Revo web package.
---

Type timer handles created through `globalThis.setTimeout` as `ReturnType<typeof globalThis.setTimeout>` rather than `number` when implementing browser fallbacks.

**Why:** The web package also loads Node types, so the global timer overload can return a Node timer object. DOM declarations may simultaneously treat APIs such as `requestIdleCallback` as always present and narrow a feature-detection fallback's `window` reference to `never`.

**How to apply:** For deferred browser work, keep runtime feature detection, call the compatibility timer through `globalThis`, and infer its handle type from that function. Use the matching global clear function during cleanup.