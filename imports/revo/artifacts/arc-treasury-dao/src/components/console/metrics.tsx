import { memo } from 'react';
import { type TreasuryDashboard } from '@workspace/api-client-react';

function MetricsImpl({ dashboard, isLoading }: { dashboard?: TreasuryDashboard, isLoading: boolean }) {
  if (isLoading && !dashboard) {
    return <div className="h-32 w-full animate-shimmer bg-white/[0.02] border border-white/[0.08] rounded-none sm:rounded-[4px]" />;
  }

  const formatCurrency = (val: number) => 
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

  const riskScore = dashboard?.riskScore ?? 0;
  const isHigh = riskScore >= 70;
  const isMed = riskScore >= 40 && riskScore < 70;
  const riskStatus = isHigh ? 'HIGH' : isMed ? 'ELEVATED' : 'LOW';
  const riskColor = isHigh ? 'text-red-500' : isMed ? 'text-yellow-400' : 'text-green-400';

  const deployed = dashboard?.deployed ?? 0;
  const reserve = 100 - deployed;

  return (
    <div className="flex flex-col md:flex-row w-full bg-[#050505] border border-white/[0.08] rounded-none sm:rounded-[4px] overflow-hidden">
      {/* 01 / NET ASSET VALUE */}
      <div className="flex-1 p-5 md:p-6 border-b md:border-b-0 md:border-r border-white/[0.08] hover:bg-white/[0.02] transition-colors flex flex-col justify-between group min-h-[160px]">
        <div className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-4 md:mb-8 flex items-center gap-2">
          <span className="text-white/40">01 //</span> NET ASSET VALUE
        </div>
        <div className="text-4xl md:text-5xl lg:text-6xl font-display font-medium text-white tracking-tight mb-4 tabular-nums group-hover:text-primary transition-colors flex-1 flex items-end">
          {formatCurrency(dashboard?.totalValue ?? 0)}
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.1em] tabular-nums mt-auto">
          {dashboard?.dayChange !== undefined && (
            <>
              <div className={`w-1.5 h-1.5 rounded-sm ${dashboard.dayChange >= 0 ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className={dashboard.dayChange >= 0 ? 'text-green-400' : 'text-red-400'}>
                {dashboard.dayChange >= 0 ? '+' : ''}{dashboard.dayChange}%
              </span>
              <span className="text-muted-foreground ml-1">24H CHANGE</span>
            </>
          )}
        </div>
      </div>

      {/* 02 / CAPITAL DEPLOYED */}
      <div className="flex-1 p-5 md:p-6 border-b md:border-b-0 md:border-r border-white/[0.08] hover:bg-white/[0.02] transition-colors flex flex-col justify-between group min-h-[160px]">
        <div className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-4 md:mb-8 flex items-center gap-2">
          <span className="text-white/40">02 //</span> CAPITAL DEPLOYED
        </div>
        <div className="text-4xl md:text-5xl lg:text-6xl font-display font-medium text-white tracking-tight mb-4 tabular-nums flex-1 flex items-end">
          {deployed}%
        </div>
        <div className="flex flex-col gap-2 mt-auto">
          <div className="flex h-1 bg-white/[0.05] w-full overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${deployed}%` }} />
            <div className="h-full bg-white/20" style={{ width: `${reserve}%` }} />
          </div>
          <div className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex justify-between tabular-nums">
            <span className="text-primary">{deployed}% ACTIVE</span>
            <span>{reserve}% RESERVE</span>
          </div>
        </div>
      </div>

      {/* 03 / RISK SCORE */}
      <div className="flex-1 p-5 md:p-6 hover:bg-white/[0.02] transition-colors flex flex-col justify-between group min-h-[160px]">
        <div className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-4 md:mb-8 flex items-center gap-2">
          <span className="text-white/40">03 //</span> RISK SCORE
        </div>
        <div className={`text-4xl md:text-5xl lg:text-6xl font-display font-medium tracking-tight mb-4 tabular-nums flex-1 flex items-end ${riskColor}`}>
          {riskScore}
        </div>
        <div className="flex flex-col gap-2 mt-auto">
          <div className="flex gap-[2px] h-1 w-full">
            {Array.from({ length: 10 }).map((_, i) => {
              const active = i < Math.ceil(riskScore / 10);
              return (
                <div 
                  key={i} 
                  className={`flex-1 ${active ? (isHigh ? 'bg-red-500' : isMed ? 'bg-yellow-400' : 'bg-green-400') : 'bg-white/[0.05]'}`} 
                />
              );
            })}
          </div>
          <div className={`text-[10px] font-mono tracking-[0.1em] uppercase tabular-nums flex justify-between ${riskColor}`}>
            <span>STATUS</span>
            <span>{riskStatus}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Memoized: dashboard polls every 1-5s; skip re-rendering when data is unchanged
// (React Query structural sharing keeps prop identity stable between equal payloads).
export const Metrics = memo(MetricsImpl);
