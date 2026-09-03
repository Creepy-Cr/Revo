import { motion } from 'framer-motion';

export function HowItWorks() {
  const steps = [
    {
      title: "Command & Context",
      description: "Submit a natural-language strategy. Revo parses the intent and pulls live market data, USDC peg deviation, Arc whale flow, and risk scores."
    },
    {
      title: "Compile & Validate",
      description: "Arcus compiles the intent into an enforced policy. A deterministic engine — not the model — then drafts the rebalance and clamps it against your DAO's guardrails."
    },
    {
      title: "Queue Proposal",
      description: "In Managed mode every proposal waits for human approval; in Autonomous mode Revo acts only inside the active policy. Approving moves the simulated allocation — only deposits and withdrawals touch the chain."
    }
  ];

  return (
    <section id="how-it-works" className="py-32 px-4 relative z-10 border-t border-white/[0.02] overflow-hidden">
      {/* Faint warm under-glow horizon at the bottom */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[90%] h-[1px] bg-gradient-to-r from-transparent via-[#FC3B00]/15 to-transparent" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[70%] h-[250px] bg-gradient-to-t from-[#FF7145]/5 to-transparent blur-[60px] pointer-events-none" />

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
            <span className="text-[10px] font-mono font-bold tracking-[0.2em] text-primary uppercase">Process</span>
            <div className="w-12 h-px bg-gradient-to-r from-primary/40 to-transparent" />
          </motion.div>
          <h2 className="text-4xl md:text-6xl font-display font-medium text-white tracking-tight leading-tight">
            Intelligence,<br/>
            <span className="text-muted-foreground">Bottled & Bound.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 relative">
          {/* Connector Line (desktop) */}
          <div className="hidden md:block absolute top-[40%] left-0 right-0 h-px bg-white/[0.05] -translate-y-1/2 -z-10" />

          {steps.map((step, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: i * 0.2 }}
              className="relative glass glass-blur rounded-2xl p-8 lg:p-10 overflow-hidden group shadow-[0_12px_40px_-8px_rgba(0,0,0,0.8)] transition-all duration-700 hover:bg-white/[0.04] hover:border-white/[0.08] hover:shadow-[0_20px_60px_-10px_rgba(252,59,0,0.2)] hover:-translate-y-1"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
              <div className="absolute -right-8 -bottom-12 text-[160px] font-display font-semibold text-white/[0.03] pointer-events-none select-none transition-all duration-1000 group-hover:scale-105 group-hover:text-white/[0.08] group-hover:-translate-y-4 group-hover:-translate-x-4">
                0{i + 1}
              </div>
              
              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-8">
                  <div className="w-1.5 h-1.5 bg-white/20" />
                  <div className="text-[10px] font-mono text-muted-foreground font-bold tracking-[0.2em] tabular-nums uppercase">
                    STEP 0{i + 1}
                  </div>
                </div>
                
                <h3 className="text-xl font-display font-medium text-white mb-4 tracking-tight leading-tight">{step.title}</h3>
                <p className="text-muted-foreground leading-relaxed font-light text-sm leading-relaxed">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
