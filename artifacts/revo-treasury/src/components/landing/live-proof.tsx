import { motion, useScroll, useTransform } from 'framer-motion';
import { useMemo, useRef } from 'react';
import { type TreasuryDashboard, type PortfolioPoint } from '@workspace/api-client-react';
import { LayoutGrid, Wallet, Activity, FileText, Shield, Sparkles, Send } from 'lucide-react';
import { Metrics } from '@/components/console/metrics';
import { Allocations } from '@/components/console/allocations';
import { NavChart } from '@/components/console/nav-chart';
import { Link } from 'wouter';

/**
 * Landing-page showcase terminal. Renders the REAL console components
 * (Metrics / NavChart / Allocations) with a seeded, clearly-labelled demo
 * state - so the marketing mock is always pixel-identical to the app, and
 * the public landing page never calls authed endpoints (no 401s signed out).
 */

// Coherent seeded state: allocations sum exactly to NAV, dayChange equals
// the 24h return of the seeded history below, riskScore follows the server
// formula (risk%*1.2 + max(0, 25 - liquid%)*3, rounded), and Arcus's reply
// references the same liquid-reserve gap the bars show. Symbols are the real
// Arc tokens the treasury can hold, so the marketing mock cannot drift into
// advertising assets that do not exist.
const SEEDED_NAV = 2_847_394;

const SEEDED_DASHBOARD: TreasuryDashboard = {
  totalValue: SEEDED_NAV,
  valuation: { complete: true },
  funded: true,
  dayChange: 1.42,
  deployed: 61.8,
  riskScore: 74,
  // status is the operating mode as the console badges it, so the mock shows
  // a label the real dashboard can actually return for the mode beside it.
  status: 'MANAGED',
  network: 'Arc',
  mode: 'managed',
  allocations: [
    { symbol: 'USDC', name: 'Liquid reserve', percentage: 38.2, value: 1_087_705, units: 1_087_705, tone: 'cyan', source: 'onchain', tradable: true },
    { symbol: 'EURC', name: 'Euro exposure', percentage: 61.8, value: 1_759_689, units: 1_516_973, tone: 'violet', source: 'onchain', tradable: true },
  ],
  portfolioHistory: [],
  activities: [],
  guardrails: [],
  drill: { active: false, phase: 'idle', progress: 0, startedAt: null },
};

// 24h of NAV drift ending at the seeded NAV - deterministic shape, hourly
// points. First point is chosen so (last - first) / first === +1.42%, the
// exact dayChange shown in the metrics strip.
const NAV_SHAPE = [
  2_807_527, 2_811_940, 2_808_660, 2_815_310, 2_819_080, 2_816_450, 2_822_760, 2_827_930,
  2_824_510, 2_830_880, 2_835_420, 2_832_190, 2_838_640, 2_836_280, 2_842_510, 2_839_770,
  2_844_930, 2_843_050, 2_846_480, 2_844_710, 2_846_930, 2_845_820, 2_846_710, SEEDED_NAV,
];

// Dev-only consistency guard so future marketing edits can't quietly
// reintroduce contradictory figures (label saying one return, chart another).
if (import.meta.env.DEV) {
  const allocSum = SEEDED_DASHBOARD.allocations.reduce((s, a) => s + a.value, 0);
  const chartReturn = Math.round(((NAV_SHAPE[NAV_SHAPE.length - 1] - NAV_SHAPE[0]) / NAV_SHAPE[0]) * 10000) / 100;
  if (allocSum !== SEEDED_NAV || chartReturn !== SEEDED_DASHBOARD.dayChange) {
    console.error(
      `[live-proof] seeded showcase incoherent: allocations sum ${allocSum} vs NAV ${SEEDED_NAV}; chart return ${chartReturn}% vs dayChange ${SEEDED_DASHBOARD.dayChange}%`,
    );
  }
}

const RAIL_TABS = [
  { icon: LayoutGrid, active: true },
  { icon: Wallet, active: false },
  { icon: Activity, active: false },
  { icon: FileText, active: false },
  { icon: Shield, active: false },
];

export function LiveProof() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "end start"]
  });

  const y = useTransform(scrollYProgress, [0, 1], [100, -100]);
  const opacity = useTransform(scrollYProgress, [0, 0.2, 0.8, 1], [0, 1, 1, 0]);

  const history: PortfolioPoint[] = useMemo(() => {
    const now = Date.now();
    return NAV_SHAPE.map((value, i) => ({
      label: new Date(now - (NAV_SHAPE.length - 1 - i) * 60 * 60_000).toISOString(),
      value,
    }));
  }, []);

  return (
    <section id="live-proof" className="relative py-32 px-4 min-h-screen flex items-center justify-center overflow-hidden" ref={containerRef}>

      <motion.div
        style={{ y, opacity }}
        className="w-full max-w-6xl z-10 animate-idle-float"
      >
        <div className="glass glass-frosted relative rounded-2xl overflow-hidden transition-all duration-700 hover:border-white/[0.12] hover:shadow-[0_20px_80px_-20px_rgba(252,59,0,0.2),inset_0_1px_1px_rgba(255,255,255,0.2)]">

          {/* Beam Landing Horizon */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-4/5 h-[1px] bg-gradient-to-r from-transparent via-white/60 to-transparent z-50 opacity-70" />

          {/* Window chrome */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] bg-white/[0.01]">
            <div className="flex items-center gap-4">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
                <div className="w-2.5 h-2.5 rounded-full bg-white/10" />
              </div>
              <div className="h-4 w-px bg-white/10" />
              <div className="text-xs text-muted-foreground font-mono tracking-[0.14em] uppercase tabular-nums">
                Revo Live Terminal
              </div>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-[0.15em] uppercase">
              <span className="w-1.5 h-1.5 bg-primary shadow-[0_0_8px_rgba(252,59,0,0.6)]" />
              <span className="text-primary/90">SHOWCASE // SEEDED STATE</span>
            </div>
          </div>

          {/* Console body - mirrors /app: icon rail | main | Arcus rail */}
          <div className="flex">

            {/* Icon rail (real sidebar shape) */}
            <div className="hidden md:flex w-[68px] shrink-0 flex-col items-center gap-2 py-6 border-r border-white/[0.06]">
              {RAIL_TABS.map((tab, i) => (
                <div
                  key={i}
                  className={`w-11 h-11 rounded-[6px] flex items-center justify-center ${
                    tab.active
                      ? 'bg-primary text-white shadow-[0_4px_16px_rgba(252,59,0,0.35)]'
                      : 'text-white/35'
                  }`}
                >
                  <tab.icon size={18} />
                </div>
              ))}
              <div className="mt-auto flex flex-col items-center gap-4">
                <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
              </div>
            </div>

            {/* Main column */}
            <div className="flex-1 min-w-0 p-5 md:p-8 space-y-6">

              {/* Top bar (mirrors console header) */}
              <div className="bg-[#050505] border border-white/[0.08] rounded-[4px] px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="text-xl md:text-2xl font-display font-medium text-white tracking-tight">Treasury Console</h3>
                    <span className="h-4 w-px bg-white/10 hidden sm:block" />
                    <span className="flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.15em] text-primary uppercase">
                       <span className="w-1.5 h-1.5 bg-primary" /> MAINNET
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-[10px] font-mono tracking-[0.12em] uppercase tabular-nums">
                    <span className="flex items-center gap-1.5 text-green-400/90">
                       <span className="w-1.5 h-1.5 bg-green-500" /> ARC
                    </span>
                    <span className="text-white/40">#58,641,207</span>
                    <span className="h-3 w-px bg-white/10" />
                    <span className="flex items-center gap-1.5 text-primary/90">
                      <span className="w-1.5 h-1.5 bg-primary" /> MANAGED
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 self-start sm:self-auto px-3.5 py-2 bg-white/[0.04] border border-white/[0.1] rounded-[4px] text-[11px] font-mono tracking-[0.08em] text-white/80 tabular-nums">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  0x7A3F…C4D2
                </div>
              </div>

              {/* Real console metrics, seeded */}
              <Metrics dashboard={SEEDED_DASHBOARD} isLoading={false} />

              {/* NAV history + allocations - same cards as /app overview */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 console-card">
                  <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-6 flex items-center gap-2">
                    <span className="text-white/40">04 //</span> NAV HISTORY
                  </h3>
                  <div className="h-[220px] md:h-[260px]">
                    <NavChart history={history} />
                  </div>
                </div>
                <div className="console-card">
                  <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-6 flex items-center gap-2">
                    <span className="text-white/40">05 //</span> ALLOCATIONS
                  </h3>
                  <Allocations allocations={SEEDED_DASHBOARD.allocations} />
                </div>
              </div>
            </div>

            {/* Arcus rail (mirrors the in-app agent column) */}
            <div className="hidden xl:flex w-[320px] shrink-0 flex-col border-l border-white/[0.06] p-6 gap-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-[6px] bg-primary/15 border border-primary/30 flex items-center justify-center">
                    <Sparkles size={16} className="text-primary" />
                  </div>
                  <div>
                    <div className="text-base font-display font-medium text-white tracking-tight">Arcus AI</div>
                    <div className="text-[9px] font-mono tracking-[0.15em] text-muted-foreground uppercase mt-0.5">Autonomous Agent</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[9px] font-mono font-bold tracking-[0.15em] text-green-400 uppercase">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Online
                </div>
              </div>

              <div className="flex-1 space-y-4">
                <div className="ml-8 bg-white/[0.06] border border-white/[0.06] rounded-lg rounded-tr-sm px-4 py-3 text-[13px] text-white/90 leading-relaxed">
                  Keep at least 40% of the treasury liquid at all times.
                </div>
                <div className="mr-4 bg-primary/[0.07] border border-primary/25 rounded-lg rounded-tl-sm px-4 py-3.5">
                  <div className="flex items-center gap-1.5 text-[9px] font-mono font-bold tracking-[0.15em] text-primary uppercase mb-2">
                    <Sparkles size={10} /> Arcus
                  </div>
                  <p className="text-[13px] text-white/85 leading-relaxed">
                    Compiled <span className="font-mono text-primary">liquid-reserve-40</span> into
                    an enforced policy. Liquid reserve sits at 38.2%, 1.8 points under
                    your floor, so I drafted a rebalance pulling $51,253 out of the
                    EURC sleeve. It's waiting for your approval.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 px-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-[6px] text-[13px] text-white/30">
                  Ask Arcus...
                </div>
                <div className="w-11 h-11 rounded-[6px] bg-primary/80 flex items-center justify-center text-white">
                  <Send size={15} />
                </div>
              </div>
            </div>
          </div>

          {/* Honest footer: seeded showcase, real console one click away */}
          <div className="px-5 md:px-8 py-3.5 border-t border-white/[0.06] bg-[#050505]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-white/30">
              Seeded showcase state; every number in the real console is computed from on-chain deposits.
            </span>
            <Link
              href="/app"
              className="text-[10px] font-mono uppercase tracking-[0.12em] font-bold text-primary hover:text-orange-400 transition-colors whitespace-nowrap"
              data-testid="link-terminal-launch"
            >
              Launch your console →
            </Link>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
