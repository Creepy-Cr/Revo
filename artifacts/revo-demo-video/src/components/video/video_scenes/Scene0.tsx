import { motion } from 'framer-motion';

export function Scene0() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black overflow-hidden">
      <div className="texture-overlay" />
      <div className="noise-overlay" />
      
      {/* Video Background */}
      <motion.video
        initial={{ opacity: 0, scale: 1.1 }}
        animate={{ opacity: 0.6, scale: 1 }}
        exit={{ opacity: 0, scale: 1.05 }}
        transition={{ duration: 2, ease: "easeOut" }}
        src={`${import.meta.env.BASE_URL}videos/hero-beam.webm`}
        autoPlay
        muted
        loop
        playsInline
        className="absolute w-full h-[120%] object-cover object-top mix-blend-screen"
        style={{ WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 80%, transparent 100%)' }}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/40 to-black pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center justify-center w-full max-w-5xl px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.5 }}
          className="mb-8"
        >
          <img 
            src={`${import.meta.env.BASE_URL}brand/revo-mark.png`} 
            alt="Revo" 
            className="w-24 h-24 object-contain mx-auto"
          />
        </motion.div>

        <motion.h1 
          className="text-7xl md:text-8xl font-display font-medium tracking-tight text-white leading-[1.05] drop-shadow-2xl"
        >
          <motion.span
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.8, delay: 0.8, ease: "easeOut" }}
            className="block"
          >
            Autonomous
          </motion.span>
          <motion.span
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.8, delay: 1.1, ease: "easeOut" }}
            className="block"
          >
            Treasury Intelligence
          </motion.span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 1, delay: 2 }}
          className="mt-8 text-xl font-mono text-white/70 tracking-widest uppercase drop-shadow-md"
        >
          Explainable signals <span className="text-primary mx-3">·</span> Deterministic controls
        </motion.p>
      </div>

      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 1, delay: 2.5 }}
        className="absolute bottom-16 left-1/2 -translate-x-1/2 z-20"
      >
        <div className="flex items-center gap-3 px-5 py-2.5 rounded-full bg-primary/10 border border-primary/30 backdrop-blur-md">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          <span className="text-xs font-mono font-bold tracking-[0.2em] text-primary uppercase mt-px">
            Arc Testnet Active
          </span>
        </div>
      </motion.div>
    </div>
  );
}