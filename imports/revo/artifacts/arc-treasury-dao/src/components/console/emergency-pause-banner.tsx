import { useGetSecurityStatus, getGetSecurityStatusQueryKey, useSetEmergencyPause } from '@workspace/api-client-react';
import { ShieldAlert, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useAuthContext } from './auth-context';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { apiErrorMessage } from '@/lib/api-error';

export function EmergencyPauseBanner() {
  const { data: status } = useGetSecurityStatus({
    query: {
      queryKey: getGetSecurityStatusQueryKey(),
      refetchInterval: 15000,
      refetchOnWindowFocus: true,
    },
  });

  const { session } = useAuthContext();
  const setPause = useSetEmergencyPause();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDeactivate = () => {
    if (!session || session.role !== 'admin') {
      toast({ title: 'Admin required', variant: 'destructive' });
      return;
    }
    setPause.mutate({ data: { active: false, reason: 'Operator deactivated pause' } }, {
      onSuccess: () => {
        toast({ title: 'Pause lifted', description: 'Treasury operations resumed.' });
        queryClient.invalidateQueries({ queryKey: getGetSecurityStatusQueryKey() });
      },
      onError: (err) => {
        toast({ title: 'Failed to lift pause', description: apiErrorMessage(err), variant: 'destructive' });
      }
    });
  };

  if (!status?.pauseActive) return null;

  return (
    <div className="w-full bg-red-950/80 border-b border-red-500/50 shadow-[0_4px_30px_rgba(220,38,38,0.2)] py-3 px-6 shrink-0 relative z-50 overflow-hidden">
      {/* Red diagonal stripes background for hazard tape effect */}
      <div className="absolute inset-0 opacity-10" 
        style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, #ff0000 10px, #ff0000 20px)' }} 
      />
      
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4 relative z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-500/20 rounded-full">
            <AlertTriangle className="w-6 h-6 text-red-500 animate-pulse" />
          </div>
          <div>
            <h2 className="text-red-50 font-display font-medium text-lg tracking-tight uppercase">Emergency Pause Active</h2>
            <p className="text-red-200/80 text-sm leading-relaxed">
              {status.pauseReason || 'Manual override activated.'} {status.pauseActivatedAt && `(${new Date(status.pauseActivatedAt).toLocaleString()})`}
            </p>
          </div>
        </div>

        {session?.role === 'admin' ? (
          <button
            onClick={handleDeactivate}
            disabled={setPause.isPending}
            className="shrink-0 flex items-center gap-2 bg-white text-red-950 px-4 py-2 rounded-xl text-sm font-medium shadow-[0_0_15px_rgba(255,255,255,0.2)] hover:bg-red-50 transition-all disabled:opacity-50 leading-relaxed"
          >
            <ShieldCheck className="w-4 h-4" />
            Lift Pause
          </button>
        ) : (
          <div className="shrink-0 flex items-center gap-2 text-red-300 text-sm bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20 leading-relaxed">
            <ShieldAlert className="w-4 h-4" />
            <span>Admin required to lift pause</span>
          </div>
        )}
      </div>
    </div>
  );
}
