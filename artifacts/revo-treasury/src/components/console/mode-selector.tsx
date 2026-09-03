import { useQueryClient } from '@tanstack/react-query';
import { useSetTreasuryMode, getGetTreasuryModeQueryKey, getGetTreasuryDashboardQueryKey, type OperatingModeUpdateMode } from '@workspace/api-client-react';
import { ShieldOff, UserCheck, Zap } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { apiErrorCode, apiErrorMessage } from '@/lib/api-error';

const MODES = [
  { value: 'safe', label: 'Safe', icon: ShieldOff },
  { value: 'managed', label: 'Managed', icon: UserCheck },
  { value: 'autonomous', label: 'Auto-execute', icon: Zap },
] as const;

export function ModeSelector({ current }: { current?: string }) {
  const queryClient = useQueryClient();
  const setMode = useSetTreasuryMode();
  const { session, signIn, isSigningIn } = useAuthContext();
  const { toast } = useToast();

  const applyMode = async (mode: string) => {
    await setMode.mutateAsync({ data: { mode: mode as OperatingModeUpdateMode } });
    toast({ title: `Mode Switched: ${mode.toUpperCase()}` });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetTreasuryModeQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() }),
    ]);
  };

  const handleSelect = async (mode: string) => {
    if (!session) {
      toast({ title: 'Sign in to act', description: 'You must be signed in to change operating modes.', variant: 'destructive' });
      return;
    }
    if (mode === current || setMode.isPending || isSigningIn) return;

    try {
      await applyMode(mode);
    } catch (error) {
      if (mode === 'autonomous' && apiErrorCode(error) === 'stale_session') {
        toast({
          title: 'Fresh signature required',
          description: 'Confirm the wallet message to enable Auto-execute. This uses no gas and sends no transaction.',
        });
        const reauthenticated = await signIn();
        if (!reauthenticated) return;

        try {
          await applyMode(mode);
        } catch (retryError) {
          toast({
            title: 'Mode Switch Failed',
            description: apiErrorMessage(retryError),
            variant: 'destructive',
          });
        }
        return;
      }

      toast({
        title: 'Mode Switch Failed',
        description: apiErrorMessage(error),
        variant: 'destructive',
      });
    }
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
            onClick={() => void handleSelect(m.value)}
            disabled={setMode.isPending || isSigningIn}
            aria-busy={setMode.isPending || isSigningIn}
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