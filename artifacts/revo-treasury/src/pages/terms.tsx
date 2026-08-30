import { DocLayout, DocList, DocNote, type DocSection } from '@/components/docs/doc-layout';

const sections: DocSection[] = [
  {
    id: 'acceptance',
    heading: 'Acceptance of terms',
    body: (
      <>
        <p>
          These Terms of Service ("Terms") are a binding agreement between you and{' '}
          <strong>Revo Core Technologies</strong> ("Revo", "we", "us") governing your use of the
          Revo Treasury platform: the public website, the operator console, and the underlying
          API (together, the "Service").
        </p>
        <p>
          By connecting a wallet, signing an authentication message, or otherwise using the
          Service, you accept these Terms. If you do not agree, do not use the Service.
        </p>
      </>
    ),
  },
  {
    id: 'the-service',
    heading: 'The Service',
    body: (
      <>
        <p>
          Revo Treasury is an AI-assisted treasury management console operating exclusively on the{' '}
          <strong>Arc Testnet</strong> (chain 5042002). The Service lets an operator:
        </p>
        <DocList
          items={[
            <>Provision a private treasury bound to their wallet.</>,
            <>Deposit and withdraw <strong>testnet USDC</strong> through a platform-managed treasury wallet.</>,
            <>Issue natural-language strategies to Arcus, the treasury agent, which compiles them into validated proposals and policies.</>,
            <>Review, approve, reject, and monitor proposals under configurable security controls.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'testnet-status',
    heading: 'Testnet status',
    body: (
      <>
        <DocNote label="Important">
          The Service operates only on a test network. Testnet tokens have{' '}
          <strong>no monetary value</strong>, are not redeemable for anything of value, and may be
          lost at any time through network resets. Nothing on the Service involves real funds.
        </DocNote>
        <p>
          The Arc Testnet and the Service itself are provided for evaluation and demonstration.
          The network may be reset, forked, or discontinued; the Service may be modified,
          suspended, or withdrawn, in each case at any time and without notice or liability.
        </p>
      </>
    ),
  },
  {
    id: 'access',
    heading: 'Access and identity',
    body: (
      <>
        <DocList
          items={[
            <>
              <strong>Wallet-based identity.</strong> You authenticate by signing a one-time
              message with your wallet. Anyone who controls the wallet controls the treasury bound
              to it; you are solely responsible for securing your keys.
            </>,
            <>
              <strong>One treasury per wallet.</strong> A first-time wallet is provisioned its own
              private treasury automatically and holds the administrator role for it.
            </>,
            <>
              <strong>Eligibility.</strong> You must be legally capable of entering into these
              Terms and must not be barred from using the Service under applicable law.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'custody-model',
    heading: 'Custody model',
    body: (
      <>
        <p>
          Each treasury is assigned a dedicated, platform-managed deposit wallet on the Arc
          Testnet. Its private key is generated server-side, sealed with authenticated encryption,
          and never exposed. Withdrawals are only sent to a wallet that has proven ownership via a
          time-limited cryptographic signature, within enforced security limits.
        </p>
        <DocNote label="Do not">
          Never send mainnet assets, or any asset of value, to a treasury deposit address. The
          Service handles Arc Testnet USDC only; anything else is unrecoverable.
        </DocNote>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    heading: 'Acceptable use',
    body: (
      <>
        <p>You agree not to:</p>
        <DocList
          items={[
            <>Probe, disable, or circumvent authentication, tenant isolation, or security controls.</>,
            <>Access or attempt to access another operator's treasury or data.</>,
            <>Abuse the agent, the API, or the faucet-linked deposit flow through automation designed to exhaust resources.</>,
            <>Use the Service to violate any applicable law or third-party right.</>,
            <>Misrepresent the Service as handling real funds or producing financial advice.</>,
          ]}
        />
        <p>
          We may throttle, suspend, or terminate access that we reasonably believe violates these
          Terms or threatens the integrity of the Service.
        </p>
      </>
    ),
  },
  {
    id: 'ai-agent',
    heading: 'The AI agent',
    body: (
      <>
        <p>
          Arcus is an automated agent powered by a third-party large-language model. Its output,
          including proposals, policy drafts, risk commentary, and chat responses, is{' '}
          <strong>informational tooling, not advice</strong>. It may be incomplete, out of date, or
          wrong.
        </p>
        <DocList
          items={[
            <>Proposals take effect only through the approval workflow and its security guards.</>,
            <>Operating modes (safe, managed, autonomous) control how much latitude the agent has; you choose the mode.</>,
            <>You remain responsible for every action taken in your treasury, whichever mode is active.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'intellectual-property',
    heading: 'Intellectual property',
    body: (
      <p>
        The Service, including its software, design system, branding, and documentation, is
        owned by Revo Core Technologies or its licensors and is protected by applicable
        intellectual-property laws. We grant you a limited, revocable, non-exclusive,
        non-transferable license to use the Service as intended. You retain whatever rights you
        hold in the content of commands you submit.
      </p>
    ),
  },
  {
    id: 'disclaimers',
    heading: 'Disclaimers',
    body: (
      <>
        <p>
          THE SERVICE IS PROVIDED <strong>"AS IS" AND "AS AVAILABLE"</strong> WITHOUT WARRANTY OF
          ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL
          BE UNINTERRUPTED, ERROR-FREE, OR SECURE, OR THAT TESTNET STATE WILL PERSIST.
        </p>
        <p>
          The Service is not a bank, custodian of value, exchange, broker, or investment adviser,
          and nothing in it constitutes financial, legal, or tax advice. See the{' '}
          <a href="risk" className="text-primary hover:underline">Risk Disclaimer</a> for a full
          statement of risks.
        </p>
      </>
    ),
  },
  {
    id: 'liability',
    heading: 'Limitation of liability',
    body: (
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, REVO CORE TECHNOLOGIES AND ITS CONTRIBUTORS SHALL
        NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES,
        INCLUDING LOSS OF DATA, LOSS OF TESTNET ASSETS, OR LOSS OF GOODWILL, ARISING FROM OR
        RELATED TO YOUR USE OF THE SERVICE. BECAUSE THE SERVICE HANDLES ONLY VALUELESS TESTNET
        ASSETS, OUR AGGREGATE LIABILITY FOR ALL CLAIMS SHALL NOT EXCEED ONE HUNDRED U.S. DOLLARS
        (USD 100).
      </p>
    ),
  },
  {
    id: 'termination',
    heading: 'Suspension and termination',
    body: (
      <p>
        You may stop using the Service at any time. We may suspend or terminate access, in whole
        or in part, for any operator or for everyone, where reasonably necessary for security,
        legal compliance, testnet lifecycle events, or discontinuation of the Service. Sections
        that by their nature should survive termination (including intellectual property,
        disclaimers, and limitation of liability) survive.
      </p>
    ),
  },
  {
    id: 'changes',
    heading: 'Changes to these terms',
    body: (
      <p>
        We may revise these Terms from time to time. Material changes will be reflected in the
        version number and effective date at the top of this document. Your continued use of the
        Service after a change takes effect constitutes acceptance of the revised Terms.
      </p>
    ),
  },
  {
    id: 'general',
    heading: 'General provisions',
    body: (
      <>
        <DocList
          items={[
            <>
              <strong>Entire agreement.</strong> These Terms, the Privacy Policy, and the Risk
              Disclaimer form the entire agreement between you and Revo regarding the Service.
            </>,
            <>
              <strong>Severability.</strong> If any provision is held unenforceable, the remainder
              stays in effect.
            </>,
            <>
              <strong>No waiver.</strong> Failure to enforce a provision is not a waiver of it.
            </>,
            <>
              <strong>Assignment.</strong> You may not assign these Terms; we may assign them in
              connection with a reorganization or transfer of the Service.
            </>,
            <>
              <strong>Governing law.</strong> These Terms are governed by the laws applicable in
              the jurisdiction where Revo Core Technologies is organized, without regard to
              conflict-of-law rules.
            </>,
          ]}
        />
      </>
    ),
  },
];

export default function Terms() {
  return (
    <DocLayout
      code="RVO-LGL-02"
      title="Terms of Service"
      tagline="The agreement governing use of the Revo Treasury platform on Arc Testnet: wallet-based access, the custody model, the AI agent's boundaries, and what we each take responsibility for."
      sections={sections}
    />
  );
}
