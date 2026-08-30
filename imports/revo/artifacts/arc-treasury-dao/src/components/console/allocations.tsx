import { memo } from 'react';
import { type Allocation } from '@workspace/api-client-react';

function AllocationsImpl({ allocations }: { allocations?: Allocation[] }) {
  if (!allocations?.length) return <div className="text-sm text-muted-foreground leading-relaxed">No allocations found.</div>;

  return (
    <div className="space-y-6">
      {allocations.map((a, i) => {
        const isSimulated = a.symbol !== 'USDC';
        
        return (
          <div key={i} className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <span className="text-[15px] font-medium text-white/90">{a.symbol}</span>
                {isSimulated && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-purple-400">
                    <span className="w-1.5 h-1.5 bg-purple-400 rounded-sm" /> SIMULATED
                  </span>
                )}
                {!isSimulated && (
                  <span className="text-sm text-muted-foreground truncate max-w-[80px] hidden md:inline-block leading-relaxed">{a.name}</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground tabular-nums leading-relaxed">${a.value.toLocaleString()}</span>
                <span className="text-sm font-medium text-primary tabular-nums leading-relaxed">{a.percentage}%</span>
              </div>
            </div>
            <div className="h-1 bg-white/[0.05] rounded-none overflow-hidden relative">
              <div 
                className={`h-full rounded-none transition-all duration-1000 ${isSimulated ? 'bg-purple-500 opacity-60' : 'bg-primary'}`}
                style={{ width: `${a.percentage}%` }}
              />
              {isSimulated && (
                <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, #fff 4px, #fff 8px)' }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const Allocations = memo(AllocationsImpl);
