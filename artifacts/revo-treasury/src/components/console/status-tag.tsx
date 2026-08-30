import { cn } from '@/lib/utils';

/**
 * Terminal-style status tag - replaces rounded pill badges everywhere.
 * A small colored tick + monospaced letterspaced label. No bubble, no fill:
 * status reads like instrument telemetry, not a sticker.
 */

export type StatusTone = 'positive' | 'negative' | 'warning' | 'neutral' | 'accent' | 'sim';

const TEXT: Record<StatusTone, string> = {
  positive: 'text-green-400',
  negative: 'text-red-400',
  warning: 'text-yellow-400',
  neutral: 'text-muted-foreground',
  accent: 'text-primary',
  sim: 'text-purple-400',
};

const DOT: Record<StatusTone, string> = {
  positive: 'bg-green-400',
  negative: 'bg-red-400',
  warning: 'bg-yellow-400',
  neutral: 'bg-white/30',
  accent: 'bg-primary',
  sim: 'bg-purple-400',
};

export function StatusTag({
  label,
  tone = 'neutral',
  pulse = false,
  className,
}: {
  label: string;
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 font-mono text-[10px] sm:text-xs font-semibold uppercase tracking-[0.15em] whitespace-nowrap',
        TEXT[tone],
        className,
      )}
    >
      <span className="flex items-center justify-center">
        {pulse && (
          <span className={cn('absolute w-1.5 h-1.5 rounded-full animate-ping opacity-75', DOT[tone])} />
        )}
        <span className={cn('relative w-1.5 h-1.5 rounded-sm', DOT[tone])} />
      </span>
      {label}
    </span>
  );
}
