import { type AgentActivity } from '@workspace/api-client-react';
import { ExternalLink } from 'lucide-react';

/**
 * The activity feed mixes real Arc settlements with safety-drill
 * accounting moves, so every row is badged from the API's machine-readable
 * `kind` field rather than by parsing the title. Unknown values fall back to
 * SYSTEM, which claims the least.
 */
const KIND_BADGE: Record<string, { label: string; className: string }> = {
  onchain: { label: 'ON-CHAIN', className: 'border-primary/40 text-primary' },
  simulated: { label: 'SIMULATED', className: 'border-white/20 border-dashed text-white/45' },
  system: { label: 'SYSTEM', className: 'border-white/[0.08] text-white/25' },
};

export function ActivityLog({ activities }: { activities?: AgentActivity[] }) {
  return (
    <div className="flex flex-col h-full">
      <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2 mb-6 shrink-0">
        <span className="text-white/40">SYS //</span> TERMINAL OUTPUT
      </h3>
      <div className="flex-1 overflow-y-auto font-mono text-[11px] pr-2 tabular-nums custom-scrollbar min-h-[300px] lg:min-h-0 lg:max-h-[600px]">
        {!activities?.length ? (
          <div className="text-muted-foreground border-y border-white/[0.08] py-8 text-center tracking-widest uppercase">AWAITING SYSTEM EVENTS...</div>
        ) : (
          <div className="flex flex-col border-t border-white/[0.08]">
            {activities.map((a) => {
              const badge = KIND_BADGE[a.kind] ?? KIND_BADGE.system;
              return (
                <div key={a.id} className="flex gap-4 border-b border-white/[0.04] py-3 text-muted-foreground hover:text-white/90 hover:bg-white/[0.01] transition-colors">
                  <div className="shrink-0 text-white/30 tracking-widest">{a.time}</div>
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`shrink-0 border px-1.5 py-px text-[9px] leading-[1.4] tracking-[0.12em] uppercase ${badge.className}`}>
                        {badge.label}
                      </span>
                      <span className="text-white/80 font-medium">{a.title}</span>
                    </div>
                    <div className="text-white/40 leading-snug">{a.detail}</div>
                    {a.explorerTxUrl && (
                      <a
                        href={a.explorerTxUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex w-fit items-center gap-1.5 text-primary/70 transition-colors hover:text-primary"
                      >
                        <ExternalLink className="h-3 w-3 shrink-0" />
                        <span className="truncate">{a.txHash}</span>
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
