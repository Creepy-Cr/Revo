import { memo } from 'react';
import { type Allocation } from '@workspace/api-client-react';

/**
 * Rows are labelled from what the API reports, never inferred from the symbol.
 * The old rule flagged everything that was not USDC as SIMULATED, which was
 * true only because three of the four rows were invented. Now that balances are
 * read from the custody wallet, the honest distinction is whether the chain
 * answered and whether Revo can actually trade the asset.
 */
function badgeFor(a: Allocation): { label: string; className: string; dot: string } | null {
  if (a.source === 'simulated') {
    return { label: 'DRILL', className: 'text-purple-400', dot: 'bg-purple-400' };
  }
  if (a.source !== 'onchain') {
    return {
      label: 'LEDGER ONLY',
      className: 'text-amber-400',
      dot: 'bg-amber-400',
    };
  }
  if (!a.tradable) {
    return {
      label: 'NO LIQUIDITY',
      className: 'text-white/40',
      dot: 'bg-white/40',
    };
  }
  return null;
}

function AllocationsImpl({ allocations }: { allocations?: Allocation[] }) {
  if (!allocations?.length)
    return <div className="text-sm text-muted-foreground leading-relaxed">No allocations found.</div>;

  return (
    <div className="space-y-6">
      {allocations.map((a, i) => {
        const badge = badgeFor(a);
        const muted = badge !== null;

        return (
          <div key={i} className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <span className="text-[15px] font-medium text-white/90">{a.symbol}</span>
                {badge ? (
                  <span
                    className={`inline-flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] ${badge.className}`}
                    title={a.untradableReason ?? undefined}
                  >
                    <span className={`w-1.5 h-1.5 rounded-sm ${badge.dot}`} /> {badge.label}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground truncate max-w-[110px] hidden md:inline-block leading-relaxed">
                    {a.name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {/* A drill rewrites percentages without moving tokens, so the
                    real unit count would contradict the bar beside it. */}
                {a.source !== 'simulated' && (
                  <span className="text-xs text-muted-foreground/70 tabular-nums hidden sm:inline-block leading-relaxed">
                    {a.units.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                )}
                <span className="text-sm text-muted-foreground tabular-nums leading-relaxed">
                  ${a.value.toLocaleString()}
                </span>
                <span className="text-sm font-medium text-primary tabular-nums leading-relaxed">
                  {a.percentage}%
                </span>
              </div>
            </div>
            <div className="h-1 bg-white/[0.05] rounded-none overflow-hidden relative">
              <div
                className={`h-full rounded-none transition-all duration-1000 ${muted ? 'bg-white/25' : 'bg-primary'}`}
                style={{ width: `${a.percentage}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const Allocations = memo(AllocationsImpl);
