import { useQueryClient } from '@tanstack/react-query';
import { useStartRiskDrill, useResetRiskDrill, getGetTreasuryDashboardQueryKey, getListTreasuryProposalsQueryKey, getListSignalsQueryKey } from '@workspace/api-client-react';
import { AlertOctagon, RefreshCw, ShieldAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiErrorMessage } from '@/lib/api-error';
import { useAuthContext } from './auth-context';

export function DrillControl({ drill }: { drill?: any }) {
  const queryClient = useQueryClient();
  const startDrill = useStartRiskDrill();
  const resetDrill = useResetRiskDrill();
  const { session } = useAuthContext();
  const { toast } = useToast();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTreasuryProposalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() });
  };

  const handleStart = () => {
    if (!session) {
      toast({ title: 'Sign in to act', variant: 'destructive' });
      return;
    }
    startDrill.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'Drill Initiated', variant: 'destructive' });
        invalidate();
      },
      onError: (error) =>
        toast({
          title: 'Drill Failed to Start',
          description: apiErrorMessage(error, 'Please try again.'),
          variant: 'destructive',
        })
    });
  };

  const handleReset = () => {
    if (!session) {
      toast({ title: 'Sign in to act', variant: 'destructive' });
      return;
    }
    resetDrill.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'System Restored' });
        invalidate();
      },
      onError: (error) => toast({ title: 'Restore Failed', description: apiErrorMessage(error), variant: 'destructive' })
    });
  };

  const active = drill?.active;

  return (
    <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border border-white/[0.08] rounded-none sm:rounded-[4px] transition-colors duration-500 bg-[#050505] ${active ? 'bg-red-950/20 border-red-500/30' : ''}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 flex-1">
        <div className="flex items-center gap-3 shrink-0">
          <div className={`text-[10px] font-mono tracking-[0.1em] uppercase flex items-center gap-2 ${active ? 'text-red-400' : 'text-muted-foreground'}`}>
            <span className={active ? 'text-red-400/50' : 'text-white/40'}>SYS //</span> EXPLOIT DRILL
          </div>
          {active && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold text-red-400 uppercase tracking-[0.1em]">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 animate-ping opacity-75"></span>
                <span className="relative inline-flex rounded-sm w-1.5 h-1.5 bg-red-400"></span>
              </span>
              ACTIVE
            </span>
          )}
        </div>
        <div className="hidden sm:block w-px h-4 bg-white/10 shrink-0" />
        <div className={`text-xs ${active ? 'text-red-300' : 'text-muted-foreground'} leading-snug font-sans`}>
          {active ? 'Simulated crash active. System rotating to safe assets.' : 'Trigger simulated protocol exploit to test autonomous response.'}
        </div>
      </div>
      
      <div className="shrink-0 w-full sm:w-auto">
        {active ? (
          <button 
            onClick={handleReset}
            disabled={resetDrill.isPending || !session}
            className="w-full sm:w-auto px-5 py-2.5 rounded-[4px] bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-mono font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
          >
            {resetDrill.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : !session ? <ShieldAlert className="w-3.5 h-3.5 opacity-50" /> : <RefreshCw className="w-3.5 h-3.5" />}
            RESTORE BASELINE
          </button>
        ) : (
          <button 
            onClick={handleStart}
            disabled={startDrill.isPending || !session}
            className="w-full sm:w-auto px-5 py-2.5 rounded-[4px] bg-white/[0.05] hover:bg-white/[0.1] text-white border border-white/[0.08] text-xs font-mono font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
          >
            {!session ? <ShieldAlert className="w-3.5 h-3.5 opacity-50" /> : <AlertOctagon className="w-3.5 h-3.5 text-primary" />}
            ARM DRILL
          </button>
        )}
      </div>
    </div>
  );
}
