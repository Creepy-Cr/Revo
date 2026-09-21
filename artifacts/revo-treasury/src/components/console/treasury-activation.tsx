import { ArrowDownToLine, TerminalSquare, ArrowUpRight } from 'lucide-react';

/**
 * First-run experience: replaces the dead zero-state dashboard (NAV $0,
 * "Insufficient Data", empty allocations) with a directed activation path.
 * Shown whenever the treasury holds nothing - the single correct next action
 * is funding it, so the overview says exactly that instead of graphing zeros.
 */
export function TreasuryActivation({ onNavigate }: { onNavigate: (view: string) => void }) {
  const steps = [
    {
      index: '01',
      title: 'Get USDC on Arc',
      body: 'Transfer real USDC to Arc mainnet from a supported exchange or bridge.',
      meta: 'ARC MAINNET / REAL FUNDS',
      action: (
        <a
          href="https://arc-scan.org"
          target="_blank"
          rel="noreferrer"
          data-testid="link-activation-explorer"
          className="inline-flex items-center gap-2 px-5 py-3 text-[11px] font-mono uppercase tracking-[0.12em] font-bold text-white/90 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] rounded-[4px] transition-colors whitespace-nowrap"
        >
          ARC EXPLORER <ArrowUpRight className="w-3 h-3 text-white/40" />
        </a>
      ),
      highlight: false,
    },
    {
      index: '02',
      title: 'Fund the treasury',
      body: 'One transaction moves USDC from your wallet into treasury custody. Every figure on this console starts computing from that moment.',
      meta: 'ON-CHAIN · WITHDRAWABLE ANY TIME',
      action: (
        <button
          onClick={() => onNavigate('wallet')}
          data-testid="button-activation-deposit"
          className="inline-flex items-center gap-2 px-5 py-3 text-[11px] font-mono uppercase tracking-[0.12em] font-bold text-white bg-primary hover:bg-orange-600 rounded-[4px] transition-all shadow-[0_4px_16px_rgba(252,59,0,0.35)] whitespace-nowrap"
        >
          <ArrowDownToLine className="w-3.5 h-3.5" /> DEPOSIT USDC
        </button>
      ),
      highlight: true,
    },
    {
      index: '03',
      title: 'Give Arcus its first rule',
      body: 'Write a mandate in plain English ("keep 40% liquid at all times") and Arcus compiles it into enforced policy.',
      meta: 'NATURAL LANGUAGE → POLICY ENGINE',
      action: (
        <button
          onClick={() => onNavigate('execution')}
          data-testid="button-activation-command"
          className="inline-flex items-center gap-2 px-5 py-3 text-[11px] font-mono uppercase tracking-[0.12em] font-bold text-white/90 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] rounded-[4px] transition-colors whitespace-nowrap"
        >
          <TerminalSquare className="w-3.5 h-3.5" /> OPEN COMMAND
        </button>
      ),
      highlight: false,
    },
  ];

  return (
    <div className="console-card !p-0 overflow-hidden" data-testid="panel-treasury-activation">
      {/* Masthead */}
      <div className="p-6 md:p-10 lg:p-12 border-b border-white/[0.08]">
        <div className="flex items-center justify-between mb-6">
          <div className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2">
            <span className="text-white/40">SYS //</span> TREASURY ACTIVATION
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.15em] text-primary uppercase">
            <span className="w-1.5 h-1.5 bg-primary animate-pulse shadow-[0_0_8px_rgba(252,59,0,0.6)]" />
            UNFUNDED
          </div>
        </div>
        <h2 className="text-3xl md:text-5xl font-display font-medium text-white tracking-tight leading-[1.05] max-w-2xl">
          Your treasury is live.
          <br />
          <span className="text-white/40">Now put money in it.</span>
        </h2>
        <p className="mt-5 text-sm md:text-[15px] text-muted-foreground leading-relaxed max-w-xl">
          Nothing on this console is demo data; every number is computed from
          real Arc mainnet deposits, so it all reads zero until your first
          USDC lands in custody. Three steps and Arcus goes to work.
        </p>
      </div>

      {/* Step ledger */}
      <div className="divide-y divide-white/[0.08]">
        {steps.map((step) => (
          <div
            key={step.index}
            className={`flex flex-col md:flex-row md:items-center gap-4 md:gap-6 px-6 md:px-10 lg:px-12 py-6 transition-colors ${
              step.highlight ? 'bg-primary/[0.04] border-l-2 border-l-primary' : 'border-l-2 border-l-transparent hover:bg-white/[0.02]'
            }`}
          >
            <div className={`font-mono text-xs font-bold tabular-nums shrink-0 w-8 ${step.highlight ? 'text-primary' : 'text-white/30'}`}>
              {step.index}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-3 flex-wrap">
                <h3 className="text-lg md:text-xl font-display font-medium text-white tracking-tight">{step.title}</h3>
                <span className="text-[9px] font-mono tracking-[0.12em] text-white/30 uppercase tabular-nums">{step.meta}</span>
              </div>
              <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed max-w-lg">{step.body}</p>
            </div>
            <div className="shrink-0">{step.action}</div>
          </div>
        ))}
      </div>

      {/* Footer strip */}
      <div className="px-6 md:px-10 lg:px-12 py-4 border-t border-white/[0.08] bg-[#050505] text-[10px] font-mono uppercase tracking-[0.12em] text-white/30 leading-relaxed">
        ARC MAINNET USES REAL FUNDS. DEPOSITS STAY WITHDRAWABLE, AND ARCUS ACTS ONLY WITHIN YOUR MANDATE.
      </div>
    </div>
  );
}
