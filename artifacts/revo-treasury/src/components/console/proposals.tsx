import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListTreasuryProposals, useApproveTreasuryProposal, useRejectTreasuryProposal, getListTreasuryProposalsQueryKey, getGetTreasuryDashboardQueryKey } from '@workspace/api-client-react';
import { Check, X, ShieldAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { RejectDialog } from './reject-dialog';
import { apiErrorMessage } from '@/lib/api-error';

export function Proposals() {
  const { data: proposals, isLoading } = useListTreasuryProposals({
    query: { queryKey: getListTreasuryProposalsQueryKey(), refetchInterval: 5000 }
  });
  const approve = useApproveTreasuryProposal();
  const reject = useRejectTreasuryProposal();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { session } = useAuthContext();
  
  const [rejectId, setRejectId] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTreasuryProposalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
  };

  const handleApprove = (id: string) => {
    if (!session) {
      toast({ title: 'Sign in to act', variant: 'destructive' });
      return;
    }
    approve.mutate({ proposalId: id }, {
      onSuccess: () => {
        toast({
          title: 'Rebalance applied',
          description: 'Simulated allocation change. No on-chain transaction was sent.',
        });
        invalidate();
      },
      onError: (err) => toast({ title: 'Rebalance failed', description: apiErrorMessage(err), variant: 'destructive' })
    });
  };

  const handleRejectConfirm = (reason: string) => {
    if (!rejectId) return;
    reject.mutate({ proposalId: rejectId, data: { reason } }, {
      onSuccess: () => {
        toast({ title: 'Proposal Rejected' });
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
        title="Reject Proposal"
        description="Are you sure you want to reject this proposal?"
        isPending={reject.isPending}
      />
      <div className="flex items-center justify-between mb-6 shrink-0">
        <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2">
          <span className="text-white/40">02 //</span> PENDING ACTIONS
        </h3>
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
          {proposals?.filter(p => p.status === 'pending').length || 0} PENDING
        </span>
      </div>

      <div className="flex flex-col space-y-4">
        {isLoading ? (
          <div className="h-32 bg-white/[0.02] border border-white/[0.05] rounded-none animate-shimmer" />
        ) : !proposals?.length ? (
          <div className="text-center py-8 border-y border-white/[0.08] bg-transparent space-y-1.5">
            <div className="font-mono text-xs text-muted-foreground">NO PENDING ACTIONS</div>
            <div className="text-[11px] text-white/30 leading-relaxed">When Arcus drafts a rebalance, it waits here for your approval.</div>
          </div>
        ) : (
          proposals.map(p => {
            const isExec = p.status === 'executed';
            const isPend = p.status === 'pending';
            const isRej = p.status === 'rejected';

            const assetColors: Record<string, string> = {
              'USDC': 'bg-primary',
              'AUSDC': 'bg-purple-500',
              'SUSDC': 'bg-blue-500',
              'ETH': 'bg-green-500',
              'WBTC': 'bg-amber-500',
            };
            const defaultAssetColor = 'bg-white/40';

            return (
              <div key={p.id} className="relative flex flex-col group border-b border-white/[0.08] pb-6 last:border-b-0 last:pb-0">
                <div className="flex justify-between items-start mb-2">
                  <div className="font-display text-xl text-white pr-4 leading-snug tracking-tight">{p.title}</div>
                  <div className={`shrink-0 flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.1em] uppercase mt-1 ${isExec ? 'text-green-400' : isPend ? 'text-yellow-400' : isRej ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {isPend && <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-ping opacity-75 absolute -ml-3" />}
                    <div className={`w-1.5 h-1.5 rounded-sm ${isExec ? 'bg-green-400' : isPend ? 'bg-yellow-400' : isRej ? 'bg-red-400' : 'bg-white/40'}`} />
                    {p.status}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground mb-6 leading-relaxed">{p.summary}</div>
                
                {p.targetAllocations && p.targetAllocations.length > 0 && (
                  <div className="flex flex-col mb-6">
                    <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground mb-2">TARGET ALLOCATION</div>
                    <div className="flex h-1.5 w-full bg-white/[0.05] overflow-hidden rounded-[2px] mb-3 border border-white/[0.04]">
                      {p.targetAllocations.map(t => (
                        <div 
                          key={t.symbol} 
                          className={`h-full ${assetColors[t.symbol] || defaultAssetColor}`} 
                          style={{ width: `${t.percentage}%` }} 
                        />
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono tracking-widest text-muted-foreground">
                      {p.targetAllocations.map((t) => (
                        <span key={t.symbol}>
                          <span className="text-white/60">{t.symbol}</span> <span className="tabular-nums text-white/90">{t.percentage.toFixed(1)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {isPend && (
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
