import { motion } from 'framer-motion';

export function Scene3() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black overflow-hidden">
      <div className="texture-overlay" />
      <div className="noise-overlay" />

      {/* Floating images in background */}
      <motion.div
        initial={{ opacity: 0, y: 100, rotateX: 20, z: -200 }}
        animate={{ opacity: 0.4, y: -40, rotateX: 0, z: 0 }}
        exit={{ opacity: 0, y: -100 }}
        transition={{ duration: 3, ease: "easeOut" }}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-5xl perspective-1000"
        style={{ perspective: '1000px' }}
      >
        <motion.img 
          src={`${import.meta.env.BASE_URL}images/revo-demo-console.jpg`}
          className="w-full rounded-lg border border-white/10 shadow-2xl opacity-50 absolute -top-32 -left-16 scale-90"
        />
        <motion.img 
          initial={{ z: -100 }}
          animate={{ z: 50 }}
          transition={{ duration: 4 }}
          src={`${import.meta.env.BASE_URL}images/revo-demo-dashboard.jpg`}
          className="w-full rounded-lg border border-white/20 shadow-[0_20px_60px_-15px_rgba(252,59,0,0.3)] relative z-10"
        />
      </motion.div>

      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-transparent" />

      <div className="relative z-20 w-full max-w-5xl px-12 text-center mt-[40vh]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 1, delay: 0.5, ease: "easeOut" }}
        >
          <div className="inline-flex items-center gap-4 px-6 py-3 rounded-full bg-[#0a0a0a] border border-white/10 mb-8 mx-auto">
            <span className="text-primary font-mono text-xs tracking-widest uppercase">
              02 // Security
            </span>
            <div className="w-px h-4 bg-white/20" />
            <span className="text-white/70 font-mono text-xs tracking-widest uppercase">
              Operator-Gated
            </span>
          </div>

          <h2 className="text-5xl md:text-6xl font-display font-medium text-white leading-[1.1] tracking-tight mb-8 drop-shadow-xl">
            Strict human approval. <br/>
            <span className="text-white/40">Zero gas signatures.</span>
          </h2>
          
          <div className="flex justify-center gap-8 font-mono text-sm tracking-widest uppercase text-white/50">
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-primary rounded-full" />
              EIP-6963 Wallets
            </span>
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
              Testnet Only
            </span>
          </div>
        </motion.div>
      </div>
    </div>
  );
}