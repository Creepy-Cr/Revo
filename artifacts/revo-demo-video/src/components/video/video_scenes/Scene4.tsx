import { motion } from 'framer-motion';

export function Scene4() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#050505] overflow-hidden">
      <div className="texture-overlay" />
      <div className="noise-overlay" />

      {/* Subtle beam pulse in background */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 0.15, scale: 1 }}
        exit={{ opacity: 0, scale: 1.1 }}
        transition={{ duration: 3, ease: "easeOut" }}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary rounded-full blur-[150px] mix-blend-screen"
      />

      <div className="relative z-10 flex flex-col items-center justify-center text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
          className="mb-12"
        >
          <img 
            src={`${import.meta.env.BASE_URL}brand/revo-lockup.png`} 
            alt="Revo Treasury" 
            className="h-32 object-contain mx-auto"
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 1, delay: 1 }}
        >
          <div className="text-sm font-mono tracking-[0.3em] text-white/50 uppercase mb-4">
            Available Now on Arc Testnet
          </div>
          <div className="text-xl font-mono text-primary font-medium tracking-widest uppercase border border-primary/30 bg-primary/5 px-8 py-3 rounded-md">
            therevo.xyz
          </div>
        </motion.div>
      </div>
    </div>
  );
}