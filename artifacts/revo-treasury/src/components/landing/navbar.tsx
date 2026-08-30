import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X } from 'lucide-react';

import { Link } from 'wouter';
import { trackEvent } from '@/lib/analytics';

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    setMenuOpen(false);
    const el = document.getElementById(id);
    if (el) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  };

  return (
    <motion.nav
      initial={{ y: -100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className={`fixed top-0 left-0 right-0 z-50 flex justify-center py-6 px-4 transition-all duration-300 ${
        scrolled ? 'py-4' : 'py-6'
      }`}
    >
      <div className="w-full max-w-5xl relative">
      <div className="glass-pill flex items-center justify-between px-6 py-3 w-full">
        <button
          type="button"
          aria-label="Revo home"
          className="flex items-center gap-3 cursor-pointer group"
          onClick={() => scrollTo('hero')}
        >
          <img
            src={`${import.meta.env.BASE_URL}brand/revo-mark.png`}
            alt="Revo logo"
            className="w-8 h-8 object-contain drop-shadow-[0_0_12px_rgba(252,59,0,0.35)] transition-transform duration-500 group-hover:rotate-12 group-hover:scale-110"
          />
          <span className="font-display font-semibold text-lg tracking-tight text-white flex items-center gap-3">
            Revo 
          </span>
        </button>

        <div className="hidden md:flex items-center gap-9 font-display text-[15px] font-medium tracking-[0.04em] text-white/80 leading-relaxed">
          <button onClick={() => scrollTo('live-proof')} className="relative hover:text-white transition-colors duration-300 py-1 overflow-hidden group">
            Live Dashboard
            <span className="absolute bottom-0 left-0 w-full h-[1px] bg-primary scale-x-0 origin-left transition-transform duration-300 ease-out group-hover:scale-x-100" />
          </button>
          <button onClick={() => scrollTo('features')} className="relative hover:text-white transition-colors duration-300 py-1 overflow-hidden group">
            Features
            <span className="absolute bottom-0 left-0 w-full h-[1px] bg-primary scale-x-0 origin-left transition-transform duration-300 ease-out group-hover:scale-x-100" />
          </button>
          <button onClick={() => scrollTo('how-it-works')} className="relative hover:text-white transition-colors duration-300 py-1 overflow-hidden group">
            How It Works
            <span className="absolute bottom-0 left-0 w-full h-[1px] bg-primary scale-x-0 origin-left transition-transform duration-300 ease-out group-hover:scale-x-100" />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <Link
            href="/app"
            onClick={() => trackEvent('console_launch_clicked', { location: 'navbar' })}
            data-testid="nav-launch-console"
            className="group relative bg-white text-black text-[14px] font-sans font-semibold tracking-tight px-6 py-2.5 rounded-full transition-all duration-500 hover:shadow-[0_0_20px_rgba(252,59,0,0.6)] active:scale-95 leading-relaxed overflow-hidden border border-transparent hover:border-primary/50"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary via-accent to-primary opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <span className="relative z-10 group-hover:text-white transition-colors duration-500 flex items-center gap-2">
              Launch Console
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transform group-hover:translate-x-1 transition-transform duration-300">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </span>
          </Link>
          <button
            className="md:hidden w-9 h-9 flex items-center justify-center rounded-full border border-white/10 text-white/80 hover:text-white hover:bg-white/5 transition-colors"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="md:hidden absolute top-full left-0 right-0 mt-2 glass-pill !rounded-2xl px-4 py-3 flex flex-col"
          >
            <button onClick={() => scrollTo('live-proof')} className="text-left px-3 py-3 rounded-xl font-display text-[15px] font-medium tracking-[0.04em] text-white/85 hover:text-white hover:bg-white/5 transition-colors leading-relaxed">Live Dashboard</button>
            <button onClick={() => scrollTo('features')} className="text-left px-3 py-3 rounded-xl font-display text-[15px] font-medium tracking-[0.04em] text-white/85 hover:text-white hover:bg-white/5 transition-colors leading-relaxed">Features</button>
            <button onClick={() => scrollTo('how-it-works')} className="text-left px-3 py-3 rounded-xl font-display text-[15px] font-medium tracking-[0.04em] text-white/85 hover:text-white hover:bg-white/5 transition-colors leading-relaxed">How It Works</button>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </motion.nav>
  );
}
