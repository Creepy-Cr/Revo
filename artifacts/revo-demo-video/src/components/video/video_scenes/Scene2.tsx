import { motion } from 'framer-motion';

export function Scene2() {
  return (
    <div className="absolute inset-0 bg-[#000000] text-white flex justify-center items-center overflow-hidden font-sans p-12">
      <div className="w-full max-w-4xl bg-[#050505] border border-white/10 p-10 rounded-xl shadow-2xl relative">

        <div className="flex items-center justify-between mb-10 border-b border-white/10 pb-6">
          <h3 className="text-sm font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-3">
            <span className="text-white/40">01 //</span> ACTIVE RULES
          </h3>
          <span className="font-mono text-sm font-medium uppercase tracking-[0.1em] text-white/50">
            DRAFT PENDING REVIEW
          </span>
        </div>

        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="relative flex flex-col"
        >
          <div className="flex justify-between items-start mb-4">
            <div className="font-display text-4xl text-white tracking-tight">Risk Capped Rebalance</div>
            <div className="flex items-center gap-2 text-sm font-mono font-bold tracking-[0.1em] uppercase text-primary bg-primary/10 px-4 py-2 rounded-full border border-primary/20">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              DRAFT
            </div>
          </div>
          <div className="text-xl text-white/60 mb-10 leading-relaxed font-sans">
            Cap risk assets at 15% and rotate to stablecoins if drawdown exceeds 5%.
          </div>

          <div className="flex flex-col gap-4 bg-[#0a0a0a] p-8 rounded-lg border border-white/5">
            {[
              { label: 'MAX PROTOCOL EXPOSURE', val: '15%' },
              { label: 'MIN STABLE RESERVE', val: '25%' },
              { label: 'MAX DRAWDOWN', val: '5%' },
              { label: 'RISK CEILING', val: 'LOW' }
            ].map((r, i) => (
              <motion.div
                key={r.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.5 + i * 0.15 }}
                className="flex justify-between items-end gap-6 py-3 border-b border-white/[0.04] last:border-0"
              >
                <div className="text-sm font-mono text-white/50 uppercase tracking-[0.1em]">{r.label}</div>
                <div className="flex-1 border-b border-dashed border-white/10 relative -top-2" />
                <div className="text-xl font-mono font-bold text-white uppercase tabular-nums">{r.val}</div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 2.5, duration: 0.8 }}
          className="absolute -right-8 -bottom-8 bg-primary/20 backdrop-blur-xl border border-primary/50 text-white p-6 rounded-lg shadow-[0_0_40px_rgba(252,59,0,0.3)] max-w-sm"
        >
          <div className="font-mono text-xs text-primary mb-2 uppercase tracking-widest font-bold">System Note</div>
          <div className="text-lg leading-snug">Operator reviews the policy before any execution is permitted.</div>
        </motion.div>
      </div>
    </div>
  );
}
