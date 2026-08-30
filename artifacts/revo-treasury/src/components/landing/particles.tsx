import { useEffect, useState, memo } from 'react';

export const Particles = memo(function Particles() {
  const [particles, setParticles] = useState<Array<{ id: number; left: string; size: number; duration: number; delay: number; xDrift: string }>>([]);

  useEffect(() => {
    // Check for reduced motion
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;

    const newParticles = Array.from({ length: 45 }).map((_, i) => ({
      id: i,
      left: `${50 + (Math.random() * 20 - 10)}%`, // clustered around center
      size: Math.random() * 2.5 + 0.5,
      duration: Math.random() * 12 + 8,
      delay: Math.random() * -20,
      xDrift: `${Math.random() * 80 - 40}px`
    }));
    setParticles(newParticles);
  }, []);

  return (
    <div className="absolute inset-0 w-full h-full pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {particles.map(p => (
        <div
          key={p.id}
          className="ember-particle"
          style={{
            left: p.left,
            top: 0,
            width: p.size,
            height: p.size,
            '--duration': `${p.duration}s`,
            '--delay': `${p.delay}s`,
            '--x-drift': p.xDrift,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
});
