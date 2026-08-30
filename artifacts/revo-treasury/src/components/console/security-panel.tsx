import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useGetSecurityStatus, getGetSecurityStatusQueryKey,
  useSetSecurityLimits,
  useListOperators, getListOperatorsQueryKey,
  useSetOperatorRole,
  useSetEmergencyPause,
  useListAlerts, getListAlertsQueryKey,
  useAcknowledgeAlert,
  exportAuditLog,
  type AlertItem,
} from '@workspace/api-client-react';
import { useAuthContext } from './auth-context';
import { UserCog, SlidersHorizontal, Settings2, ShieldAlert, AlertTriangle, FileDown, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { apiErrorMessage } from '@/lib/api-error';

export function SecurityPanel() {
  const { session } = useAuthContext();
  const { data: status } = useGetSecurityStatus({
    query: {
      queryKey: getGetSecurityStatusQueryKey(),
      refetchInterval: 15000,
    }
  });

  const { data: operators } = useListOperators({
    query: {
      queryKey: getListOperatorsQueryKey(),
      enabled: session?.role === 'admin'
    }
  });

  const isAdmin = session?.role === 'admin';
  const isGuardianOrAdmin = session?.role === 'admin' || session?.role === 'guardian';

  if (!status) return null;

  return (
    <div className="console-card flex flex-col h-full">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2">
          <span className="text-white/40">02 //</span> SECURITY CONTROLS
        </h3>
        <div className="flex items-center gap-3">
          {session && <AuditExportButton />}
          {isGuardianOrAdmin && !status.pauseActive && (
            <PauseDialog />
          )}
          {isAdmin && (
            <Dialog>
              <DialogTrigger asChild>
                <button className="text-muted-foreground hover:text-white transition-colors" title="Manage limits & operators">
                  <Settings2 className="w-4 h-4" />
                </button>
              </DialogTrigger>
              <DialogContent className="text-white bg-[#050505] border border-white/10 rounded-[4px] shadow-2xl">
                <DialogHeader>
                  <DialogTitle className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    <span className="text-white/40">SYS //</span> SECURITY MANAGEMENT
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-6 pt-4">
                  <LimitsEditor status={status} />
                  <div className="border-t border-white/10 pt-4">
                    <h4 className="text-[10px] font-mono font-bold text-white/80 mb-4 flex items-center gap-2 tracking-widest uppercase">
                      <UserCog className="w-3.5 h-3.5 text-primary" /> OPERATOR ROLES
                    </h4>
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                      {operators?.map(op => (
                        <OperatorRow key={op.wallet} op={op} />
                      ))}
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="flex flex-col">
        <LimitItem label="PER-WITHDRAWAL" value={status.maxPerWithdrawalUsdc} />
        <LimitItem label="WALLET 24H" value={status.maxWallet24hUsdc} />
        <LimitItem label="GLOBAL 24H" value={status.maxGlobal24hUsdc} />
      </div>

      {session && <AlertsSection />}
    </div>
  );
}

function AuditExportButton() {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const download = async () => {
    setBusy(true);
    try {
      const data = await exportAuditLog();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `revo-audit-log-${data.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(
        data.verified
          ? { title: 'Audit log exported', description: `${data.events.length} events. Hash chain verified.` }
          : { title: 'Audit chain BROKEN', description: `Verification failed at event #${data.brokenAtSeq}.`, variant: 'destructive' },
      );
    } catch (err) {
      toast({ title: 'Export failed', description: apiErrorMessage(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={download}
      disabled={busy}
      className="text-muted-foreground hover:text-white transition-colors disabled:opacity-50"
      title="Export hash-chained audit log (JSON)"
      data-testid="button-export-audit"
    >
      <FileDown className="w-4 h-4" />
    </button>
  );
}

function AlertsSection() {
  const { data: alerts } = useListAlerts({
    query: { queryKey: getListAlertsQueryKey(), refetchInterval: 30000, retry: false },
  });
  if (!alerts) return null;
  const active = alerts.filter((a) => !a.acknowledgedAt);

  return (
    <div className="mt-6 pt-4 border-t border-white/[0.08]">
      <h4 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground flex items-center justify-between mb-4 uppercase">
        <span><span className="text-white/40">SYS //</span> ALERTS</span>
        {active.length > 0 && (
          <span className="text-red-400 font-bold">
            [{active.length} ACTIVE]
          </span>
        )}
      </h4>
      {active.length === 0 ? (
        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest text-center py-4 border-y border-white/[0.04]" data-testid="text-no-alerts">NO ACTIVE ALERTS</p>
      ) : (
        <div className="flex flex-col">
          {active.map((alert, i) => (
            <AlertRow key={alert.id} alert={alert} isLast={i === active.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert, isLast }: { alert: AlertItem, isLast: boolean }) {
  const ack = useAcknowledgeAlert();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const severityDot =
    alert.severity === 'critical'
      ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]'
      : alert.severity === 'warning'
        ? 'bg-amber-400'
        : 'bg-white/40';

  return (
    <div
      className={`flex items-start gap-3 py-3 ${!isLast ? 'border-b border-white/[0.04]' : ''}`}
      data-testid={`alert-row-${alert.kind}`}
    >
      <div className={`w-1.5 h-1.5 rounded-sm mt-1.5 shrink-0 ${severityDot}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-white/90 leading-snug">{alert.title}</p>
        <p className="text-[11px] text-muted-foreground leading-snug mt-1">{alert.detail}</p>
        <p className="text-[9px] font-mono text-white/30 mt-2 tabular-nums tracking-widest uppercase">{new Date(alert.time).toLocaleString()}</p>
      </div>
      <button
        onClick={() =>
          ack.mutate(
            { alertId: alert.id },
            {
              onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey() }),
              onError: (err) =>
                toast({ title: 'Could not acknowledge', description: apiErrorMessage(err), variant: 'destructive' }),
            },
          )
        }
        disabled={ack.isPending}
        className="shrink-0 text-muted-foreground hover:text-green-400 transition-colors disabled:opacity-40 p-1"
        title="Acknowledge"
        data-testid={`button-ack-${alert.id}`}
      >
        <Check className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function PauseDialog() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const setPause = useSetEmergencyPause();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleActivate = () => {
    if (reason.trim().length < 4) {
      toast({ title: 'Reason required', description: 'Please provide a valid reason (min 4 characters).', variant: 'destructive' });
      return;
    }
    setPause.mutate({ data: { active: true, reason } }, {
      onSuccess: () => {
        toast({ title: 'Emergency Pause Activated', variant: 'destructive' });
        queryClient.invalidateQueries({ queryKey: getGetSecurityStatusQueryKey() });
        setOpen(false);
        setReason('');
      },
      onError: (err) => {
        toast({ title: 'Failed to activate pause', description: apiErrorMessage(err), variant: 'destructive' });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1 rounded transition-colors" title="Emergency Pause">
          <ShieldAlert className="w-4 h-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="text-white bg-[#050505] border border-white/10 rounded-[4px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-500 font-mono text-xs uppercase tracking-widest">
            <AlertTriangle className="w-4 h-4" /> ACTIVATE EMERGENCY PAUSE
          </DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <p className="text-[13px] text-red-200/80 leading-relaxed font-sans">
            This will immediately halt all withdrawals, approvals, and mode changes. It should only be used if you suspect a compromise or severe protocol anomaly.
          </p>
          <div>
            <label className="block text-[10px] font-mono tracking-widest text-white/80 mb-2 uppercase">
              REASON <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you pausing the system?"
              className="w-full bg-[#0a0a0a] border border-red-500/30 rounded-[2px] p-3 text-sm text-white focus:outline-none focus:border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.1)_inset] leading-relaxed"
              disabled={setPause.isPending}
            />
          </div>
        </div>
        <DialogFooter>
          <button
            onClick={() => setOpen(false)}
            disabled={setPause.isPending}
            className="px-4 py-2 rounded-[2px] text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground hover:text-white transition-colors disabled:opacity-50"
          >
            CANCEL
          </button>
          <button
            onClick={handleActivate}
            disabled={setPause.isPending || reason.trim().length < 4}
            className="px-4 py-2 rounded-[2px] text-xs font-mono font-bold uppercase tracking-widest text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {setPause.isPending ? 'ACTIVATING...' : 'ACTIVATE PAUSE'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LimitItem({ label, value }: { label: string, value: number }) {
  return (
    <div className="flex justify-between items-end gap-4 py-3 border-b border-white/[0.04] last:border-b-0">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div className="flex-1 border-b border-dashed border-white/10 relative -top-1" />
      <div className="text-[11px] font-mono font-bold text-white leading-relaxed tabular-nums">
        {value.toLocaleString()} <span className="text-muted-foreground text-[10px] font-normal">USDC</span>
      </div>
    </div>
  );
}

function LimitsEditor({ status }: { status: any }) {
  const [maxPerTx, setMaxPerTx] = useState(status.maxPerWithdrawalUsdc.toString());
  const [maxWallet, setMaxWallet] = useState(status.maxWallet24hUsdc.toString());
  const [maxGlobal, setMaxGlobal] = useState(status.maxGlobal24hUsdc.toString());
  
  const setLimits = useSetSecurityLimits();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const data = {
      maxPerWithdrawalUsdc: Number(maxPerTx),
      maxWallet24hUsdc: Number(maxWallet),
      maxGlobal24hUsdc: Number(maxGlobal)
    };
    
    setLimits.mutate({ data }, {
      onSuccess: () => {
        toast({ title: 'Limits updated' });
        queryClient.invalidateQueries({ queryKey: getGetSecurityStatusQueryKey() });
      },
      onError: (err) => {
        toast({ title: 'Update failed', description: apiErrorMessage(err), variant: 'destructive' });
      }
    });
  };

  return (
    <div className="space-y-4">
      <h4 className="text-[10px] font-mono font-bold text-white/80 flex items-center gap-2 uppercase tracking-widest">
        <SlidersHorizontal className="w-3.5 h-3.5 text-primary" /> WITHDRAWAL LIMITS
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-[10px] font-mono tracking-widest uppercase text-muted-foreground mb-1">PER TX</label>
          <input type="number" value={maxPerTx} onChange={e => setMaxPerTx(e.target.value)} className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-[2px] p-2 text-xs font-mono text-white focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="block text-[10px] font-mono tracking-widest uppercase text-muted-foreground mb-1">WALLET 24H</label>
          <input type="number" value={maxWallet} onChange={e => setMaxWallet(e.target.value)} className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-[2px] p-2 text-xs font-mono text-white focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="block text-[10px] font-mono tracking-widest uppercase text-muted-foreground mb-1">GLOBAL 24H</label>
          <input type="number" value={maxGlobal} onChange={e => setMaxGlobal(e.target.value)} className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-[2px] p-2 text-xs font-mono text-white focus:outline-none focus:border-primary/50" />
        </div>
      </div>
      <button 
        onClick={handleSave} 
        disabled={setLimits.isPending}
        className="w-full bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 rounded-[2px] py-2 text-[10px] font-mono font-bold tracking-widest uppercase transition-colors disabled:opacity-50"
      >
        {setLimits.isPending ? 'SAVING...' : 'SAVE LIMITS'}
      </button>
    </div>
  );
}

function OperatorRow({ op }: { op: any }) {
  const setRole = useSetOperatorRole();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const role = e.target.value as any;
    setRole.mutate({ wallet: op.wallet, data: { role } }, {
      onSuccess: () => {
        toast({ title: 'Role updated' });
        queryClient.invalidateQueries({ queryKey: getListOperatorsQueryKey() });
      },
      onError: (err) => {
        toast({ title: 'Update failed', description: apiErrorMessage(err), variant: 'destructive' });
      }
    });
  };

  return (
    <div className="flex justify-between items-end gap-4 py-2 border-b border-white/[0.04] last:border-0">
      <div className="font-mono text-[11px] text-white/80 tabular-nums">
        {op.wallet.slice(0, 6)}...{op.wallet.slice(-4)}
      </div>
      <div className="flex-1 border-b border-dashed border-white/10 relative -top-1" />
      <select 
        value={op.role} 
        onChange={handleRoleChange}
        disabled={setRole.isPending}
        className="bg-transparent text-[10px] font-mono font-bold uppercase tracking-widest text-primary hover:text-white transition-colors focus:outline-none text-right cursor-pointer"
      >
        <option value="viewer" className="bg-[#050505]">VIEWER</option>
        <option value="strategist" className="bg-[#050505]">STRATEGIST</option>
        <option value="approver" className="bg-[#050505]">APPROVER</option>
        <option value="guardian" className="bg-[#050505]">GUARDIAN</option>
        <option value="admin" className="bg-[#050505]">ADMIN</option>
      </select>
    </div>
  );
}
