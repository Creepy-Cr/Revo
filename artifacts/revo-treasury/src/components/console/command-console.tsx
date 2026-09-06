import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubmitTreasuryCommand, getListTreasuryPoliciesQueryKey, getListTreasuryProposalsQueryKey, getGetTreasuryDashboardQueryKey } from '@workspace/api-client-react';
import { Send, Loader2, ShieldAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from './auth-context';
import { apiErrorMessage } from '@/lib/api-error';
import { trackEvent } from '@/lib/analytics';

export function CommandConsole() {
  const [input, setInput] = useState('');
  const { session } = useAuthContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const command = useSubmitTreasuryCommand();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) {
      toast({ title: 'Sign in to act', description: 'You must be signed in to submit commands.', variant: 'destructive' });
      return;
    }
    if (!input.trim() || command.isPending) return;

    trackEvent('policy_command_submitted');
    command.mutate({ data: { command: input } }, {
      onSuccess: (policy) => {
        trackEvent('policy_compiled');
        toast({
          title: 'Policy Compiled',
          description: `Draft "${policy.name}" ready for review.`,
          variant: 'default',
        });
        setInput('');
        queryClient.invalidateQueries({ queryKey: getListTreasuryPoliciesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTreasuryProposalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
      },
      onError: (err: any) => {
        toast({
          title: 'Compilation Failed',
          description: apiErrorMessage(err, 'Command could not be compiled.'),
          variant: 'destructive',
        });
      }
    });
  };

  const isDisabled = !session || command.isPending;

  return (
    <div className="flex flex-col">
      <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2 mb-4 shrink-0">
        <span className="text-white/40">SYS //</span> CONSOLE
      </h3>
      <form onSubmit={handleSubmit} className="relative group">
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <span className="text-primary font-mono font-semibold tabular-nums">{'>'}</span>
        </div>
        <input 
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={session ? "e.g. 'Cap risk assets at 15% and rotate to stablecoins if drawdown exceeds 5%'" : "Sign in to compile commands"}
          className={`w-full bg-background border border-border rounded-[4px] py-4 pl-10 pr-14 text-sm font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-primary/50 focus:bg-[#0a0a0a] transition-all shadow-inner ${!session ? 'opacity-50 cursor-not-allowed' : ''}`}
          disabled={isDisabled}
        />
        <button 
          type="submit" 
          disabled={isDisabled || (!input.trim() && !!session)}
          className="absolute inset-y-0 right-2 flex items-center justify-center w-10 text-muted-foreground hover:text-primary disabled:opacity-50 disabled:hover:text-muted-foreground transition-colors"
        >
          {command.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : !session ? <ShieldAlert className="w-4 h-4 text-primary/50" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  );
}
