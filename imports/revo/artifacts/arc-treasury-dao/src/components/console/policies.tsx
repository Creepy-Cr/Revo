import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListTreasuryPolicies, useApproveTreasuryPolicy, useRejectTreasuryPolicy, getListTreasuryPoliciesQueryKey, getListTreasuryProposalsQueryKey, getGetTreasuryDashboardQueryKey } from '@workspace/api-client-react';
import { Check, X, ShieldAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { RejectDialog } from './reject-dialog';
import { apiErrorMessage } from '@/lib/api-error';

export function Policies() {
  const { data: policies, isLoading } = useListTreasuryPolicies({
    query: { queryKey: getListTreasuryPoliciesQueryKey(), refetchInterval: 5000 }
  });
  const approve = useApproveTreasuryPolicy();
  const reject = useRejectTreasuryPolicy();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { session } = useAuthContext();
  
  const [rejectId, setRejectId] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTreasuryPoliciesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTreasuryProposalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
  };

  const handleApprove = (id: string) => {
    if (!session) {
      toast({ title: 'Sign in to act', variant: 'destructive' });
      return;
    }
    approve.mutate({ policyId: id }, {
      onSuccess: () => {
        toast({ title: 'Policy Activated' });
        invalidate();
      },
      onError: (err) => toast({ title: 'Activation Failed', description: apiErrorMessage(err), variant: 'destructive' })
    });
  };

  const handleRejectConfirm = (reason: string) => {
    if (!rejectId) return;
    reject.mutate({ policyId: rejectId, data: { reason } }, {
      onSuccess: () => {
        toast({ title: 'Policy Rejected' });
        setRejectId(null);
        invalidate();
      },
      onError: (err) => toast({ title: 'Rejection Failed', description: apiErrorMessage(err), variant: 'destructive' })
    });
  };

  const decisionPending = approve.isPending || reject.isPending;

  return (
    <div className="flex flex-col w-full">
      <RejectDialog
        open={!!rejectId}
        onOpenChange={(o) => !o && setRejectId(null)}
        onConfirm={handleRejectConfirm}
        title="Reject Policy Draft"
        description="Are you sure you want to reject this policy draft?"
        isPending={reject.isPending}
      />
      <div className="flex items-center justify-between mb-6 shrink-0">
        <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2">
          <span className="text-white/40">01 //</span> ACTIVE RULES
        </h3>
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
          {policies?.length || 0} TOTAL
        </span>
      </div>

      <div className="flex flex-col space-y-4">
        {isLoading ? (
          <div className="h-32 bg-white/[0.02] border border-white/[0.05] rounded-none animate-shimmer" />
        ) : !policies?.length ? (
          <div className="text-center py-8 border-y border-white/[0.08] bg-transparent space-y-1.5">
            <div className="font-mono text-xs text-muted-foreground">NO POLICIES COMPILED</div>
            <div className="text-[11px] text-white/30 leading-relaxed">Write a rule in the Execution tab's command prompt. Arcus compiles it into policy.</div>
          </div>
        ) : (
          policies.map(p => {
            const isActive = p.status === 'active';
            const isDraft = p.status === 'draft';
            const isRejected = p.status === 'rejected';
            
            return (
              <div key={p.id} className="relative flex flex-col group border-b border-white/[0.08] pb-6 last:border-b-0 last:pb-0">
                <div className="flex justify-between items-start mb-2">
                  <div className="font-display text-xl text-white tracking-tight leading-snug pr-4">{p.name}</div>
                  <div className={`shrink-0 flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.1em] uppercase ${isActive ? 'text-green-400' : isDraft ? 'text-primary' : isRejected ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {isDraft && <div className="w-1.5 h-1.5 rounded-full bg-primary animate-ping opacity-75 absolute -ml-3" />}
                    <div className={`w-1.5 h-1.5 rounded-sm ${isActive ? 'bg-green-400' : isDraft ? 'bg-primary' : isRejected ? 'bg-red-400' : 'bg-white/40'}`} />
                    {p.status}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground mb-6 leading-relaxed">{p.summary}</div>
                
                <div className="flex flex-col mb-4">
                  {[
                    { label: 'MAX PROTOCOL EXPOSURE', val: `${p.rules.maxAllocationPct}%` },
                    { label: 'MIN STABLE RESERVE', val: `${p.rules.stablecoinReserveMinPct}%` },
                    { label: 'MAX DRAWDOWN', val: `${p.rules.drawdownLimitPct}%` },
                    { label: 'RISK CEILING', val: p.rules.riskTolerance }
                  ].map((r, i) => (
                    <div key={r.label} className={`flex justify-between items-end gap-4 py-2 ${i !== 3 ? 'border-b border-white/[0.04]' : ''}`}>
                      <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.1em]">{r.label}</div>
                      <div className="flex-1 border-b border-dashed border-white/10 relative -top-1" />
                      <div className="text-[11px] font-mono font-bold text-white uppercase tabular-nums">{r.val}</div>
                    </div>
                  ))}
                </div>

                {isDraft && (
                  <div className="flex gap-2 mt-2">
                    <button 
                      onClick={() => {
                        if (!session) toast({ title: 'Sign in to act', variant: 'destructive' });
                        else setRejectId(p.id);
                      }}
                      disabled={decisionPending}
                      className="flex-1 py-3 flex items-center justify-center gap-2 text-[11px] font-mono font-bold tracking-widest text-red-400 bg-red-400/10 hover:bg-red-400/20 border border-red-400/20 rounded-[4px] transition-colors disabled:opacity-50 disabled:pointer-events-none uppercase"
                    >
                      {!session ? <ShieldAlert className="w-3.5 h-3.5 opacity-50" /> : <X className="w-3.5 h-3.5" />} REJECT
                    </button>
                    <button 
                      onClick={() => handleApprove(p.id)}
                      disabled={decisionPending}
                      className="flex-1 py-3 flex items-center justify-center gap-2 text-[11px] font-mono font-bold tracking-widest text-white bg-primary hover:bg-primary/90 border border-primary rounded-[4px] transition-colors shadow-[0_0_15px_rgba(252,59,0,0.15)] hover:shadow-[0_0_20px_rgba(252,59,0,0.3)] disabled:opacity-50 disabled:pointer-events-none uppercase"
                    >
                      {!session ? <ShieldAlert className="w-3.5 h-3.5 opacity-50" /> : <Check className="w-3.5 h-3.5" />} APPROVE
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
