# Revo on Arc Mainnet

Research report and migration plan. Prepared 19 September 2026, three days after the Arc public mainnet launch.

This document has three parts:

1. What launched on 16 September and how it differs from the testnet Revo runs on today.
2. What in Revo is tied to the testnet and what must change.
3. A phased plan to take Revo to mainnet safely, with real money.

All network facts below come from Circle, Arc, Synthra, Tower and Uniswap documentation or press releases published on or after 16 September 2026. Links are at the end.

---

## Part 1. What launched on 16 September

### The basics

| Item | Arc Mainnet | Arc Testnet (what Revo uses today) |
| --- | --- | --- |
| Status | Public mainnet live since 16 September 2026, after a private mainnet with 100+ builders | Live since October 2025, continues to run |
| Chain ID | 5042 | 5042002 |
| Primary RPC | https://rpc.mainnet.arc.io | https://rpc.testnet.arc.io |
| Other RPC providers | Alchemy, Blockdaemon, dRPC, QuickNode (HTTP and WebSocket) | Same providers |
| Gas token | USDC | USDC |
| Typical fee | Base fee targets about 0.001 USD per ERC-20 transfer; max base fee 20,000 gwei | Roughly 0.004 USD per transaction |
| Finality | Under one second, deterministic, no reorgs (Malachite BFT) | Same |
| Explorer | explorer.arc.io (Blockscout, marked permissioned in the docs); arc-scan.org is an independent explorer with a REST API | explorer.testnet.arc.io, testnet.arcscan.app |
| Validators | Permissioned set of 11 founding institutions: BlackRock, DTCC, Galaxy, ICE, Mastercard, MoneyGram, SBI Group, Standard Chartered, Sumitomo Corporation, Visa, Worldpay | Circle-run |
| Deploying contracts | Permissionless | Permissionless |
| Faucet | None. Real USDC only | faucet.circle.com |

Two things did not change and that is good news for Revo: USDC is still the gas token with the same dual interface (native 18-decimal accounting, ERC-20 interface at `0x3600...0000` with 6 decimals), and finality is still one block. The gas handling and settlement logic Revo already has carries over.

### The ARC token

Circle minted 10 billion ARC at genesis. It is described as a coordination mechanism for security, utility and governance. It is not the gas token and a public launch of the token is still undecided. Nothing in Revo needs to know about ARC.

### Mainnet contract addresses

| Contract | Mainnet address |
| --- | --- |
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000` (same as testnet) |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` (testnet was `0x89B5...D72a`) |
| USYC | `0x8a5D989Bbb96929F689B0200f435f53dA42bF490` |
| CCTP TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Gateway Wallet | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Gateway Minter | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| StableFX (FxEscrow) | `0xe2E5F173576B513d994073CCbDaCBE027d43DFe6` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |

### Who is live on day one (the parts that matter to Revo)

| Service | Mainnet status | Why it matters to Revo |
| --- | --- | --- |
| Synthra (V3 DEX, Revo's execution venue) | Deployed on Arc mainnet, chain 5042. Factory `0x6307fc239C7964942c1BfFE51930E55606619c74`, SwapRouter02 `0xa50eDe66a573eE5bB37E28AF5789B76aE5FEb828`, QuoterV2 `0x9c179A7335B3fc841F59Aa6a62daf6d5c61b65D7`, NonfungiblePositionManager `0x2743b771659fD9CE13970d7367e7e84AF6a31049`. Synthra's docs note the 1 percent fee tier is enabled on the factory and ask integrators to verify the pool init code hash before writing. | Same protocol family as testnet, so Revo's quoting and swap code can be pointed at new addresses. Pool depth on a three-day-old chain must be measured before any trade. |
| Uniswap | v2, v3, v4 and UniswapX live at launch. v4 on chain 5042: PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, V4Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`, UniversalRouter `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`, StateView `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b`. Uniswap also shipped a StablePair hook that recomputes the fee on every swap for stable pairs. | Best candidate for a second venue, so Revo is not dependent on one DEX. The StablePair hook is built for exactly the USDC and EURC trade Revo does most. |
| Tower (aggregator, Revo's token registry cross-check) | Same API base URL for mainnet and testnet (`https://www.tower.exchange/api/public`), chain id passed per request. API key required. Site lists USDC, EURC, USDT and cirBTC; confirm the mainnet token list through its tokens endpoint for chain 5042. | Small change: pass 5042 instead of 5042002 and re-verify the returned addresses against Revo's pinned list. |
| Circle Gateway and CCTP V2 | Arc mainnet is a supported Gateway chain (domain 26). App Kit Unified Balance supports Arc. | Revo's cross-chain balance panel already uses App Kit. Depositors can bring USDC from any supported chain. |
| Aave V4, Morpho | Live at launch with new markets on Arc | Possible yield venues later. Not needed for the first mainnet release. |
| Bridges | Across, Axelar, Stargate, Wormhole | Routes for bringing assets in. Also where bridged BTC or ETH would come from if Revo ever wants a non-stable sleeve. |
| Exchanges and custody | Kraken supports USDC on Arc deposits and withdrawals from day one. Fireblocks and BitGo support Arc. | Real on-ramp for depositors. Fireblocks or BitGo are options for institutional-grade custody of Revo's treasury keys. |

### Rules that are new for a mainnet app

**USDC blocklist enforcement.** Arc enforces Circle's USDC blocklist at three levels: the RPC rejects a blocked sender before the mempool, the mempool rejects it before execution, and a transfer that touches a blocked address during execution reverts at runtime. A runtime revert still burns gas and the receipt comes back with `status = 0`. Apps must handle both the up-front rejection and the on-chain revert, and must check `receipt.status` rather than assume a mined transaction succeeded. Transactions sent through the Memo or Multicall3From contracts need extra work to attribute the real sender.

**USYC is restricted.** It is a tokenized money market fund available only to non-US persons and institutions, with onboarding and a minimum investment. It is not a token an open treasury agent can hold by default.

**cirBTC on mainnet is unconfirmed.** Revo already refuses to trade cirBTC on testnet because the pool is too thin and mispriced. Whether a meaningful cirBTC market exists on mainnet is not yet clear from public sources. Treat it as not available until measured.

---

## Part 2. What in Revo is tied to the testnet

Revo was built as a testnet-only product and says so in many places. The chain id, RPC URL, explorer, faucet, token addresses and venue addresses are constants in the API server, and the wording "Arc Testnet" or "testnet-only" appears in over 30 source files.

| Area | Today | Mainnet impact |
| --- | --- | --- |
| Chain identity | Chain id 5042002 pinned in the chain client, the Synthra module and the Tower module. Every on-chain call checks the node reports 5042002. | Must become a single network setting that drives all three. The chain id check is a safety feature and stays. |
| RPC | One URL (`ARC_TESTNET_RPC_URL`, default Circle testnet). A second, differently configured URL is used for the status probe. | Mainnet has five providers. Revo should use a list with automatic failover, and one list for both trading and status. |
| Explorer and faucet | Links point at testnet Arcscan and the Circle faucet. The console's activation flow tells depositors to use the faucet. | Faucet step is removed on mainnet. Deposit guidance becomes "send USDC on Arc from an exchange, or bring it from another chain through Gateway". Explorer links switch to arc-scan.org or explorer.arc.io. |
| Token set | USDC, EURC (testnet address), cirBTC (held, priced, never traded). | USDC address is unchanged. EURC gets the new address. cirBTC is dropped unless a mainnet pool passes the same depth and price checks. USDT may be added if a venue lists it with depth. |
| Venues | Synthra testnet Factory, Router and Quoter addresses. Fee tiers 0.05, 0.3 and 1 percent probed. | New Synthra addresses. Check which fee tiers actually have pools. Add Uniswap v4 as a second venue with independent quoting. |
| Tower | Chain id 5042002 in the registry request. | Pass 5042. Keep the rule that Tower is a cross-check and never a trade authorisation. |
| Cross-chain panel | App Kit against Arc testnet. | Point at mainnet; Arc domain 26. |
| Deposit indexer | Reads testnet transfer logs. | Same code against mainnet; consider the Arcscan REST API as a second source for reconciliation. |
| Custody | Private keys encrypted with AES-256-GCM envelope encryption; the master secret lives in an environment variable on the same server as the app. | Acceptable for test money. Not acceptable for real money at scale (see Part 3). |
| Policy limits | Percent caps only: max 35 percent in one protocol, min 25 percent USDC, drawdown 5 to 30 percent; per-trade price impact 5 percent, pool share 10 percent, slippage 0.5 percent. | Percent caps stay. Absolute money caps (per trade, per day, per treasury) must be added. |
| Copy and prompts | The agent's system prompt and the policy compiler say "TESTNET-ONLY". Landing page, docs, terms, privacy, risk page, README and the OpenAPI spec describe a testnet product. | Full copy sweep. Legal pages need real-money disclosures. |
| Drill and Safe mode | Drill overlays simulated states on the dashboard; Safe mode refuses commands and execution. | Both stay. Drill must be clearly separated from mainnet state so a drill can never be mistaken for real positions. |

---

## Part 3. The changes, grouped by kind

### A. Code changes (needed to run on mainnet at all)

1. **One network switch.** Introduce `ARC_NETWORK=testnet|mainnet`. It selects the chain id, RPC list, explorer, faucet (none on mainnet), USDC and EURC addresses, Synthra and Uniswap addresses, Tower chain id, and Gateway domain. Nothing else in the codebase should name a chain id or an address directly. Testnet stays fully working as the staging environment.

2. **RPC failover.** Configure Circle primary plus at least two of Alchemy, QuickNode, dRPC and Blockdaemon. Rotate on timeout or error, keep the chain id check on every provider, and expose which provider is active on the health endpoint. This also fixes the biggest single point of failure Revo has today.

3. **Mainnet token set.** USDC and EURC (new address) as the base. Every other token must pass the existing checks (pool depth, price within tolerance of the reference market) on mainnet before it is marked tradable. Do not include USYC. Drop cirBTC until a real pool is measured.

4. **Venues.** Point Synthra at the mainnet contracts and verify the pool init code hash as their docs ask. Add Uniswap v4 as a second venue using V4Quoter and StateView for quoting, UniversalRouter for execution. Route to whichever venue gives the better net output after the same safety checks; refuse the trade if neither passes.

5. **Blocklist-aware settlement.** Treat an RPC rejection ("blocked sender") as a permanent failure that pauses the treasury and alerts an operator. Treat a mined transaction with `status = 0` as a failed transfer that still cost gas. Before every deposit credit and every withdrawal, check the counterparty against the current blocklist events. Never retry a blocked transfer automatically.

6. **Deposit flow without a faucet.** Replace the faucet step with clear deposit instructions: the treasury address, a QR code, the note that only USDC on Arc (chain 5042) is accepted, and a Gateway option for USDC on other chains. Show the deposit as pending until the indexer confirms it.

7. **Explorer and indexing.** Link transactions to arc-scan.org (mainnet) and use its REST API (`https://api.arc-scan.org/v1`) as a second source when reconciling balances and deposits.

8. **Gas in real dollars.** Keep the "spendable, not held" rule for USDC. Add a per-rebalance gas budget in USD and show the actual gas spent per leg in the activity log. Refuse a rebalance whose expected gas is above a small fixed share of the amount moved.

9. **Copy sweep.** Remove "testnet-only" from the agent prompt, the policy compiler prompt, landing page, docs, README, OpenAPI descriptions and page metadata. Rewrite terms, privacy and risk pages for real funds. Keep a visible network badge (TESTNET or MAINNET) in the console header at all times.

### B. Safety changes (needed before real money, not optional)

1. **Custody upgrade.** Move signing out of the app process. Options, in rough order of strength: a dedicated signer service with keys in a cloud KMS or HSM; an MPC provider such as Fireblocks, BitGo or Turnkey, which also enforces spending policies at the signer; or a smart-account setup where the agent's key can only call approved venues with approved tokens up to approved limits. Whatever the choice, the app should be able to ask for a signature but never able to read a private key.

2. **Absolute money caps.** Per trade, per day and per treasury caps in USD, enforced server-side and, if an MPC provider is used, at the signer too. Start the pilot with a small cap (for example 10,000 USD per treasury) and raise it in steps.

3. **Auto exit and stale data rules.** If a risk token falls more than a set percent, sell back to USDC without waiting for approval. If the price feed is older than a few minutes, refuse to trade. If the on-chain balance disagrees with the ledger, pause.

4. **A pause that holds even if the app is compromised.** Today pause is enforced in the app. With MPC or a smart-account guard, the same pause can also be enforced at the signer, so a bug or a stolen session cannot move funds while paused.

5. **Monitoring and alerts.** Extend the health endpoint to cover every RPC provider, Synthra, Uniswap, Tower, Gateway and the AI service. Send alerts to Telegram or email on any degradation, on any failed settlement, and on any outflow the policy engine did not initiate. Reconcile wallet balances against the ledger every few minutes.

6. **Independent security review.** A third-party review of custody, settlement, authentication and the policy engine before external depositors are allowed. Run the dependency and static scans in CI. Keep the vulnerability reporting channel in SECURITY.md open.

7. **Production hygiene.** Separate production database with point-in-time recovery, rotated secrets, rate limits on every write route, request logging with tamper-evident audit records (already partly there), and a written incident runbook: how to pause, how to rotate keys, how to drain the treasury to a cold wallet.

### C. Product and legal (not code, but decide before launch)

- **Whose money.** Running the treasury only for Revo's own funds is a very different position from accepting outside depositors. Accepting and managing other people's funds may need registration or a licence depending on where Revo and the depositors are. Get legal advice before Phase 3 below. This report is not legal advice.
- **Sanctions and KYC.** Circle's blocklist is not a KYC programme. If outside depositors are allowed, decide how they are screened.
- **Transparency.** Publish the treasury address and a live proof-of-holdings page backed by the Arcscan API. It is cheap and builds trust.
- **Insurance and limits.** Decide how much loss the project can absorb and set the caps below that.

### D. Phased rollout

| Phase | What runs | Money at risk | Gate to move on |
| --- | --- | --- | --- |
| 0. Prepare (testnet stays live) | Network switch, RPC failover, mainnet token and venue config, blocklist handling, copy sweep. Point a read-only instance at mainnet: balances, quotes and health only, no execution. | None | All tests pass on both networks; mainnet quotes match Synthra and Uniswap UIs; health endpoint green. |
| 1. Observe | Mainnet with Revo's own funds, tiny amounts (a few hundred USD). Agent proposes, a human approves, Managed mode only. Small money caps on. | Very small | Two weeks of clean settlements, gas reporting correct, no reconciliation drift. |
| 2. Managed with real limits | Custody upgrade done. Absolute caps enforced. Auto exit live. Monitoring and alerts live. Still Revo's own funds, larger but capped. | Capped, own funds | Security review complete, incident runbook rehearsed, pause verified end to end. |
| 3. Open | Outside depositors, if legal review allows. Autonomous mode only within tight caps. Transparency page live. | Depositor funds | Ongoing: monthly reconciliation reports, cap reviews, dependency updates. |

### E. Rough effort

- Phase 0 code work: two to three weeks for one developer. The network switch and copy sweep are wide but mechanical; RPC failover, the Uniswap v4 venue and blocklist handling are the real engineering.
- Custody upgrade: one to three weeks depending on the provider chosen, plus provider onboarding time.
- Security review: depends on the reviewer; budget four to six weeks of calendar time.

### F. What not to do

- Do not flip the existing testnet deployment to mainnet by changing one URL. Too many assumptions live outside that URL.
- Do not carry cirBTC or add any token whose pool has not been measured on mainnet.
- Do not let the agent execute on mainnet before absolute money caps exist.
- Do not accept outside funds before the custody upgrade and a legal review.

---

## Sources

- Circle press release, 16 September 2026: https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet
- Arc blog, mainnet launch: https://www.arc.io/blog/arc-mainnet-goes-live-on-september-16-2026
- Circle, founding validator cohort (5 August 2026): https://www.circle.com/pressroom/circle-announces-founding-validator-cohort-and-major-integrations-for-arc-ahead-of-september-16-mainnet-launch
- Arc docs, RPC endpoints: https://docs.arc.io/arc/references/rpc-endpoints
- Arc docs, contract addresses: https://docs.arc.io/arc/references/contract-addresses
- Arc docs, gas and fees: https://docs.arc.io/arc/references/gas-and-fees
- Arc docs, deployment model: https://docs.arc.io/arc/concepts/deployment-model
- Arc docs, integrate overview: https://docs.arc.io/integrate
- Arc docs, blocklist compliance: https://docs.arc.io/integrate/infrastructure/compliance
- Arc docs, App Kit Unified Balance: https://docs.arc.io/app-kit/unified-balance
- Circle Gateway supported blockchains: https://developers.circle.com/gateway/references/supported-blockchains
- Circle, USYC overview and eligibility: https://developers.circle.com/tokenized/usyc/overview
- Synthra docs, contract addresses: https://docs.synthra.org/docs/contract-addresses
- Tower developer console overview: https://docs.tower.exchange/developer-console/overview
- Uniswap blog, Uniswap is live on Arc: https://blog.uniswap.org/uniswap-is-live-on-arc
- Uniswap v4 deployments: https://docs.uniswap.org/docs/protocols/v4/deployments
- Arcscan docs and API: https://docs.arc-scan.org/docs/api
- The Block, 16 September 2026: https://www.theblock.co/news/ecosystems/2026-09-16-circle-launches-arc-mainnet-with-blackrock-and-visa-among-validators-mints-10-billion-arc-tokens-415250
- Kraken, USDC on Arc deposits and withdrawals: https://blog.kraken.com/product/new-features/usdc-on-arc-deposits-and-withdrawals-now-available
