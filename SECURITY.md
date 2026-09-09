# Security Policy

Revo holds testnet USDC in per-treasury custody wallets and signs transactions on an
operator's behalf. Even on testnet we treat custody, authorisation and money-movement bugs as
security issues and want to hear about them privately first.

## Scope

Anything in this repository, in particular:

- Wallet sign-in, sessions, nonces and the fresh sign-in (step-up) requirement
- Role checks on API routes and the treasury scoping of every query
- Custody key handling (envelope encryption, unsealing, signing)
- Withdrawal reservation, caps and the emergency pause
- Policy engine clamps, proposal or policy approval, and autonomous execution
- Rebalance settlement on Arc (quoting, simulation, broadcast, reconciliation)
- The background workers and their leader lease
- The public site and console (XSS, CSRF, information leaks)

Out of scope: issues in Arc, Circle, Synthra, Tower or Anthropic themselves (report those
upstream), rate limiting of the public marketing pages, and findings that require a compromised
operator device or browser extension.

## Reporting a vulnerability

Please do not open a public issue for security problems.

1. Use GitHub private vulnerability reporting:
   https://github.com/Creepy-Cr/Revo/security/advisories/new
2. If that is unavailable, send a direct message to [@RevoLabsHQ](https://x.com/RevoLabsHQ)
   on X asking for a private channel, without including details in the message.

Include what you found, the impact you believe it has, steps to reproduce (a curl command or a
short script is ideal) and any suggested fix. Please give us a reasonable window to respond
before disclosing publicly.

## What to expect

- Acknowledgement within 3 working days.
- An initial assessment and severity within 7 days.
- A fix or mitigation for confirmed high and critical issues as quickly as we responsibly can,
  followed by a credit in the release notes if you would like one.

There is no bug bounty programme at this time.

## Supported versions

Revo is pre-release and only the `main` branch is supported. The public deployment at
https://therevo.xyz tracks `main`.

## Good practice for operators

- Never share the session cookie or reuse the custody master secret between environments.
- Set `CUSTODY_MASTER_SECRET` and `SESSION_SECRET` to long random values in production.
- Use the emergency pause if you suspect anything is wrong; it blocks withdrawals, approvals and
  autonomous execution until an admin lifts it.
