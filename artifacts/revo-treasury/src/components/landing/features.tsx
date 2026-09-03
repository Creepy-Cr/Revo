import { motion } from 'framer-motion';

// The DAO mandate guardrails are a static server-side constant - mirrored
// here so the public landing page never calls the authed dashboard endpoint
// (which 401s for signed-out visitors and showed "unavailable").
const GUARDRAILS = [
  { id: 'g-1', label: 'Max protocol exposure', value: '35%', state: 'active' },
  { id: 'g-2', label: 'Minimum liquid reserve', value: '25%', state: 'active' },
  { id: 'g-3', label: 'Emergency exit threshold', value: 'Risk 80+', state: 'armed' },
  { id: 'g-4', label: 'Execution environment', value: 'Testnet only', state: 'locked' },
];

export function Features() {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.2 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 30 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const }
    }
  };

  return (
    <section id="features" className="py-32 px-4 relative z-10 overflow-hidden">
      {/* Faint warm under-glow horizon between sections */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[80%] h-[1px] bg-gradient-to-r from-transparent via-[#FC3B00]/10 to-transparent" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[60%] h-[200px] bg-gradient-to-t from-[#FC3B00]/5 to-transparent blur-[50px] pointer-events-none" />

      <div className="max-w-6xl mx-auto relative z-10">
        
        <div className="text-center mb-32 flex flex-col items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.7 }}
            className="flex items-center gap-3 mb-6"
          >
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-primary animate-ping absolute opacity-75" />
              <span className="w-1.5 h-1.5 bg-primary relative" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-[0.2em] text-primary uppercase">Core Capabilities</span>
            <div className="w-12 h-px bg-gradient-to-r from-primary/40 to-transparent" />
          </motion.div>
          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.7, delay: 0.1 }}
            className="text-4xl md:text-6xl font-display font-medium text-white tracking-tight leading-tight mb-6"
          >
            Built for safety.<br/><span className="text-muted-foreground">Powered by intelligence.</span>
          </motion.h2>
        </div>

        <motion.div 
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          className="space-y-32"
        >
          {/* Feature 1 */}
          <motion.div variants={itemVariants} className="flex flex-col md:flex-row items-center gap-12 md:gap-24">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4 mb-2">
                <div className="text-xs font-mono text-muted-foreground tracking-[0.14em] tabular-nums">01 //</div>
                <div className="h-px flex-1 bg-gradient-to-r from-white/[0.08] to-transparent" />
              </div>
              <h3 className="text-3xl md:text-4xl font-display font-medium text-white tracking-tight leading-tight">Natural Language to Validated Proposals</h3>
              <p className="text-muted-foreground text-lg leading-relaxed font-light">
                No complex scripting required. Express your treasury strategy in plain English. Revo compiles the intent into structured rules, then enforces them server-side on every proposal that follows.
              </p>
              <ul className="space-y-4 pt-4 text-sm font-mono text-muted-foreground leading-relaxed tabular-nums">
                <li className="flex items-center gap-3"><span className="text-primary/70">›</span> Semantically parsed intent</li>
                <li className="flex items-center gap-3"><span className="text-primary/70">›</span> Multi-modal alpha sourcing</li>
                <li className="flex items-center gap-3"><span className="text-primary/70">›</span> Deterministic proposal generation</li>
              </ul>
            </div>
            <div className="flex-1 w-full">
              <div className="glass glass-clear p-2 rounded-2xl relative overflow-hidden group transition-all duration-700 hover:bg-white/[0.03] hover:border-white/[0.12] hover:shadow-[0_0_40px_rgba(252,59,0,0.15)] hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-[80px] -z-10 group-hover:bg-primary/20 transition-colors duration-700" />
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                <div className="glass glass-blur rounded-xl border-white/[0.04] p-6 font-mono text-sm text-muted-foreground shadow-[inset_0_2px_10px_rgba(0,0,0,0.5)] leading-relaxed tabular-nums">
                  <div className="flex items-center gap-2 mb-6 border-b border-white/[0.05] pb-4">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-white/20" />
                      <div className="w-2.5 h-2.5 rounded-full bg-white/20" />
                      <div className="w-2.5 h-2.5 rounded-full bg-white/20" />
                    </div>
                    <div className="text-xs text-muted-foreground tracking-[0.14em] ml-3">REVO CORE</div>
                  </div>
                  <div className="text-muted-foreground mb-2">{'//'} User Input</div>
                  <div className="text-white mb-8">"Rotate 15% of idle USDC into the Arc lending vault."</div>
                  
                  <div className="text-muted-foreground mb-2">{'//'} Execution Trace</div>
                  <div className="text-muted-foreground mb-1.5">Parsing intent...</div>
                  <div className="text-muted-foreground mb-1.5">Validating against DAO guardrails...</div>
                  <div className="text-primary mt-6 flex items-start gap-2">
                    <span className="mt-0.5">›</span> 
                    <span>Proposal compiled, queued for review.<br/>No funds moved.</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Feature 2 */}
          <motion.div variants={itemVariants} className="flex flex-col md:flex-row-reverse items-center gap-12 md:gap-24">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4 mb-2">
                <div className="text-xs font-mono text-muted-foreground tracking-[0.14em] tabular-nums">02 //</div>
                <div className="h-px flex-1 bg-gradient-to-r from-white/[0.08] to-transparent" />
              </div>
              <h3 className="text-3xl md:text-4xl font-display font-medium text-white tracking-tight leading-tight">Hard DAO Guardrails</h3>
              <p className="text-muted-foreground text-lg leading-relaxed font-light">
                Intelligence is dangerous without boundaries. Revo operates within strictly enforced cryptographic and logical guardrails. Maximum drawdown limits, whitelist-only protocols, and mandatory cool-down periods ensure the simulator never goes rogue.
              </p>
            </div>
            <div className="flex-1 w-full">
              <div className="glass glass-clear p-2 rounded-2xl relative overflow-hidden group transition-all duration-700 hover:bg-white/[0.03] hover:border-white/[0.12] hover:shadow-[0_0_40px_rgba(252,59,0,0.15)] hover:-translate-y-1">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                <div className="glass glass-blur rounded-xl p-8 border-white/[0.04] shadow-[inset_0_2px_10px_rgba(0,0,0,0.5)] relative z-10">
                  <div className="space-y-6">
                      {GUARDRAILS.map((rail, idx) => (
                        <div
                          key={rail.id}
                          className={`flex justify-between items-center gap-4 ${idx < GUARDRAILS.length - 1 ? 'pb-5 border-b border-white/[0.05]' : ''}`}
                        >
                          <div className="text-muted-foreground text-sm font-medium leading-relaxed">{rail.label}</div>
                          <div className={`flex items-center gap-2 font-mono text-[10px] sm:text-xs font-semibold uppercase tracking-[0.15em] ${rail.state === 'locked' ? 'text-primary' : rail.state === 'armed' ? 'text-yellow-500' : 'text-green-400'}`}>
                            <span className="flex items-center justify-center">
                              <span className={`relative w-1.5 h-1.5 ${rail.state === 'locked' ? 'bg-primary' : rail.state === 'armed' ? 'bg-yellow-500' : 'bg-green-400'}`} />
                            </span>
                            {rail.value}
                          </div>
                        </div>
                      ))}
                      <div className="pt-4 mt-2 text-xs text-muted-foreground uppercase tracking-[0.14em] text-center border-t border-white/[0.05]">
                        Live DAO Mandate Sync
                      </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Feature 3 */}
          <motion.div variants={itemVariants} className="flex flex-col md:flex-row items-center gap-12 md:gap-24">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4 mb-2">
                <div className="text-xs font-mono text-muted-foreground tracking-[0.14em] tabular-nums">03 //</div>
                <div className="h-px flex-1 bg-gradient-to-r from-white/[0.08] to-transparent" />
              </div>
              <h3 className="text-3xl md:text-4xl font-display font-medium text-white tracking-tight leading-tight">Protocol-Exploit Safety Drill</h3>
              <p className="text-muted-foreground text-lg leading-relaxed font-light">
                Stress-test the agent's reaction time. The built-in safety drill simulates a severe market downturn or smart contract exploit. Watch Arcus detect anomalous outflows, freeze non-essential activities, and queue defensive rebalancing operations instantly.
              </p>
            </div>
            <div className="flex-1 w-full">
              <div className="glass glass-clear p-2 rounded-2xl relative overflow-hidden group transition-all duration-700 hover:bg-red-500/[0.03] hover:border-red-500/[0.2] hover:shadow-[0_0_40px_rgba(239,68,68,0.15)] hover:-translate-y-1">
                <div className="absolute inset-0 bg-gradient-to-br from-red-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                <div className="absolute inset-0 bg-red-500/[0.02] group-hover:bg-red-500/[0.06] transition-colors duration-700" />
                
                <div className="glass glass-blur rounded-xl border-white/[0.04] p-10 flex flex-col items-center justify-center text-center shadow-[inset_0_2px_10px_rgba(0,0,0,0.5)] relative z-10">
                  <div className="w-16 h-16 rounded-full bg-red-500/5 border border-red-500/20 flex items-center justify-center mb-6 relative">
                    <div className="absolute inset-0 rounded-full border border-red-500/30 animate-ping opacity-20" />
                    <span className="text-red-500/80 font-mono text-xs tracking-[0.14em] tabular-nums">WARN</span>
                  </div>
                  <h4 className="text-xl font-display font-medium text-white tracking-tight mb-3 leading-tight">Simulate Crisis</h4>
                  <p className="text-sm text-muted-foreground mb-8 max-w-[250px] font-light leading-relaxed">
                    Trigger a controlled testnet exploit drill to evaluate defensive mechanics.
                  </p>
                  
                  <div className="text-xs font-mono tracking-[0.14em] text-muted-foreground uppercase tabular-nums">
                    Available in Live Terminal
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

        </motion.div>
      </div>
    </section>
  );
}
