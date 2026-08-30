import { type AgentActivity } from '@workspace/api-client-react';

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
            {activities.map((a) => (
              <div key={a.id} className="flex gap-4 border-b border-white/[0.04] py-3 text-muted-foreground hover:text-white/90 hover:bg-white/[0.01] transition-colors">
                <div className="shrink-0 text-white/30 tracking-widest">{a.time}</div>
                <div className="flex flex-col gap-1">
                  <div className="text-white/80 font-medium">{a.title}</div>
                  <div className="text-white/40 leading-snug">{a.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
