import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useAuthContext } from './auth-context';
import { useToast } from '@/hooks/use-toast';
import { ShieldAlert, AlertTriangle } from 'lucide-react';

export function RejectDialog({ 
  open, 
  onOpenChange, 
  onConfirm, 
  title, 
  description,
  isPending 
}: { 
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  title: string;
  description: string;
  isPending: boolean;
}) {
  const [reason, setReason] = useState('');
  const { session } = useAuthContext();
  const { toast } = useToast();

  const handleConfirm = () => {
    if (!session) {
      toast({ title: 'Sign in to act', variant: 'destructive' });
      return;
    }
    if (reason.trim().length < 4) {
      toast({ title: 'Reason required', description: 'Please provide a valid reason (min 4 characters).', variant: 'destructive' });
      return;
    }
    onConfirm(reason);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (o) setReason('');
      onOpenChange(o);
    }}>
      <DialogContent className="text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-400">
            <AlertTriangle className="w-5 h-5" /> {title}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <label className="block text-sm font-medium text-white/80 mb-2 leading-relaxed">
            Reason for rejection <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being rejected?"
            className="w-full bg-background border border-border rounded-lg p-3 text-sm text-white focus:outline-none focus:border-red-500/50 leading-relaxed"
            disabled={isPending}
            autoFocus
          />
          <p className="text-xs text-muted-foreground mt-2">This will be recorded in the permanent audit log.</p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <button
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 leading-relaxed"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isPending || reason.trim().length < 4}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 transition-colors disabled:opacity-50 flex items-center gap-2 leading-relaxed"
          >
            {isPending && <ShieldAlert className="w-4 h-4 animate-pulse" />}
            Confirm Rejection
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}