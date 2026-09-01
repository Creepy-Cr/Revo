import { motion } from 'framer-motion';

export function Scene1() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black overflow-hidden">
      <div className="texture-overlay" />
      <div className="noise-overlay" />
      
      {/* Background Image - Blurred */}
      <motion.img
        initial={{ opacity: 0, scale: 1.2 }}
        animate={{ opacity: 0.2, scale: 1 }}
        exit={{ opacity: 0, scale: 1.1 }}
        transition={{ duration: 3, ease: "easeOut" }}
        src={`${import.meta.env.BASE_URL}images/revo-demo-landing.jpg`}
        className="absolute inset-0 w-full h-full object-cover blur-md"
      />
      <div className="absolute inset-0 bg-black/60" />

      {/* Persistent Left Accent Line */}
      <motion.div 
        initial={{ scaleY: 0, opacity: 0 }}
        animate={{ scaleY: 1, opacity: 1 }}
        exit={{ scaleY: 0, opacity: 0 }}
        transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
        className="absolute left-16 top-24 bottom-24 w-px bg-gradient-to-b from-transparent via-primary to-transparent origin-top"
      />

      <div className="relative z-10 w-full max-w-6xl px-16 flex flex-col justify-center h-full pl-32">
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 1, delay: 0.3, ease: "easeOut" }}
          className="text-primary font-mono text-sm tracking-[0.2em] uppercase mb-6 flex items-center gap-4"
        >
          <span className="w-8 h-px bg-primary/50"></span>
          The Problem
        </motion.div>

        <motion.h2 
          className="text-6xl md:text-7xl font-display font-medium text-white leading-[1.1] tracking-tight max-w-4xl"
        >
          <motion.span
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="block text-white/40"
          >
            Manual management is
          </motion.span>
          <motion.span
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.8, delay: 0.9 }}
            className="block text-white"
          >
            slow and error-prone.
          </motion.span>
        </motion.h2>

        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 1, delay: 2 }}
          className="mt-16 relative"
        >
          <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full" />
          <div className="relative glass-panel rounded-2xl p-8 max-w-2xl border-l-4 border-l-primary">
            <h3 className="text-2xl font-display text-white mb-3">Enter Arcus</h3>
            <p className="text-lg text-white/70 leading-relaxed font-sans">
              The Revo treasury agent translates natural-language strategies into validated testnet proposals. Operating under hard guardrails to protect protocol assets from exploitation.
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}