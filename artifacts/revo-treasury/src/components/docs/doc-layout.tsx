import { useEffect, type ReactNode } from 'react';
import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { Footer } from '@/components/landing/footer';

export interface DocSection {
  id: string;
  heading: string;
  body: ReactNode;
}

interface DocLayoutProps {
  code: string;
  title: string;
  tagline: string;
  version?: string;
  effective?: string;
  status?: string;
  sections: DocSection[];
}

const num = (i: number) => String(i + 1).padStart(2, '0');

export function DocLayout({
  code,
  title,
  tagline,
  version = 'V 1.0',
  effective = '2026-08-24',
  status = 'IN FORCE',
  sections,
}: DocLayoutProps) {
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
      // Allow the layout to paint before jumping to the anchor
      requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    } else {
      window.scrollTo(0, 0);
    }
  }, []);

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen bg-black text-white selection:bg-primary/30 selection:text-white">
      <div className="texture-luxe fixed inset-0 w-full h-full pointer-events-none z-[1]" aria-hidden="true" />

      <div className="relative z-10">
        {/* Top bar */}
        <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-black/80 backdrop-blur-md">
          <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 group" data-testid="doc-home-link">
              <img
                src={`${import.meta.env.BASE_URL}brand/revo-mark.png`}
                alt="Revo logo"
                className="w-5 h-5 object-contain"
              />
              <span className="font-display font-semibold tracking-tight group-hover:text-primary transition-colors">
                Revo
              </span>
            </Link>
            <span className="hidden sm:block text-[10px] font-mono tracking-[0.25em] text-white/35 uppercase tabular-nums">
              {code}
            </span>
            <Link
              href="/"
              className="text-[10px] font-mono tracking-[0.2em] uppercase text-white/50 hover:text-primary transition-colors"
            >
              ← Return
            </Link>
          </div>
        </header>

        <main id="main-content">
        {/* Masthead */}
        <div className="border-b border-white/[0.06]">
          <div className="max-w-6xl mx-auto px-4 pt-20 pb-0">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <p className="text-[10px] font-mono font-medium tracking-[0.3em] text-primary uppercase mb-6">
                Revo Core Technologies: Official Document
              </p>
              <h1 className="text-4xl md:text-6xl font-display font-medium tracking-tighter leading-[1.02] mb-4 max-w-3xl">
                {title}
              </h1>
              <p className="text-base md:text-lg text-white/55 font-light max-w-2xl leading-relaxed mb-12">
                {tagline}
              </p>
            </motion.div>

            {/* Meta strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 border-t border-white/[0.06]">
              {[
                ['Document', code],
                ['Version', version],
                ['Effective', effective],
                ['Status', status],
              ].map(([label, value], i) => (
                <div
                  key={label}
                  className={`py-4 pr-6 ${i > 0 ? 'md:border-l md:border-white/[0.06] md:pl-6' : ''}`}
                >
                  <p className="text-[9px] font-mono tracking-[0.25em] text-white/30 uppercase mb-1.5">{label}</p>
                  <p className="text-xs font-mono tracking-[0.1em] text-white/80 uppercase tabular-nums">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="max-w-6xl mx-auto px-4 py-16 lg:grid lg:grid-cols-[220px_1fr] lg:gap-16">
          {/* TOC */}
          <nav className="mb-12 lg:mb-0" aria-label="Table of contents">
            <div className="lg:sticky lg:top-24">
              <p className="text-[9px] font-mono tracking-[0.25em] text-white/30 uppercase mb-4">Contents</p>
              <ol className="space-y-2.5">
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <button
                      onClick={() => jumpTo(s.id)}
                      className="group flex items-baseline gap-3 text-left"
                    >
                      <span className="text-[10px] font-mono text-primary/60 tabular-nums group-hover:text-primary transition-colors">
                        {num(i)}
                      </span>
                      <span className="text-[13px] text-white/50 group-hover:text-white transition-colors leading-snug">
                        {s.heading}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </nav>

          {/* Sections */}
          <div>
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-24 py-10 first:pt-0 border-b border-white/[0.06] last:border-b-0">
                <div className="flex items-baseline gap-4 mb-6">
                  <span className="text-xs font-mono text-primary tabular-nums tracking-[0.1em]">{num(i)} //</span>
                  <h2 className="text-xl md:text-2xl font-display font-medium tracking-tight">{s.heading}</h2>
                </div>
                <div className="space-y-4 text-[15px] leading-relaxed text-white/65 font-light [&_strong]:text-white [&_strong]:font-medium">
                  {s.body}
                </div>
              </section>
            ))}

            {/* Issue block */}
            <div className="mt-16 pt-6 border-t border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-[10px] font-mono tracking-[0.2em] text-white/30 uppercase tabular-nums">
                Issued by Revo Core Technologies · Arc Testnet · Chain 5042002
              </p>
              <p className="text-[10px] font-mono tracking-[0.2em] text-white/30 uppercase tabular-nums">
                {code} · {effective}
              </p>
            </div>
          </div>
        </div>
        </main>

        <Footer />
      </div>
    </div>
  );
}

/* ---------- Shared content primitives ---------- */

export function DocList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="text-primary/70 select-none leading-relaxed">›</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function DocNote({ label = 'Note', children }: { label?: string; children: ReactNode }) {
  return (
    <div className="border border-white/[0.08] bg-white/[0.02] px-5 py-4">
      <p className="text-[9px] font-mono tracking-[0.25em] text-primary uppercase mb-2">{label}</p>
      <div className="text-sm leading-relaxed text-white/70">{children}</div>
    </div>
  );
}

export function DocTable({
  head,
  rows,
}: {
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto border border-white/[0.08]">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-white/[0.08] bg-white/[0.02]">
            {head.map((h) => (
              <th
                key={h}
                className="px-4 py-3 text-[9px] font-mono font-medium tracking-[0.25em] text-white/40 uppercase whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/[0.05] last:border-b-0">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-[13px] text-white/65 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocCode({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[12.5px] text-primary/90 bg-white/[0.04] px-1.5 py-0.5 whitespace-nowrap">
      {children}
    </code>
  );
}
