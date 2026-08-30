import { useState } from 'react';
import { useGetTreasuryDashboard, getGetTreasuryDashboardQueryKey, useGetChainStatus, getGetChainStatusQueryKey, useGetSecurityStatus, getGetSecurityStatusQueryKey } from '@workspace/api-client-react';
import { Sidebar } from '@/components/console/sidebar';
import { Metrics } from '@/components/console/metrics';
import { NavChart } from '@/components/console/nav-chart';
import { Allocations } from '@/components/console/allocations';
import { SignalsFeed } from '@/components/console/signals-feed';
import { CommandConsole } from '@/components/console/command-console';
import { Policies } from '@/components/console/policies';
import { Proposals } from '@/components/console/proposals';
import { ActivityLog } from '@/components/console/activity-log';
import { AgentChat } from '@/components/console/agent-chat';
import { DrillControl } from '@/components/console/drill-control';
import { Terminal, Sparkles, X } from 'lucide-react';
import { MotionConfig, motion } from 'framer-motion';
import { WalletPanel } from '@/components/console/wallet-panel';
import { TreasuryActivation } from '@/components/console/treasury-activation';
import { WalletProvider } from '@/components/console/wallet-context';
import { AuthProvider, useAuthContext } from '@/components/console/auth-context';
import { AccessGate } from '@/components/console/access-gate';
import { WalletConnectButton } from '@/components/console/wallet-connect-button';
import { EmergencyPauseBanner } from '@/components/console/emergency-pause-banner';
import { SecurityPanel } from '@/components/console/security-panel';
import { useMediaQuery } from '@/hooks/use-media-query';
import * as Dialog from '@radix-ui/react-dialog';
import { trackEvent } from '@/lib/analytics';

const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
};

const fadeUp = {
  hidden: { opacity: 0, y: 15 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }
};

export default function Console() {
  return (
    <WalletProvider>
      <AuthProvider>
        <MotionConfig reducedMotion="user">
          <ConsoleGate />
        </MotionConfig>
      </AuthProvider>
    </WalletProvider>
  );
}

/**
 * Auth boundary: treasury data is tenant-scoped and auth-required on the
 * server, so the signed-out state renders a gate and mounts ZERO data queries.
 */
function ConsoleGate() {
  const { session, isLoading } = useAuthContext();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted-foreground space-y-4">
        <Terminal className="w-8 h-8 animate-pulse text-primary" />
        <div className="font-mono text-sm tracking-[0.14em] uppercase leading-relaxed tabular-nums">Checking operator session...</div>
        <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-primary w-1/3 animate-shimmer" />
        </div>
      </div>
    );
  }

  if (!session) return <AccessGate />;

  return <ConsoleShell />;
}

function ConsoleShell() {
  const [activeView, setActiveView] = useState('overview');
  const isDesktop = useMediaQuery('(min-width: 1280px)'); // xl breakpoint
  const handleViewChange = (view: string) => {
    trackEvent('console_view_selected', { view });
    setActiveView(view);
  };

  const { data: dashboard, isLoading, error, refetch } = useGetTreasuryDashboard({
    query: {
      queryKey: getGetTreasuryDashboardQueryKey(),
      refetchInterval: (query: any) => query.state.data?.drill?.active ? 1000 : 5000,
    }
  });

  const { data: chain } = useGetChainStatus({
    query: {
      queryKey: getGetChainStatusQueryKey(),
      refetchInterval: 15000,
    },
  });
  
  const { data: security } = useGetSecurityStatus({
    query: {
      queryKey: getGetSecurityStatusQueryKey(),
      refetchInterval: 15000,
      refetchOnWindowFocus: true,
    }
  });

  const drillActive = dashboard?.drill?.active;
  const pauseActive = security?.pauseActive;
  // First-run: a never-funded treasury has exactly one meaningful next
  // action - funding it - so the overview becomes an activation path instead
  // of a wall of zeros. Gated on the durable server-side `funded` flag (has a
  // confirmed deposit EVER landed), never on totalValue: totalValue is
  // rounded and would hide the real dashboard for a small funded balance.
  const unfunded = dashboard !== undefined && !dashboard.funded;

  if (error && !dashboard) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="console-card max-w-lg w-full text-center space-y-5">
          <Terminal className="w-9 h-9 text-primary mx-auto" />
          <div className="space-y-2">
            <h1 className="font-display text-xl text-white">Console unavailable</h1>
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              Revo could not load this treasury session. No policy or custody action was taken.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex h-10 items-center justify-center border border-primary/60 bg-primary/10 px-5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-primary transition-colors hover:bg-primary hover:text-white"
          >
            Retry connection
          </button>
        </div>
      </div>
    );
  }

  return (
          <div className={`h-[100dvh] bg-[#000000] selection:bg-primary/30 selection:text-white flex flex-col transition-colors duration-700 ${drillActive ? 'bg-[#1a0500]' : ''} ${pauseActive ? 'bg-red-950/20' : ''}`}>
            
            <EmergencyPauseBanner />
            
            <div className="flex flex-col md:flex-row flex-1 overflow-hidden relative">
              {/* Background glow */}
              <div className="absolute inset-0 w-full h-full pointer-events-none z-0 overflow-hidden">
                {/* Pre-faded radial gradient instead of a live blur(150px) filter:
                    visually identical soft glow, a fraction of the GPU cost. */}
                <div className="absolute top-[5%] left-1/2 -translate-x-1/2 w-[1100px] h-[900px] bg-[radial-gradient(ellipse_at_center,rgba(252,59,0,0.05)_0%,rgba(252,59,0,0.02)_45%,transparent_72%)] pointer-events-none" />
                <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-1 h-full transition-opacity duration-1000 ${drillActive ? 'opacity-100 bg-red-500/20 shadow-[0_0_100px_30px_rgba(239,68,68,0.3)]' : pauseActive ? 'opacity-100 bg-red-600/10 shadow-[0_0_80px_20px_rgba(220,38,38,0.2)]' : 'opacity-0'}`} />
              </div>

              <div className="relative z-20 shrink-0">
                <Sidebar mode={dashboard?.mode} drillActive={drillActive} activeView={activeView} onViewChange={handleViewChange} />
              </div>

              <main className="relative z-10 flex-1 flex flex-col xl:flex-row min-w-0 overflow-y-auto xl:overflow-hidden">
                
                {/* Center Content */}
                <div className="flex-1 xl:overflow-y-auto p-4 md:p-6 lg:p-8 pb-[calc(140px+env(safe-area-inset-bottom))] md:pb-6 custom-scrollbar relative">
                  <motion.div variants={staggerContainer} initial="hidden" animate="show" className="max-w-7xl mx-auto space-y-6 lg:space-y-8 pb-12 xl:pb-8">
                    
                    {/* Top Bar */}
                    <motion.div variants={fadeUp} className="flex flex-col gap-4 console-card !p-4 md:!p-5 bg-black/40">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 md:gap-3">
                          <h1 className="text-xl md:text-2xl font-display font-medium text-white tracking-tight leading-tight">Treasury Console</h1>
                          <div className="hidden md:flex items-center gap-1.5 px-2 py-0.5 border-l border-yellow-500/30 text-[10px] font-mono font-bold tracking-[0.15em] text-yellow-500 uppercase ml-2">
                            <div className="w-1.5 h-1.5 bg-yellow-500 animate-pulse shadow-[0_0_8px_rgba(234,179,8,0.5)]" />
                            TESTNET
                          </div>
                        </div>
                        <div className="shrink-0 scale-90 md:scale-100 origin-right">
                          <WalletConnectButton />
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-3 flex-wrap md:flex-nowrap pt-1 md:pt-0 border-t md:border-t-0 border-white/5 md:border-transparent">
                        <div className="md:hidden flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20 text-[10px] font-mono font-bold tracking-[0.15em] text-yellow-500 uppercase">
                          <div className="w-1.5 h-1.5 bg-yellow-500 animate-pulse" />
                          TESTNET
                        </div>
                        <div className="flex items-center gap-2 px-1">
                          <div className={`w-1.5 h-1.5 ${chain?.connected ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]' : 'bg-red-400'}`} />
                          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.15em] text-white/90">Arc Testnet</span>
                          {chain?.connected && typeof chain.blockNumber === 'number' ? (
                            <span className="hidden sm:inline text-[10px] font-mono font-bold tracking-[0.1em] text-muted-foreground ml-1">#{chain.blockNumber.toLocaleString()}</span>
                          ) : chain && !chain.connected ? (
                            <span className="hidden sm:inline text-[10px] font-mono font-bold tracking-[0.1em] text-red-400/80 ml-1">RPC OFFLINE</span>
                          ) : null}
                        </div>
                        <div className="w-px h-4 bg-white/10" />
                        <div className="flex items-center gap-2 px-1">
                          <div className={`w-1.5 h-1.5 ${drillActive ? 'bg-red-500 animate-pulse' : 'bg-primary shadow-[0_0_8px_rgba(252,59,0,0.5)]'}`} />
                          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.15em] text-white/90">{dashboard?.status?.toUpperCase() === "AUTONOMOUS" ? "AUTO-EXECUTE" : dashboard?.status || "STANDBY"}</span>
                        </div>
                      </div>
                    </motion.div>

                    {/* View Switcher - CSS keyed enter animation; no exit gating so a
                        throttled rAF can never leave a view stuck mid-transition. */}
                    <div key={activeView} className="view-enter">
                      {activeView === 'overview' && (
                        unfunded ? (
                          <TreasuryActivation onNavigate={handleViewChange} />
                        ) : (
                        <div className="space-y-6 lg:space-y-8">
                          <div className="flex flex-col gap-4">
                            <Metrics dashboard={dashboard} isLoading={isLoading} />
                            <DrillControl drill={dashboard?.drill} />
                          </div>
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            <div className="lg:col-span-2 console-card">
                              <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-6 flex items-center gap-2">
                                <span className="text-white/40">04 //</span> NAV HISTORY
                              </h3>
                              <div className="h-[250px] md:h-[300px]">
                                <NavChart history={dashboard?.portfolioHistory} />
                              </div>
                            </div>
                            <div className="console-card">
                              <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-6 flex items-center gap-2">
                                <span className="text-white/40">05 //</span> ALLOCATIONS
                              </h3>
                              <Allocations allocations={dashboard?.allocations} />
                            </div>
                          </div>
                        </div>
                        )
                      )}

                      {activeView === 'wallet' && (
                        <div className="max-w-2xl mx-auto w-full pt-4">
                          <WalletPanel />
                        </div>
                      )}

                      {activeView === 'execution' && (
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                          <div className="lg:col-span-7 flex flex-col gap-6">
                            <div className="console-card">
                              <CommandConsole />
                            </div>
                            <div className="console-card flex-1">
                              <ActivityLog activities={dashboard?.activities} />
                            </div>
                          </div>
                          <div className="lg:col-span-5 console-card flex flex-col">
                            <Proposals />
                            <div className="ledger-filler flex-1" aria-hidden="true" />
                          </div>
                        </div>
                      )}

                      {activeView === 'strategy' && (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                          <div className="console-card flex flex-col">
                            <Policies />
                            <div className="ledger-filler flex-1" aria-hidden="true" />
                          </div>
                          <div className="console-card">
                            <SignalsFeed />
                          </div>
                        </div>
                      )}

                      {activeView === 'system' && (
                        <div className="max-w-2xl mx-auto w-full pt-4">
                          <SecurityPanel />
                        </div>
                      )}
                    </div>

                  </motion.div>
                </div>

                {/* Right Rail: Arcus Chat (Desktop) */}
                {isDesktop && (
                  <motion.aside
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 0.2, ease: "easeOut" }}
                    className="w-full xl:w-[400px] 2xl:w-[440px] shrink-0 border-t xl:border-t-0 xl:border-l border-white/5 bg-[#050505] flex flex-col z-20 shadow-[-20px_0_40px_rgba(0,0,0,0.4)]"
                  >
                    <div className="flex-1 p-4 md:p-6 flex flex-col min-h-[600px] xl:h-[100dvh] shrink-0">
                      <AgentChat />
                    </div>
                  </motion.aside>
                )}

                {/* Arcus Mobile FAB & Sheet (Mobile) */}
                {!isDesktop && (
                  <Dialog.Root>
                    <Dialog.Trigger asChild>
                      <button
                        data-testid="button-arcus-fab"
                        className="fixed z-40 w-[52px] h-[52px] rounded-full bg-primary flex items-center justify-center shadow-[0_4px_24px_rgba(252,59,0,0.6)] border border-white/20 transition-transform active:scale-95"
                        style={{
                          bottom: 'calc(80px + env(safe-area-inset-bottom))',
                          right: '16px'
                        }}
                      >
                        <Sparkles className="w-6 h-6 text-white" />
                      </button>
                    </Dialog.Trigger>
                    
                    <Dialog.Portal>
                      <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in duration-300" />
                      <Dialog.Content
                        data-testid="arcus-mobile-sheet"
                        className="fixed inset-x-0 bottom-0 z-50 h-[85dvh] bg-[#050505] border-t border-white/10 rounded-t-[32px] shadow-[0_-10px_50px_rgba(0,0,0,0.8)] flex flex-col focus:outline-none animate-in slide-in-from-bottom-[100%] fade-in duration-300 motion-reduce:slide-in-from-bottom-0 motion-reduce:duration-200"
                      >
                        <div className="w-12 h-1.5 bg-white/10 rounded-full mx-auto mt-3 mb-1" />
                        <div className="flex items-center justify-between px-5 pb-4 border-b border-white/5 shrink-0">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center shadow-[0_0_15px_rgba(252,59,0,0.2)]">
                              <Sparkles className="w-4 h-4 text-primary" />
                            </div>
                            <Dialog.Title className="text-xl font-display font-semibold text-white tracking-tight">
                              Arcus AI
                            </Dialog.Title>
                          </div>
                          <Dialog.Close className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 text-muted-foreground hover:text-white transition-colors active:scale-95">
                            <X className="w-4 h-4" />
                          </Dialog.Close>
                        </div>
                        <div className="flex-1 overflow-hidden p-4 flex flex-col min-h-0">
                          <AgentChat />
                        </div>
                      </Dialog.Content>
                    </Dialog.Portal>
                  </Dialog.Root>
                )}

              </main>
            </div>
          </div>
  );
}
