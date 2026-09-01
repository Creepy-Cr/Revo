import { motion } from 'framer-motion';
import { ShieldOff, UserCheck, Zap, ShieldAlert, FileDown } from 'lucide-react';

export function Scene4() {
  return (
    <div className="absolute inset-0 bg-[#000000] text-white flex flex-col font-sans overflow-hidden">
      <div className="flex items-center justify-between px-10 py-5 border-b border-white/10 bg-[#050505]">
        <div className="flex items-center gap-4">
          <img src={`${import.meta.env.BASE_URL}brand/revo-mark.png`} className="w-8 h-8" alt="Revo" />
          <span className="font-display font-medium tracking-tight text-xl">Revo Treasury</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-3 py-1 bg-white/5 border border-white/10 rounded font-mono text-xs uppercase tracking-widest text-white/60">
            0x4B2...9A1F
          </div>
        </div>
      </div>

      <div className="flex-1 p-8 grid grid-cols-12 gap-8 relative">
        <div className="col-span-8 flex flex-col gap-8">
          <div className="flex w-full bg-[#050505] border border-white/10 rounded-lg overflow-hidden shadow-2xl h-48">
            <div className="flex-1 p-6 border-r border-white/10 flex flex-col justify-between">
              <div className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase">01 // NET ASSET VALUE</div>
              <div className="text-5xl font-display text-white tabular-nums">$2,450,000</div>
              <div className="text-xs font-mono text-green-400 tracking-widest">+2.4% 24H CHANGE</div>
            </div>
            <div className="flex-1 p-6 border-r border-white/10 flex flex-col justify-between">
              <div className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase">02 // CAPITAL DEPLOYED</div>
              <div className="text-5xl font-display text-white tabular-nums">85%</div>
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden flex">
                <div className="h-full bg-primary w-[85%]" />
              </div>
            </div>
            <div className="flex-1 p-6 flex flex-col justify-between">
              <div className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase">03 // RISK SCORE</div>
              <div className="text-5xl font-display text-yellow-400 tabular-nums">42</div>
              <div className="text-xs font-mono text-yellow-400 tracking-widest">ELEVATED</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 flex-1">
            <div className="bg-[#050505] border border-white/10 rounded-lg p-6 flex flex-col shadow-2xl">
              <h3 className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase mb-6">SYS // OPERATING MODE</h3>
              <div className="flex divide-x divide-white/10 border border-white/10 rounded-md overflow-hidden bg-black/50">
                <div className="flex-1 py-4 flex flex-col items-center gap-2 text-white/40">
                  <ShieldOff className="w-5 h-5" /> <span className="text-xs font-mono uppercase">Safe</span>
                </div>
                <div className="flex-1 py-4 flex flex-col items-center gap-2 bg-white/5 border-b-2 border-green-400 text-white">
                  <UserCheck className="w-5 h-5 text-green-400" /> <span className="text-xs font-mono uppercase">Managed</span>
                </div>
                <div className="flex-1 py-4 flex flex-col items-center gap-2 text-white/40">
                  <Zap className="w-5 h-5" /> <span className="text-xs font-mono uppercase">Auto</span>
                </div>
              </div>
              <div className="mt-auto text-sm text-white/50 leading-relaxed">
                Arcus compiles strategies and proposes rebalances. Human approval is strictly required.
              </div>
            </div>

            <div className="bg-[#050505] border border-white/10 rounded-lg p-6 flex flex-col shadow-2xl">
              <h3 className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase mb-6 flex justify-between">
                SYS // LIVE STATE
              </h3>
              <div className="space-y-4">
                <div className="flex gap-3 text-sm">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-green-400" />
                  <div className="text-white/80">Policy <strong>Risk Capped Rebalance</strong> is active and within bounds.</div>
                </div>
                <div className="flex gap-3 text-sm">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-green-400" />
                  <div className="text-white/80">Drawdown limits respected across all pools.</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-span-4 bg-[#050505] border border-white/10 rounded-lg p-6 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase">02 // SECURITY CONTROLS</h3>
            <div className="flex gap-3">
              <button className="text-white/50 border border-white/10 p-2 rounded bg-black">
                <FileDown className="w-4 h-4" />
              </button>
              <button className="text-red-400 bg-red-400/10 border border-red-400/20 p-2 rounded">
                <ShieldAlert className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="space-y-4 mb-8">
             <div className="flex justify-between text-sm py-2 border-b border-white/5">
                <span className="font-mono text-white/50">PER-WITHDRAWAL</span>
                <span className="font-mono text-white">50,000 <span className="text-white/30 text-xs">USDC</span></span>
             </div>
             <div className="flex justify-between text-sm py-2 border-b border-white/5">
                <span className="font-mono text-white/50">WALLET 24H</span>
                <span className="font-mono text-white">250,000 <span className="text-white/30 text-xs">USDC</span></span>
             </div>
             <div className="flex justify-between text-sm py-2 border-b border-white/5">
                <span className="font-mono text-white/50">GLOBAL 24H</span>
                <span className="font-mono text-white">1,000,000 <span className="text-white/30 text-xs">USDC</span></span>
             </div>
          </div>

          <div className="mt-auto border-t border-white/10 pt-6">
            <div className="text-xs font-mono tracking-[0.1em] text-white/40 uppercase mb-4 text-center">
              NO ACTIVE ALERTS
            </div>
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1, duration: 1 }}
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-6"
      >
        <div className="px-6 py-3 bg-black/80 backdrop-blur-xl border border-white/10 rounded-full font-mono text-sm tracking-widest uppercase text-white shadow-2xl">
          Human approval required
        </div>
        <div className="px-6 py-3 bg-primary/10 backdrop-blur-xl border border-primary/30 rounded-full font-mono text-sm tracking-widest uppercase text-primary shadow-[0_0_20px_rgba(252,59,0,0.2)] flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          Arc Testnet
        </div>
      </motion.div>
    </div>
  );
}
