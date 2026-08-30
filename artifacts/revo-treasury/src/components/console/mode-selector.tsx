import { useQueryClient } from '@tanstack/react-query';
import { useSetTreasuryMode, getGetTreasuryModeQueryKey, getGetTreasuryDashboardQueryKey, type OperatingModeUpdateMode } from '@workspace/api-client-react';
import { ShieldOff, UserCheck, Zap } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { apiErrorMessage } from '@/lib/api-error';

const MODES = [
  { value: 'safe', label: 'Safe', icon: ShieldOff },
  { value: 'managed', label: 'Managed', icon: UserCheck },
  { value: 'autonomous', label: 'Auto-execute', icon: Zap },
] as const;

export function ModeSelector({ current }: { current?: string }) {
  const queryClient = useQueryClient();
  const setMode = useSetTreasuryMode();
  const { session } = useAuthContext();
  const { toast } = useToast();

  const handleSelect = (mode: string) => {
    if (!session) {
      toast({ title: 'Sign in to act', description: 'You must be signed in to change operating modes.', variant: 'destructive' });
      return;
    }
    if (mode === current || setMode.isPending) return;
    setMode.mutate({ data: { mode: mode as OperatingModeUpdateMode } }, {
      onSuccess: () => {
        toast({ title: `Mode Switched: ${mode.toUpperCase()}` });
        queryClient.invalidateQueries({ queryKey: getGetTreasuryModeQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
      },
      onError: (err) => toast({ title: 'Mode Switch Failed', description: apiErrorMessage(err), variant: 'destructive' })
    });
  };

  return (
    <div className="border border-white/[0.08] bg-black/60 flex flex-row md:flex-col w-full divide-x md:divide-x-0 md:divide-y divide-white/[0.06]">
      {MODES.map(m => {
        const active = m.value === current;
        const accent = m.value === 'safe' ? 'text-red-400' : m.value === 'autonomous' ? 'text-primary' : 'text-green-400';
        const rule = m.value === 'safe' ? 'bg-red-400' : m.value === 'autonomous' ? 'bg-primary' : 'bg-green-400';
        return (
          <button
            key={m.value}
            onClick={() => handleSelect(m.value)}
            disabled={setMode.isPending}
            title={m.value === 'autonomous' ? 'auto-executes in-policy proposals on approval' : m.label}
            className={`relative flex-1 py-2.5 px-2 md:px-0 flex flex-col items-center justify-center gap-1 transition-colors duration-200 group ${
              active ? 'bg-white/[0.05] text-white' : 'text-muted-foreground hover:text-white/70 hover:bg-white/[0.02]'
            } ${!session ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {active && <span aria-hidden className={`absolute left-0 top-0 h-0.5 md:h-full w-full md:w-0.5 ${rule}`} />}
            <m.icon className={`w-4 h-4 ${active ? accent : ''}`} />
          </button>
        );
      })}
    </div>
  );
}