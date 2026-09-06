import { useQueryClient } from '@tanstack/react-query';
import {
  useSetTreasuryMode,
  useGetSecurityStatus,
  getGetSecurityStatusQueryKey,
  getGetTreasuryModeQueryKey,
  getGetTreasuryDashboardQueryKey,
  type OperatingModeUpdateMode,
} from '@workspace/api-client-react';
import { Lock, ShieldOff, UserCheck, Zap } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { apiErrorCode, apiErrorMessage } from '@/lib/api-error';

const MODES = [
  { value: 'safe', label: 'Safe', icon: ShieldOff },
  { value: 'managed', label: 'Managed', icon: UserCheck },
  { value: 'autonomous', label: 'Auto-execute', icon: Zap },
] as const;

// Same sentence PUT /treasury/mode answers its 409 with. The server is what
// refuses the switch; this control only says so before the round trip.
const PAUSE_REFUSAL = 'Emergency pause is active. Only Safe mode is allowed until it is lifted.';

export function ModeSelector({ current }: { current?: string }) {
  const queryClient = useQueryClient();
  const setMode = useSetTreasuryMode();
  const { session, signIn, isSigningIn } = useAuthContext();
  const { toast } = useToast();

  // The pause the banner and the security panel already render, read off the
  // same query key. Lifting the pause invalidates that key, so these options
  // come back on their own - no reload.
  const { data: security } = useGetSecurityStatus({
    query: {
      queryKey: getGetSecurityStatusQueryKey(),
      refetchInterval: 15000,
      refetchOnWindowFocus: true,
    },
  });
  const pauseActive = security?.pauseActive === true;

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
    // Never sent while the console knows about a pause: the server would
    // answer 409 and the operator would learn nothing they can act on.
    if (pauseActive && mode !== 'safe') {
      toast({ title: 'Emergency pause is active', description: PAUSE_REFUSAL, variant: 'destructive' });
      return;
    }

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

  const busy = setMode.isPending || isSigningIn;

  return (
    <div className="w-full">
      {pauseActive && (
        <div
          className="border border-b-0 border-red-500/30 bg-red-950/50 px-1 py-1 text-center font-mono text-[8px] uppercase leading-[1.4] tracking-[0.04em] text-red-300"
          data-testid="text-mode-pause-note"
        >
          <span className="font-bold">Paused</span> Safe only
        </div>
      )}
      <div className="border border-white/[0.08] bg-black/60 flex flex-row md:flex-col w-full divide-x md:divide-x-0 md:divide-y divide-white/[0.06]">
        {MODES.map(m => {
          const active = m.value === current;
          // Only Safe is reachable under a pause. The current mode still keeps
          // its full-strength styling, otherwise the console stops showing
          // which mode the treasury is actually in.
          const blocked = pauseActive && m.value !== 'safe';
          const accent = m.value === 'safe' ? 'text-red-400' : m.value === 'autonomous' ? 'text-primary' : 'text-green-400';
          const rule = m.value === 'safe' ? 'bg-red-400' : m.value === 'autonomous' ? 'bg-primary' : 'bg-green-400';
          const state = active
            ? 'bg-white/[0.05] text-white'
            : blocked
              ? 'text-muted-foreground opacity-40'
              : 'text-muted-foreground hover:text-white/70 hover:bg-white/[0.02]';
          return (
            <button
              key={m.value}
              onClick={() => void handleSelect(m.value)}
              disabled={busy}
              aria-busy={busy}
              aria-disabled={blocked || undefined}
              aria-label={blocked ? `${m.label} unavailable. ${PAUSE_REFUSAL}` : m.label}
              title={
                blocked
                  ? `${m.label} unavailable. ${PAUSE_REFUSAL}`
                  : m.value === 'autonomous'
                    ? 'auto-executes in-policy proposals on approval'
                    : m.label
              }
              data-testid={`button-mode-${m.value}`}
              className={`relative flex-1 py-2.5 px-2 md:px-0 flex flex-col items-center justify-center gap-1 transition-colors duration-200 group ${state} ${
                blocked ? 'cursor-not-allowed' : ''
              } ${!session ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {active && <span aria-hidden className={`absolute left-0 top-0 h-0.5 md:h-full w-full md:w-0.5 ${rule}`} />}
              <m.icon className={`w-4 h-4 ${active ? accent : ''}`} />
              {blocked && <Lock aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 text-red-400" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
