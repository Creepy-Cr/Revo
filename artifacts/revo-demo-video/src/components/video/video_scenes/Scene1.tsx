import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { Send, Loader2 } from 'lucide-react';

export function Scene1() {
  const [text, setText] = useState('');
  const fullText = "Cap risk assets at 15% and rotate to stablecoins if drawdown exceeds 5%.";
  const [submitting, setSubmitting] = useState(false);
  const [compiled, setCompiled] = useState(false);

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setText(fullText.slice(0, i));
      i++;
      if (i > fullText.length) {
        clearInterval(interval);
        setTimeout(() => setSubmitting(true), 500);
        setTimeout(() => {
          setSubmitting(false);
          setCompiled(true);
        }, 2500);
      }
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 bg-[#000000] text-white flex overflow-hidden font-sans p-8">
      <div className="w-64 border-r border-white/10 p-6 flex flex-col gap-8 opacity-50">
        <div className="text-2xl font-display font-medium flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}brand/revo-mark.png`} className="w-8 h-8 opacity-50 grayscale" alt="Revo" />
          Revo
        </div>
        <div className="flex flex-col gap-4 text-sm font-mono tracking-widest uppercase mt-4">
          <div className="text-white/40">Dashboard</div>
          <div className="text-primary border-l-2 border-primary pl-4 -ml-6">Execution</div>
          <div className="text-white/40">Security</div>
        </div>
      </div>

      <div className="flex-1 p-12 flex flex-col justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-4xl w-full mx-auto"
        >
          <div className="bg-[#050505] border border-white/10 rounded-xl p-8 shadow-2xl">
            <h3 className="text-sm font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2 mb-6">
              <span className="text-white/40">SYS //</span> COMMAND PROMPT
            </h3>

            <div className="relative group mb-8">
              <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
                <span className="text-primary font-mono font-semibold tabular-nums text-xl">{'>'}</span>
              </div>
              <div className="w-full bg-[#0a0a0a] border border-white/20 rounded-md py-6 pl-14 pr-16 text-xl font-mono text-white shadow-inner min-h-[80px] flex items-center">
                {text}
                <motion.span
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 0.8, repeat: Infinity }}
                  className="inline-block w-3 h-6 bg-primary ml-1 align-middle"
                />
              </div>
              <div className="absolute inset-y-0 right-4 flex items-center justify-center w-12 text-primary">
                {submitting ? <Loader2 className="w-6 h-6 animate-spin text-primary" /> : <Send className="w-6 h-6 text-white/50" />}
              </div>
            </div>

            {compiled && (
              <motion.div
                initial={{ opacity: 0, y: 20, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                className="border-t border-white/10 pt-8"
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-3 h-3 rounded-full bg-primary animate-pulse" />
                  <span className="text-sm font-mono text-primary font-bold tracking-widest uppercase">Policy Compiled</span>
                </div>
                <div className="bg-primary/5 border border-primary/20 rounded-md p-6">
                  <div className="text-lg font-display text-white mb-2">Draft: Risk Capped Rebalance</div>
                  <div className="text-sm text-white/60 font-mono tracking-wide uppercase">Ready for review in active rules</div>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>

      <motion.div
        initial={{ x: '80vw', y: '80vh' }}
        animate={{
          x: ['80vw', '75vw', '75vw', '75vw'],
          y: ['80vh', '47vh', '47vh', '47vh'],
          scale: [1, 1, 0.8, 1]
        }}
        transition={{ duration: 11, times: [0, 0.35, 0.4, 1] }}
        className="absolute top-0 left-0 z-50 w-10 h-10 pointer-events-none drop-shadow-xl"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
          <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" fill="white" stroke="black" strokeWidth="1.5"/>
        </svg>
      </motion.div>
    </div>
  );
}
