import { DocLayout, DocList, DocNote, type DocSection } from '@/components/docs/doc-layout';

const sections: DocSection[] = [
  {
    id: 'purpose',
    heading: 'Purpose of this disclaimer',
    body: (
      <>
        <p>
          This Risk Disclaimer identifies the material risks of using the Revo Treasury platform
          (the "Service"). It forms part of your agreement with{' '}
          <strong>Revo Core Technologies</strong> and should be read together with the{' '}
          <a href="/terms" className="text-primary hover:underline">Terms of Service</a> and the{' '}
          <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>.
        </p>
        <p>
          By using the Service you acknowledge that you have read, understood, and accepted every
          risk described below.
        </p>
      </>
    ),
  },
  {
    id: 'no-advice',
    heading: 'No financial advice',
    body: (
      <>
        <p>
          Nothing produced by the Service, including agent responses, proposals, policies, risk
          scores, yield figures, or portfolio metrics, constitutes financial, investment, legal,
          accounting, or tax advice, or a recommendation or solicitation to buy, sell, or hold any
          asset.
        </p>
        <p>
          The Service is AI-assisted treasury software. It is not
          operated by a licensed financial institution, broker, exchange, or investment adviser in
          any jurisdiction.
        </p>
      </>
    ),
  },
  {
    id: 'mainnet-funds',
    heading: 'Mainnet funds',
    body: (
      <>
        <DocNote label="Core fact">
          The Service operates on Arc mainnet and manages <strong>real USDC and EURC</strong>.
          Deposits, withdrawals, and approved trades can result in financial loss.
        </DocNote>
        <DocList
          items={[
            <>Only send supported USDC on Arc to a treasury deposit address.</>,
            <>Approved rebalances execute through Uniswap v4 from the treasury's custody wallet.</>,
            <>Prices, liquidity, and transaction costs can change before a transaction confirms.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'drill-data',
    heading: 'Safety drills',
    body: (
      <>
        <p>
          The safety drill is a simulation used to rehearse emergency response. It does not execute
          trades. Outside that drill, treasury balances and completed transactions reflect on-chain
          activity and should be treated as real.
        </p>
      </>
    ),
  },
  {
    id: 'ai-limitations',
    heading: 'AI model limitations',
    body: (
      <>
        <p>
          Arcus, the treasury agent, is built on a large-language model. Such models can produce
          output that is plausible but incorrect, incomplete, or inconsistent ("hallucination"),
          and may misinterpret instructions.
        </p>
        <DocList
          items={[
            <>Agent output requires human review; the approval workflow exists precisely because the model can be wrong.</>,
            <>In autonomous operating modes, agent-initiated actions remain bounded by security controls, but errors within those bounds are possible.</>,
            <>Model behavior may change as underlying providers update their systems.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'custody-risk',
    heading: 'Custody and key risk',
    body: (
      <>
        <DocList
          items={[
            <>
              <strong>Platform-managed keys.</strong> Treasury deposit wallets are controlled by
              the platform. Despite encryption at rest and strict controls, any server-side key
              system carries a residual risk of compromise or loss.
            </>,
            <>
              <strong>Your wallet is your identity.</strong> If you lose control of your wallet,
              whoever holds it controls your treasury. Revo cannot restore access or reverse
              actions taken by a compromised wallet.
            </>,
            <>
              <strong>Irreversibility.</strong> On-chain transactions, once confirmed, cannot be
              undone by Revo or anyone else.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'protocol-risk',
    heading: 'Protocol and network risk',
    body: (
      <>
        <DocList
          items={[
            <>Smart contracts and network software may contain defects or be exploited.</>,
            <>Block production, finality, RPC availability, and Uniswap v4 liquidity may change; transactions may stall or fail.</>,
            <>Chain identifiers and network parameters are verified at execution time, but network-level misbehavior remains outside the Service's control.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'operational-risk',
    heading: 'Operational risk',
    body: (
      <p>
        The Service is under active development. Features may change or be removed, maintenance
        windows may interrupt availability, and defects may exist despite testing and review.
        Automated jobs (deposit indexing, withdrawal reconciliation, drawdown monitoring) are
        designed to recover from interruption, but delays in processing can occur.
      </p>
    ),
  },
  {
    id: 'no-warranty',
    heading: 'No warranty; assumption of risk',
    body: (
      <>
        <p>
          THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. TO THE MAXIMUM EXTENT
          PERMITTED BY LAW, REVO CORE TECHNOLOGIES DISCLAIMS ALL LIABILITY FOR LOSSES ARISING FROM
          THE RISKS DESCRIBED IN THIS DOCUMENT.
        </p>
        <p>
          By signing in and operating a treasury, you confirm that you understand these risks,
          that the Service can move real funds on Arc mainnet, and that you assume full
          responsibility for every action taken through your wallet.
        </p>
      </>
    ),
  },
];

export default function Risk() {
  return (
    <DocLayout
      code="RVO-LGL-03"
      title="Risk Disclaimer"
      tagline="A plain statement of the risks in an AI-operated Arc mainnet treasury: model fallibility, protocol risk, custody boundaries, and why none of this is financial advice."
      sections={sections}
    />
  );
}
