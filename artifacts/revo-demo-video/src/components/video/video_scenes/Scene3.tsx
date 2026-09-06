import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { Check, X } from 'lucide-react';

export function Scene3() {
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setApproved(true);
    }, 4500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="absolute inset-0 bg-[#000000] text-white flex justify-center items-center overflow-hidden font-sans p-12">
      <div className="w-full max-w-4xl bg-[#050505] border border-white/10 p-10 rounded-xl shadow-2xl relative">
        <div className="flex items-center justify-between mb-8 border-b border-white/10 pb-6">
          <h3 className="text-sm font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-3">
            <span className="text-white/40">02 //</span> PENDING ACTIONS
          </h3>
          <span className="font-mono text-sm font-medium uppercase tracking-[0.1em] text-yellow-500">
            {approved ? '0 PENDING' : '1 PENDING'}
          </span>
        </div>

        <motion.div
          animate={approved ? { opacity: 0.5, scale: 0.98 } : { opacity: 1, scale: 1 }}
          className="relative flex flex-col border border-white/10 bg-[#0a0a0a] p-8 rounded-lg"
        >
          <div className="flex justify-between items-start mb-4">
            <div className="font-display text-3xl text-white tracking-tight">Rebalance: Risk Cap Enforced</div>
            <div className={`flex items-center gap-2 text-sm font-mono font-bold tracking-[0.1em] uppercase px-3 py-1.5 rounded-sm border ${approved ? 'text-green-400 border-green-500/30 bg-green-500/10' : 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10'}`}>
              <div className={`w-2 h-2 rounded-full ${approved ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}`} />
              {approved ? 'EXECUTED' : 'PENDING'}
            </div>
          </div>
          <div className="text-lg text-white/50 mb-8 leading-relaxed">
            Reducing volatile asset exposure to comply with maximum 15% protocol limit.
          </div>
          
          <div className="flex flex-col mb-10">
            <div className="text-xs font-mono uppercase tracking-[0.1em] text-white/40 mb-3">TARGET ALLOCATION</div>
            <div className="flex h-3 w-full bg-white/[0.05] overflow-hidden rounded-full mb-4 border border-white/[0.04]">
              <motion.div className="h-full bg-primary" initial={{ width: 0 }} animate={{ width: '85%' }} transition={{ duration: 1 }} />
              <motion.div className="h-full bg-green-500" initial={{ width: 0 }} animate={{ width: '10%' }} transition={{ duration: 1, delay: 0.2 }} />
              <motion.div className="h-full bg-amber-500" initial={{ width: 0 }} animate={{ width: '5%' }} transition={{ duration: 1, delay: 0.4 }} />
            </div>
            <div className="flex gap-6 text-sm font-mono tracking-widest">
              <span><span className="text-white/60">USDC</span> <span className="text-white">85.0%</span></span>
              <span><span className="text-white/60">EURC</span> <span className="text-white">10.0%</span></span>
              <span><span className="text-white/60">cirBTC</span> <span className="text-white">5.0%</span></span>
            </div>
          </div>

          <div className="flex gap-4 mt-2">
            <button className="flex-1 py-4 flex items-center justify-center gap-2 text-sm font-mono font-bold tracking-widest text-red-400 bg-red-400/10 border border-red-400/20 rounded uppercase">
              <X className="w-5 h-5" /> REJECT
            </button>
            <button className={`flex-1 py-4 flex items-center justify-center gap-2 text-sm font-mono font-bold tracking-widest text-white border rounded uppercase transition-colors ${approved ? 'bg-green-600 border-green-500' : 'bg-primary border-primary shadow-[0_0_20px_rgba(252,59,0,0.3)]'}`}>
              <Check className="w-5 h-5" /> {approved ? 'APPROVED' : 'APPROVE'}
            </button>
          </div>
        </motion.div>

        {approved && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-10 rounded-xl rounded-t-none"
          >
            <div className="bg-[#050505] border border-green-500/50 p-8 rounded-lg shadow-[0_0_50px_rgba(74,222,128,0.2)] text-center">
              <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-green-500/50">
                <Check className="w-8 h-8 text-green-400" />
              </div>
              <h2 className="text-2xl font-display text-white mb-2">Approved rebalance executed</h2>
              <p className="text-green-400 font-mono text-sm tracking-widest uppercase">(Simulated on Testnet)</p>
            </div>
          </motion.div>
        )}
      </div>

      <motion.div
        initial={{ x: '50vw', y: '100vh' }}
        animate={{
          x: ['50vw', '68vw', '68vw', '68vw'],
          y: ['100vh', '68vh', '68vh', '68vh'],
          scale: [1, 1, 0.8, 1]
        }}
        transition={{ duration: 10, times: [0, 0.35, 0.45, 1] }}
        className="absolute top-0 left-0 z-50 w-10 h-10 pointer-events-none drop-shadow-xl"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
          <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" fill="white" stroke="black" strokeWidth="1.5"/>
        </svg>
      </motion.div>
    </div>
  );
}
