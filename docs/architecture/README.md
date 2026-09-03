# Revo — System Architecture

Autonomous treasury intelligence on **Arc Testnet** (chainId `5042002`), settling in
native USDC (`0x3600000000000000000000000000000000000000`, 6 decimals).

![Revo architecture](./revo-architecture.png)

Vector source: [`revo-architecture.svg`](./revo-architecture.svg)

---

## What is real, and what is not

This distinction is deliberate and is enforced throughout the product.

| Capability | Status |
| --- | --- |
| USDC deposits to the treasury | **Real Arc Testnet transactions** |
| USDC withdrawals from the treasury | **Real Arc Testnet transactions** |
| Deposit indexing, confirmations, reorg handling | **Real**, against Arc Testnet logs |
| Withdrawal reconciliation and refunds | **Real** |
| Strategic rebalance across sleeves | Simulated — internal accounting only |
| Yield sleeves (`aUSDC`, `sUSDC`) | Labels, not protocol positions |
| Emergency drill | Explicitly simulated |

Simulated rebalances are never presented as on-chain execution, in the UI, the API,
or the agent's own responses.

---

## Flow

```mermaid
flowchart TB
  classDef real fill:#111,stroke:#FC3B00,color:#fff
  classDef plain fill:#111,stroke:#2A2A2A,color:#fff
  classDef sim fill:#0D0D0D,stroke:#6B6B6B,color:#B8B8B8,stroke-dasharray:5 4

  subgraph IDP["01 · Identity plane"]
    direction LR
    WAL["Browser wallet<br/>EIP-6963 discovery"]:::plain
    SIG["Wallet sign-in<br/>EIP-191 nonce then verify"]:::plain
    SES["Server session<br/>HttpOnly, treasury-scoped"]:::plain
    WAL --> SIG --> SES
  end

  subgraph SIGNALS["Signal inputs (read-only)"]
    direction TB
    SRC["CoinGecko quote · ETH momentum · USDC peg<br/>Arc whale watch · GitHub activity · news RSS"]:::plain
  end

  subgraph DEC["02 · Decision plane — api-server"]
    direction TB
    COMP["Arcus policy compiler<br/>Claude, natural language to draft policy"]:::plain
    QA["Arcus grounded Q and A<br/>no execution authority"]:::plain
    ENG["Deterministic policy engine<br/>allocation 5-35%, reserve 25-80%, drawdown 5-30%"]:::real
    PROP["Proposal lifecycle<br/>draft, approve, execute"]:::plain
    MODE["Operating modes<br/>Managed gate or Autonomous in-policy"]:::plain
    REB["Simulated rebalance<br/>internal accounting, not a swap"]:::sim
    COMP --> ENG
    ENG --> PROP
    ENG -.-> REB
    PROP --> MODE
  end

  subgraph SET["03 · Settlement plane — Arc Testnet, real on-chain"]
    direction TB
    DEP["Deposit — user wallet, USDC transfer,<br/>log verify at 12 confirmations, idempotent credit"]:::real
    WDR["Withdraw — EIP-191 destination auth, balance reserve,<br/>custody EIP-1559 signing, broadcast, reconcile"]:::real
  end

  subgraph WRK["04 · Durable workers — single leader, lease and fencing"]
    direction LR
    IDX["deposit-indexer · 30s"]:::plain
    REC["withdrawal-reconciler · 30s"]:::plain
    DDM["drawdown-monitor · 60s"]:::plain
  end

  DB[("PostgreSQL · Drizzle")]:::plain

  SES --> DEC
  SRC --> QA
  MODE --> SET
  SET --> WRK
  WRK --> DB
  DEC --> DB
  REB --> DB
```

---

## Custody and controls

- Per-treasury EOA, key material encrypted at rest with **AES-256-GCM envelope
  encryption**; the data key is wrapped by an HKDF-SHA256-derived master secret.
- The key is unsealed in memory only for the duration of a single signing call and
  is never persisted in plaintext. JavaScript offers no zeroization guarantee, so
  this is scope-limited in-memory use rather than cryptographic erasure.
- The chain guard rejects any `chainId` other than `5042002` before every read and
  every broadcast.
- Withdrawal caps: 25k per transaction, 50k per wallet per rolling 24h, 100k global
  per rolling 24h — all admin-configurable.
- Emergency pause blocks withdrawals, approvals, and mode changes. Safe mode makes
  policies and proposals review-only; it does not by itself block withdrawals.
- Role-based access: Strategist issues commands, Approver decides, Guardian controls
  mode and security. Every decision is written to an append-only audit trail.

## Runtime topology

| Service | Role |
| --- | --- |
| `artifacts/revo-treasury` | React + Vite frontend, marketing and operator console |
| `artifacts/api-server` | Express API, policy engine, custody, workers |
| `lib/api-spec` | OpenAPI contract — source of truth for client and validation |
| `lib/db` | Drizzle schema |

The browser and API communicate over relative `/api` URLs, so one build works in
both development and production.
