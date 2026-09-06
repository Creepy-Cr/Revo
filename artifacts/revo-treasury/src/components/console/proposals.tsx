import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListTreasuryProposals, useApproveTreasuryProposal, useRejectTreasuryProposal, getListTreasuryProposalsQueryKey, getGetTreasuryDashboardQueryKey } from '@workspace/api-client-react';
import { Check, X, ShieldAlert, ExternalLink, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { RejectDialog } from './reject-dialog';
import { apiErrorMessage } from '@/lib/api-error';

export function Proposals() {
  const { data: proposals, isLoading } = useListTreasuryProposals({
    query: {
      queryKey: getListTreasuryProposalsQueryKey(),
      // Approving no longer waits for the swap, so the settling proposal is
      // watched here instead. While one is in flight the operator is looking
      // at money moving, so the panel checks more often; the rest of the time
      // it goes back to the console's usual cadence.
      refetchInterval: (query: any) =>
        query.state.data?.some((p: any) => p.status === 'approved') ? 2000 : 5000,
    }
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

  // A settlement finishes after its request did, so the outcome arrives on a
  // poll rather than in a response. Watching proposals leave "approved" is
  // what turns that into a told outcome and fresh holdings, with no manual
  // refresh: until the swap resolves, the dashboard's numbers are pre-trade.
  const settlingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!proposals) return;
    const settling = new Set(proposals.filter(p => p.status === 'approved').map(p => p.id));
    for (const id of settlingRef.current) {
      if (settling.has(id)) continue;
      const resolved = proposals.find(p => p.id === id);
      queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
      if (resolved?.status === 'executed') {
        toast({
          title: 'Rebalance settled on Arc',
          description: resolved.executionTxHash
            ? `Swap confirmed. Transaction ${resolved.executionTxHash.slice(0, 10)}…`
            : 'No swap was needed: holdings already match the approved target.',
        });
      } else if (resolved?.status === 'pending') {
        toast({
          title: 'Rebalance did not settle',
          description: 'No holdings moved. The proposal is actionable again.',
          variant: 'destructive',
        });
      }
    }
    settlingRef.current = settling;
  }, [proposals, queryClient, toast]);

  const handleApprove = (id: string) => {
    if (!session) {
      toast({ title: 'Sign in to act', variant: 'destructive' });
      return;
    }
    approve.mutate({ proposalId: id }, {
      // The response confirms the decision was recorded, not that the swap
      // landed: settlement runs on the server after this returns.
      onSuccess: () => {
        toast({
          title: 'Approval recorded',
          description: 'Settling the swap on Arc. This panel updates itself when it confirms.',
        });
        invalidate();
      },
      // A rejected claim (already decided, policy no longer active) leaves the
      // proposal alone, so refresh either way and let the operator see why.
      onError: (err) => {
        toast({ title: 'Approval not recorded', description: apiErrorMessage(err), variant: 'destructive' });
        invalidate();
      }
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
            // "approved" is a decision, not a settlement. It gets its own
            // colour so it can never be read as a completed trade.
            const isApproved = p.status === 'approved';

            // Keyed by the real Arc tokens the treasury can hold. Matches the
            // tones the allocations panel uses so one asset reads the same
            // colour everywhere in the console.
            const assetColors: Record<string, string> = {
              'USDC': 'bg-primary',
              'EURC': 'bg-purple-500',
              'CIRBTC': 'bg-amber-500',
            };
            const defaultAssetColor = 'bg-white/40';

            return (
              <div key={p.id} className="relative flex flex-col group border-b border-white/[0.08] pb-6 last:border-b-0 last:pb-0">
                <div className="flex justify-between items-start mb-2">
                  <div className="font-display text-xl text-white pr-4 leading-snug tracking-tight">{p.title}</div>
                  <div className={`shrink-0 flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.1em] uppercase mt-1 ${isExec ? 'text-green-400' : isPend ? 'text-yellow-400' : isRej ? 'text-red-400' : isApproved ? 'text-cyan-400' : 'text-muted-foreground'}`}>
                    {(isPend || isApproved) && <div className={`w-1.5 h-1.5 rounded-full ${isApproved ? 'bg-cyan-400' : 'bg-yellow-400'} animate-ping opacity-75 absolute -ml-3`} />}
                    <div className={`w-1.5 h-1.5 rounded-sm ${isExec ? 'bg-green-400' : isPend ? 'bg-yellow-400' : isRej ? 'bg-red-400' : isApproved ? 'bg-cyan-400' : 'bg-white/40'}`} />
                    {p.status}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground mb-6 leading-relaxed">{p.summary}</div>

                {isApproved && (
                  <div className="mb-6 flex items-start gap-2 border-l-2 border-cyan-400/40 bg-cyan-400/[0.04] px-3 py-2 text-[11px] leading-relaxed text-white/50">
                    <Loader2 className="mt-[2px] h-3 w-3 shrink-0 animate-spin text-cyan-400/70" />
                    <span>
                      Settling on Arc. The swap has not confirmed, so holdings have not moved yet.
                      This updates itself when it resolves.
                    </span>
                  </div>
                )}

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

                {(isExec || isApproved) && p.explorerTxUrl && (
                  <a
                    href={p.explorerTxUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={`mb-2 inline-flex items-center gap-1.5 self-start font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${isExec ? 'text-green-400/70 hover:text-green-400' : 'text-cyan-400/70 hover:text-cyan-400'}`}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {isExec ? 'Settlement tx' : 'Broadcast tx'} {p.executionTxHash?.slice(0, 10)}…
                  </a>
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
