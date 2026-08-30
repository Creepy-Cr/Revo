import { useListSignals, getListSignalsQueryKey } from '@workspace/api-client-react';

export function SignalsFeed() {
  const { data: signals, isLoading } = useListSignals({
    query: { queryKey: getListSignalsQueryKey(), refetchInterval: 60000 }
  });

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2 mb-6 shrink-0">
        <span className="text-white/40">03 //</span> ALPHA STREAMS
      </h3>
      
      {isLoading ? (
        <div className="space-y-4">
          <div className="h-24 bg-white/[0.02] border border-white/[0.05] rounded-none animate-shimmer" />
          <div className="h-24 bg-white/[0.02] border border-white/[0.05] rounded-none animate-shimmer" />
        </div>
      ) : !signals?.length ? (
        <div className="text-xs text-muted-foreground py-8 text-center font-mono border-y border-white/[0.08]">NO ACTIVE SIGNALS</div>
      ) : (
        <div className="flex flex-col flex-1">
          {signals.map(signal => {
            const isPos = signal.direction === 'positive';
            const isWarn = signal.direction === 'warning' || signal.direction === 'sell';
            const toneColor = isPos ? 'text-green-400' : isWarn ? 'text-red-400' : 'text-muted-foreground';
            const toneBg = isPos ? 'bg-green-400' : isWarn ? 'bg-red-400' : 'bg-white/40';
            
            return (
              <div key={signal.id} className="group border-b border-white/[0.08] pb-6 mb-6 last:border-b-0 last:pb-0 last:mb-0">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="text-[15px] font-display tracking-tight text-white mb-1.5 leading-snug">{signal.title}</div>
                    <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                      <span>{signal.asset}</span>
                      <span className="text-white/20">/</span>
                      <span>CONF {signal.confidence}%</span>
                      <span className="text-white/20">/</span>
                      <span>SCORE {signal.score}</span>
                    </div>
                  </div>
                  <div className={`shrink-0 flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.1em] uppercase mt-1 ${toneColor}`}>
                    <div className={`w-1.5 h-1.5 rounded-sm ${toneBg}`} />
                    {signal.direction}
                  </div>
                </div>

                {signal.components.length > 0 && (
                  <div
                    className="flex flex-col"
                    data-testid={`signal-components-${signal.id}`}
                  >
                    {signal.components.map((component, idx) => {
                      const clamped = Math.max(-100, Math.min(100, component.score));
                      const positive = clamped >= 0;
                      return (
                        <div
                          key={`${signal.id}-${component.source}-${component.label}`}
                          className={`flex flex-col gap-2 py-2.5 ${idx !== signal.components.length - 1 ? 'border-b border-white/[0.04]' : ''}`}
                          title={component.detail}
                        >
                          <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-white/60">
                            {component.label}
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="relative flex-1 h-[2px] bg-white/[0.06]">
                              <span className="absolute left-1/2 top-[-2px] bottom-[-2px] w-px bg-white/20" />
                              <span
                                className={`absolute top-0 bottom-0 rounded-none ${positive ? 'bg-green-400' : 'bg-red-400'}`}
                                style={
                                  positive
                                    ? { left: '50%', width: `${clamped / 2}%` }
                                    : { right: '50%', width: `${-clamped / 2}%` }
                                }
                              />
                            </span>
                            <span className={`w-8 shrink-0 text-right text-[11px] font-mono tabular-nums ${positive ? 'text-green-400' : 'text-red-400'}`}>
                              {positive ? '+' : ''}{clamped}
                            </span>
                            <span className="w-10 shrink-0 text-right text-[11px] font-mono text-white/40 tabular-nums">
                              ×{component.weight.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
