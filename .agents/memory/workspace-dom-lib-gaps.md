---
name: Workspace DOM lib gaps
description: Why packages in this monorepo intermittently fail typecheck on web APIs, and what to check when a dependency or codegen bump breaks the build.
---

The shared TypeScript base config declares a DOM-less `lib`. Every package whose
code touches a web API has to opt back in explicitly, and the opt-ins that exist
are inconsistent — some list only `dom`, some also list `dom.iterable`.

**Why:** this has bitten twice. A browser app package inherited the DOM-less base
and failed repo-wide typecheck, which also blocked the build and therefore
publishing. Separately, bumping the OpenAPI client generator made it emit
`Headers.entries()`, which needs `dom.iterable` specifically — the package already
had `dom`, so the gap only appeared the next time codegen ran.

**How to apply:**

- Treat `dom` and `dom.iterable` as separate capabilities. Iterating a `Headers`,
  `FormData`, `URLSearchParams`, or `NodeList` needs `dom.iterable`; having `dom`
  alone is not enough.
- After bumping any codegen tool, re-run codegen and typecheck together in the
  same pass. Generated output is not covered by an ordinary dependency update, so
  a bump can sit latent until someone regenerates — and then it looks like their
  change broke the build.
- When typecheck fails inside generated code, check whether the construct exists
  in the committed version first. If it is new, the generator changed and the fix
  belongs in that package's `lib`, not in the generated file, which would be
  overwritten on the next run.
