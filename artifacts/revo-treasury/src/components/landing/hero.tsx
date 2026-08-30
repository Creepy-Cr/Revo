import { motion } from 'framer-motion';
import { Link } from 'wouter';

export function Hero() {
  return (
    <section id="hero" className="relative min-h-[90vh] flex flex-col items-center justify-center pt-32 pb-20 px-4 overflow-hidden">
      <div className="hero-scrim" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-4xl mx-auto flex flex-col items-center text-center">
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="text-5xl md:text-7xl lg:text-8xl font-display font-medium tracking-tighter leading-[1.05] mb-6 text-transparent bg-clip-text bg-gradient-to-b from-white via-white to-white/60"
        >
          Autonomous
          <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-orange-200 to-white/40">
            Treasury Intelligence
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.3 }}
          className="text-lg md:text-xl text-white/85 max-w-2xl mb-12 leading-relaxed font-light tracking-tight [text-shadow:0_2px_20px_rgba(0,0,0,0.75),0_1px_4px_rgba(0,0,0,0.6)]"
        >
          Arcus, the Revo treasury agent, translates natural-language strategies into validated testnet proposals. 
          Operating under hard guardrails to protect protocol assets from exploitation.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4 }}
          className="flex flex-col sm:flex-row items-center gap-6"
        >
          <Link
            href="/app"
            data-testid="hero-launch-console"
            className="group relative px-8 py-4 bg-white text-black rounded-full font-sans font-semibold text-lg tracking-tight overflow-hidden transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] shadow-[0_0_40px_rgba(252,59,0,0.15)] hover:shadow-[0_0_60px_rgba(252,59,0,0.5)] border border-transparent hover:border-primary/50"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary via-accent to-primary opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <span className="relative z-10 flex items-center gap-2 group-hover:text-white transition-colors duration-500">
              Launch Console
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transform group-hover:translate-x-1 transition-transform duration-300">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </span>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
