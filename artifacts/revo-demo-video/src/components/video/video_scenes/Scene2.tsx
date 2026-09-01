import { motion } from 'framer-motion';

export function Scene2() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#050505] overflow-hidden">
      <div className="texture-overlay" />
      <div className="noise-overlay" />

      {/* Grid Background */}
      <div className="absolute inset-0" style={{
        backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)`,
        backgroundSize: '80px 80px'
      }} />

      <div className="relative z-10 w-full max-w-7xl px-12 grid grid-cols-12 gap-8 items-center">
        {/* Left Column - Context */}
        <div className="col-span-5 flex flex-col justify-center">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 1, delay: 0.3, ease: "easeOut" }}
            className="text-primary font-mono text-sm tracking-[0.2em] uppercase mb-6 flex items-center gap-4"
          >
            <span className="w-8 h-px bg-primary/50"></span>
            01 // Execution
          </motion.div>

          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="text-5xl font-display font-medium text-white leading-tight mb-6"
          >
            Write rules in <br/>
            <span className="text-primary">natural language.</span>
          </motion.h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.8, delay: 0.8 }}
            className="text-lg text-white/50 leading-relaxed font-sans max-w-md"
          >
            Arcus mechanically enforces your policy into structural rules.
          </motion.p>
        </div>

        {/* Right Column - UI Mockup */}
        <div className="col-span-7 relative">
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 1.2, delay: 1, ease: [0.16, 1, 0.3, 1] }}
            className="glass-panel rounded-xl p-8 border border-white/10 shadow-2xl relative"
          >
            {/* Command Prompt */}
            <div className="mb-8">
              <h3 className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase flex items-center gap-2 mb-4">
                SYS // COMMAND PROMPT
              </h3>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <span className="text-primary font-mono font-bold">{'>'}</span>
                </div>
                <div className="w-full bg-[#0a0a0a] border border-white/10 rounded-md py-4 pl-12 pr-4 text-sm font-mono text-white shadow-inner">
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.1, delay: 1.5 }}
                  >
                    Cap risk assets at 15%
                  </motion.span>
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.1, delay: 1.8 }}
                  >
                    {" "}and rotate to stablecoins if drawdown exceeds 5%
                  </motion.span>
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{ duration: 0.8, repeat: Infinity, delay: 2.2 }}
                    className="inline-block w-2 h-4 bg-primary ml-1 align-middle"
                  />
                </div>
              </div>
            </div>

            {/* Policy Output - staggered reveal */}
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.8, delay: 2.8 }}
              className="border-t border-white/10 pt-6 overflow-hidden"
            >
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs font-mono text-primary font-bold tracking-widest uppercase">Draft Compiled</span>
              </div>
              
              <div className="space-y-3">
                {[
                  { label: 'MAX PROTOCOL EXPOSURE', val: '15%' },
                  { label: 'MIN STABLE RESERVE', val: '25%' },
                  { label: 'MAX DRAWDOWN', val: '5%' },
                  { label: 'RISK CEILING', val: 'low' }
                ].map((r, i) => (
                  <motion.div 
                    key={r.label}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 3.2 + (i * 0.15) }}
                    className="flex justify-between items-end gap-4 py-2 border-b border-white/[0.04]"
                  >
                    <div className="text-[10px] font-mono text-white/50 uppercase tracking-[0.1em]">{r.label}</div>
                    <div className="flex-1 border-b border-dashed border-white/10 relative -top-1" />
                    <div className="text-[11px] font-mono font-bold text-white uppercase tabular-nums">{r.val}</div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}