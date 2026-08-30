import { Link } from 'wouter';
import { LayoutGrid, Wallet, Activity, FileText, Shield, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { ModeSelector } from './mode-selector';
import { useState } from 'react';
import { cn } from '@/lib/utils';

// Wallet sits right after Overview: funding the treasury is the first thing
// a new operator must do, so deposits are never buried behind system tabs.
const VIEWS = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
  { id: 'execution', label: 'Execution', icon: Activity },
  { id: 'strategy', label: 'Strategy', icon: FileText },
  { id: 'system', label: 'System', icon: Shield },
];

export function Sidebar({ 
  mode, 
  drillActive,
  activeView,
  onViewChange
}: { 
  mode?: string; 
  drillActive?: boolean;
  activeView: string;
  onViewChange: (view: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-[calc(72px+env(safe-area-inset-bottom))] bg-black/90 backdrop-blur-xl border-t border-white/10 z-50 flex items-start justify-around px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_30px_rgba(0,0,0,0.8)]">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => onViewChange(v.id)}
            className={cn(
              "flex flex-col items-center justify-center w-16 h-[72px] gap-1.5 transition-colors relative min-h-[44px]", // >= 44px tap target
              activeView === v.id ? "text-primary" : "text-muted-foreground hover:text-white"
            )}
          >
            {activeView === v.id && (
              <span className="absolute top-[-1px] left-1/2 -translate-x-1/2 w-8 h-[2px] bg-primary rounded-b-full shadow-[0_2px_8px_rgba(252,59,0,0.8)]" />
            )}
            <v.icon className="w-5 h-5" />
            <span className="text-[9px] font-mono uppercase tracking-wider">{v.label}</span>
          </button>
        ))}
      </div>

      {/* Desktop Sidebar */}
      <div 
        className={cn(
          "hidden md:flex h-full glass glass-frosted !rounded-none !border-y-0 !border-l-0 !border-r flex-col justify-between transition-all duration-300 shrink-0 relative z-30",
          expanded ? "w-[240px] px-4 py-6" : "w-[88px] px-4 py-6",
          drillActive ? "bg-red-950/20 border-red-500/20" : "bg-[#050505]"
        )}
      >
        <div className="flex flex-col gap-8">
          <div className={cn("flex items-center", expanded ? "justify-between" : "justify-center")}>
            <Link href="/" aria-label="Revo home" className="group flex items-center justify-center shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}brand/revo-mark.png`}
                alt="Revo logo"
                className="w-9 h-9 object-contain shrink-0 group-hover:scale-105 transition-transform drop-shadow-[0_0_15px_rgba(252,59,0,0.4)]"
              />
              {expanded && (
                <span className="ml-3 font-display font-medium text-xl text-white tracking-tight whitespace-nowrap animate-in fade-in zoom-in duration-300">Revo</span>
              )}
            </Link>
          </div>
          
          <nav className="flex flex-col gap-3">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => onViewChange(v.id)}
                className={cn(
                  "h-12 rounded-2xl flex items-center transition-all duration-300 relative overflow-hidden group",
                  expanded ? "px-4 justify-start" : "justify-center",
                  activeView === v.id 
                    ? "bg-primary text-white shadow-[0_4px_12px_rgba(252,59,0,0.3)]" 
                    : "text-muted-foreground hover:bg-white/5 hover:text-white"
                )}
                title={!expanded ? v.label : undefined}
              >
                <v.icon className={cn("w-5 h-5 shrink-0", activeView === v.id ? "text-white" : "text-muted-foreground group-hover:text-white")} />
                {expanded && (
                  <span className="ml-3 font-mono text-xs tracking-widest uppercase font-semibold whitespace-nowrap animate-in fade-in zoom-in duration-300">{v.label}</span>
                )}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex flex-col items-center gap-6 mt-auto">
          <div className={cn("flex items-center", expanded ? "w-full justify-start px-2" : "justify-center")}>
            <div className="flex items-center gap-1 group relative">
              <div className="w-10 h-10 rounded-full bg-card border border-border flex items-center justify-center cursor-help shrink-0">
                <span className={cn("w-2.5 h-2.5 rounded-full", drillActive ? "bg-red-400 animate-pulse shadow-[0_0_8px_rgba(248,113,113,0.6)]" : "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.4)]")} />
              </div>
              {expanded && (
                <div className="ml-3 flex flex-col overflow-hidden animate-in fade-in duration-300">
                  <span className="text-xs font-mono text-white/80 tabular-nums truncate">ARCUS AGENT</span>
                  <span className={cn("text-[10px] font-mono uppercase mt-0.5 tabular-nums truncate", drillActive ? "text-red-400" : "text-green-400")}>{drillActive ? 'DRILL ACTIVE' : 'ONLINE'}</span>
                </div>
              )}
              {/* Tooltip on hover if collapsed */}
              {!expanded && (
                <div className="absolute left-full ml-4 px-3 py-2 bg-card border border-border rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap z-50">
                  <div className="text-xs font-mono text-white/80 tabular-nums">ARCUS AGENT</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase mt-0.5 tabular-nums">{(drillActive ? 'DRILL ACTIVE' : 'ONLINE')}</div>
                </div>
              )}
            </div>
          </div>

          <div className="w-full flex justify-center">
            <ModeSelector current={mode} />
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className={cn(
              "h-10 flex items-center text-muted-foreground hover:text-white transition-colors border border-white/5 bg-white/5 rounded-xl hover:bg-white/10",
              expanded ? "w-full justify-center gap-2" : "w-10 justify-center"
            )}
          >
            {expanded ? (
              <>
                <PanelLeftClose className="w-4 h-4" />
                <span className="text-[10px] font-mono uppercase tracking-widest font-semibold">Collapse</span>
              </>
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </>
  );
}
