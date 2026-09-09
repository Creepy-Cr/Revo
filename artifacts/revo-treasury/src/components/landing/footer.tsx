import { Link } from 'wouter';
import { ArrowUpRight } from 'lucide-react';

export function Footer() {
  return (
    <footer className="relative pt-32 pb-12 overflow-hidden z-10 border-t border-white/[0.04] bg-black">
      {/* Subtle Inverted Glow (Embers from below) */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-5xl h-[400px] bg-gradient-to-t from-[#FC3B00]/15 via-[#FC3B00]/5 to-transparent blur-[80px] pointer-events-none" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[150px] bg-gradient-to-t from-[#FF7145]/20 to-transparent blur-[50px] pointer-events-none" />

      <div className="max-w-6xl mx-auto px-4 relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-5 gap-12 mb-20">
          
          {/* Brand Col */}
          <div className="lg:col-span-2 flex flex-col items-start">
            <div className="flex items-center gap-2 mb-6">
              <img
                src={`${import.meta.env.BASE_URL}brand/revo-mark.png`}
                alt="Revo logo"
                className="w-6 h-6 object-contain"
              />
              <span className="font-display font-semibold text-xl tracking-tight text-white">Revo</span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mb-8">
              A testnet treasury command center for autonomous DAOs. Deposits, withdrawals and approved rebalances settle on Arc Testnet under hard guardrails.
            </p>
            <div className="inline-flex items-center gap-2 text-[10px] font-mono text-white/40 tracking-[0.15em] uppercase tabular-nums border border-white/10 px-3 py-1.5 rounded-sm">
              <span className="w-1 h-1 bg-green-400" />
              Live on Arc Testnet
            </div>
          </div>

          {/* Links Cols */}
          <div className="flex flex-col gap-4">
            <h4 className="text-xs font-mono font-bold tracking-[0.15em] text-white uppercase mb-2">Platform</h4>
            <button onClick={() => document.getElementById('hero')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm text-muted-foreground hover:text-primary transition-colors text-left w-fit">Home</button>
            <button onClick={() => document.getElementById('live-proof')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm text-muted-foreground hover:text-primary transition-colors text-left w-fit">Live Terminal</button>
            <button onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm text-muted-foreground hover:text-primary transition-colors text-left w-fit">Features</button>
            <button onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })} className="text-sm text-muted-foreground hover:text-primary transition-colors text-left w-fit">Process</button>
          </div>

          <div className="flex flex-col gap-4">
            <h4 className="text-xs font-mono font-bold tracking-[0.15em] text-white uppercase mb-2">Resources</h4>
            <Link href="/app" className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 w-fit">
              Command Center <ArrowUpRight className="w-3 h-3 opacity-50" />
            </Link>
            <Link href="/docs" className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 w-fit">
              Documentation <ArrowUpRight className="w-3 h-3 opacity-50" />
            </Link>
            <Link href="/docs#api" className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 w-fit">
              API Reference <ArrowUpRight className="w-3 h-3 opacity-50" />
            </Link>
          </div>

          <div className="flex flex-col gap-4">
            <h4 className="text-xs font-mono font-bold tracking-[0.15em] text-white uppercase mb-2">Legal</h4>
            <Link href="/privacy" className="text-sm text-muted-foreground hover:text-primary transition-colors w-fit">Privacy Policy</Link>
            <Link href="/terms" className="text-sm text-muted-foreground hover:text-primary transition-colors w-fit">Terms of Service</Link>
            <Link href="/risk" className="text-sm text-muted-foreground hover:text-primary transition-colors w-fit">Risk Disclaimer</Link>
          </div>

        </div>

        <div className="pt-8 border-t border-white/[0.05] flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-[11px] font-mono text-muted-foreground tracking-[0.1em] uppercase tabular-nums">
            © {new Date().getFullYear()} Revo Core Technologies. All rights reserved.
          </p>
          <p className="text-[11px] font-mono text-white/30 tracking-[0.1em] uppercase tabular-nums">
            Built on Arc Testnet
          </p>
        </div>
      </div>
    </footer>
  );
}
