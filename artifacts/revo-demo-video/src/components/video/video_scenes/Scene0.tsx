import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene0() {
  const [step, setStep] = useState(1);

  useEffect(() => {
    const t1 = setTimeout(() => setStep(2), 3000);
    const t2 = setTimeout(() => setStep(3), 6000);
    const t3 = setTimeout(() => setStep(4), 8500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  const ctaLabel = step === 1 ? 'CONNECT WALLET' : step === 2 ? 'SWITCH TO ARC' : step === 3 ? 'SIGN IN & ENTER CONSOLE' : 'AUTHENTICATING...';

  return (
    <div className="absolute inset-0 bg-[#000000] text-white flex flex-col font-sans overflow-hidden">
      <div className="flex items-center justify-between px-10 py-6 border-b border-white/5">
        <span className="font-display font-medium tracking-tight text-2xl">Revo Treasury</span>
        <span className="flex items-center gap-2 text-sm font-mono font-bold tracking-[0.15em] text-emerald-400 uppercase">
          <span className="w-2 h-2 bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
          ARC MAINNET
        </span>
      </div>

      <div className="flex-1 grid place-items-center relative">
        <div className="absolute top-[30%] left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-primary/5 blur-[140px] rounded-full pointer-events-none" />

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8 }}
          className="relative w-full max-w-3xl"
        >
          <p className="text-sm font-mono tracking-[0.1em] text-muted-foreground uppercase mb-6">
            <span className="text-white/40">00 //</span> OPERATOR ACCESS
          </p>
          <h1 className="font-display font-medium tracking-tight text-6xl leading-[1.05] mb-6">
            This console is<br />operator-gated.
          </h1>
          <p className="text-xl text-white/50 leading-relaxed mb-12 max-w-xl">
            Every treasury on Revo is private to the wallet that runs it. Sign in to open yours; a first-time wallet gets its own treasury provisioned on the spot.
          </p>

          <div className="border-t border-white/10">
            <StepRow no="01" label="Connect a wallet" meta="EIP-6963 · any injected wallet" state={step > 1 ? 'done' : step === 1 ? 'active' : 'idle'} />
            <StepRow no="02" label="Arc network" meta="chain 5042" state={step > 2 ? 'done' : step === 2 ? 'active' : 'idle'} />
            <StepRow no="03" label="Verify ownership" meta="one signature · zero gas" state={step > 3 ? 'done' : step === 3 ? 'active' : 'idle'} />
          </div>

          <motion.div
            className={`mt-10 w-full flex items-center justify-center gap-3 h-16 text-lg font-mono font-bold tracking-[0.18em] uppercase transition-colors ${step > 3 ? 'bg-green-500/20 text-green-400 border border-green-500/50' : 'bg-primary text-white'}`}
          >
            {ctaLabel}
          </motion.div>

          <p className="mt-6 text-xs font-mono tracking-[0.08em] text-white/30 uppercase leading-relaxed text-center">
            Signature proves wallet ownership only: no gas, no transaction, no custody of your keys.
          </p>
        </motion.div>
      </div>

      {/* Cursor */}
      <motion.div
        initial={{ x: '50vw', y: '100vh' }}
        animate={{
          x: ['50vw', '50vw', '50vw', '50vw', '50vw', '50vw', '50vw', '50vw', '50vw'],
          y: ['100vh', '70vh', '70vh', '70vh', '70vh', '70vh', '70vh', '70vh', '70vh'],
          scale: [1, 1, 0.8, 1, 0.8, 1, 0.8, 1, 1]
        }}
        transition={{ duration: 9, times: [0, 0.15, 0.3, 0.35, 0.6, 0.65, 0.9, 0.95, 1] }}
        className="absolute top-0 left-0 z-50 w-10 h-10 pointer-events-none drop-shadow-xl"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
          <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" fill="white" stroke="black" strokeWidth="1.5"/>
        </svg>
      </motion.div>
    </div>
  );
}

function StepRow({ no, label, meta, state }: { no: string, label: string, meta: string, state: string }) {
  return (
    <div className="flex items-baseline gap-6 py-5 border-b border-white/5">
      <span
        className={`text-base font-mono font-bold tracking-[0.1em] tabular-nums transition-colors ${state === 'done' ? 'text-green-400' : state === 'active' ? 'text-primary' : 'text-white/25'}`}
      >
        {state === 'done' ? '■' : '□'} {no}
      </span>
      <span
        className={`text-2xl font-medium tracking-tight transition-colors ${state === 'idle' ? 'text-white/40' : 'text-white'}`}
      >
        {label}
      </span>
      <span className="ml-auto text-sm font-mono tracking-[0.08em] text-white/40 uppercase tabular-nums text-right">
        {meta}
      </span>
    </div>
  );
}
