import { VideoPausedContext, useSceneTimer } from '@/lib/video';
import { motion, type Transition } from 'framer-motion';
import { useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// Everything is laid out on a fixed 1920 x 1080 stage (see VideoTemplate),
// so sizes below are plain pixels and hold on every preview size.

export const EXPO_OUT: Transition = { ease: [0.16, 1, 0.3, 1] };
export const ORANGE = '#FC3B00';
export const ACCENT = '#FF6129';

export const FONT_DISPLAY = "'Clash Display', 'Switzer', sans-serif";
export const FONT_BODY = "'Switzer', 'Helvetica Neue', sans-serif";
export const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";

// A scene root: fills the stage, fades in and out, and carries a slow
// camera push so nothing ever sits perfectly still.
export function SceneRoot({
  children,
  seconds,
  push = 1.035,
  style,
  exit = { opacity: 0 },
  exitDuration = 0.55,
}: {
  children: ReactNode;
  seconds: number;
  push?: number;
  style?: CSSProperties;
  exit?: Record<string, number | string>;
  exitDuration?: number;
}) {
  return (
    <motion.div
      className="absolute inset-0 overflow-hidden"
      style={{ background: '#000', ...style }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={exit}
      transition={{ duration: exitDuration, ease: 'easeInOut' }}
    >
      <motion.div
        className="absolute inset-0"
        initial={{ scale: 1 }}
        animate={{ scale: push }}
        transition={{ duration: seconds, ease: 'linear' }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

// Word-by-word mask reveal for headlines.
export function Words({
  text,
  delay = 0,
  stagger = 0.075,
  duration = 0.95,
  className,
  style,
  out,
  outDelay,
}: {
  text: string;
  delay?: number;
  stagger?: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
  out?: boolean;
  outDelay?: number;
}) {
  const words = text.split(' ');
  return (
    <span className={className} style={style}>
      {words.map((word, i) => (
        <span
          key={`${word}-${i}`}
          className="inline-block overflow-hidden align-bottom"
          style={{ paddingBottom: '0.14em', marginBottom: '-0.14em', paddingRight: '0.06em', marginRight: '-0.06em' }}
        >
          <motion.span
            className="inline-block"
            initial={{ y: '112%', opacity: 0 }}
            animate={
              out
                ? { y: '-112%', opacity: 0 }
                : { y: '0%', opacity: 1 }
            }
            transition={
              out
                ? { duration: 0.55, delay: (outDelay ?? 0) + i * 0.03, ease: [0.7, 0, 0.84, 0] }
                : { duration, delay: delay + i * stagger, ...EXPO_OUT }
            }
          >
            {word}
          </motion.span>
          {i < words.length - 1 ? '\u00A0' : null}
        </span>
      ))}
    </span>
  );
}

// Small mono label with an orange square, used as a section kicker.
export function Kicker({
  children,
  delay = 0,
  color = ORANGE,
  size = 20,
}: {
  children: ReactNode;
  delay?: number;
  color?: string;
  size?: number;
}) {
  return (
    <motion.div
      className="flex items-center"
      style={{ gap: 18, fontFamily: FONT_MONO, fontSize: size, letterSpacing: '0.22em', textTransform: 'uppercase', color }}
      initial={{ opacity: 0, x: -18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.7, delay, ...EXPO_OUT }}
    >
      <span style={{ width: 10, height: 10, background: color, display: 'inline-block' }} />
      <span>{children}</span>
      <motion.span
        style={{ height: 1, background: `linear-gradient(to right, ${color}80, transparent)`, display: 'inline-block', transformOrigin: 'left' }}
        initial={{ width: 0 }}
        animate={{ width: 120 }}
        transition={{ duration: 0.9, delay: delay + 0.2, ...EXPO_OUT }}
      />
    </motion.div>
  );
}

// Body copy that fades up.
export function Body({
  children,
  delay = 0,
  size = 30,
  width = 720,
  color = 'rgba(255,255,255,0.62)',
  style,
}: {
  children: ReactNode;
  delay?: number;
  size?: number;
  width?: number;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <motion.p
      style={{ fontFamily: FONT_BODY, fontSize: size, lineHeight: 1.4, maxWidth: width, color, margin: 0, fontWeight: 400, ...style }}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay, ...EXPO_OUT }}
    >
      {children}
    </motion.p>
  );
}

// Frosted panel with a hairline top highlight.
export function Panel({
  children,
  delay = 0,
  width,
  style,
  className,
  from = 'bottom',
}: {
  children: ReactNode;
  delay?: number;
  width?: number;
  style?: CSSProperties;
  className?: string;
  from?: 'bottom' | 'right' | 'none';
}) {
  const initial = from === 'bottom' ? { opacity: 0, y: 40 } : from === 'right' ? { opacity: 0, x: 60 } : { opacity: 0 };
  return (
    <motion.div
      className={className}
      style={{
        width,
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: '0 30px 80px -20px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.14)',
        backdropFilter: 'blur(14px)',
        borderRadius: 14,
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
      initial={initial}
      animate={{ opacity: 1, y: 0, x: 0 }}
      transition={{ duration: 1, delay, ...EXPO_OUT }}
    >
      {children}
    </motion.div>
  );
}

export function Mono({
  children,
  size = 18,
  color = 'rgba(255,255,255,0.45)',
  tracking = '0.18em',
  style,
  className,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  tracking?: string;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span className={className} style={{ fontFamily: FONT_MONO, fontSize: size, letterSpacing: tracking, textTransform: 'uppercase', color, ...style }}>
      {children}
    </span>
  );
}

// Scene-relative elapsed time that freezes with the player. Mirrors the
// bookkeeping in useSceneTimer so every hook below pauses and resumes in
// step with the scene clock.
function usePausableClock(onTick: (elapsedMs: number) => boolean, deps: unknown[]) {
  const paused = useContext(VideoPausedContext);
  const elapsedRef = useRef(0);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    elapsedRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (paused) return;
    const startedAt = performance.now();
    let raf = 0;
    let done = false;
    const tick = () => {
      if (done) return;
      const elapsed = elapsedRef.current + (performance.now() - startedAt);
      done = onTickRef.current(elapsed);
      if (!done) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      elapsedRef.current += performance.now() - startedAt;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, ...deps]);
}

// Typewriter that follows the scene clock and freezes while paused.
export function useTypewriter(text: string, startMs: number, msPerChar = 32) {
  const [count, setCount] = useState(0);
  usePausableClock(
    (elapsed) => {
      const next = Math.max(0, Math.min(text.length, Math.floor((elapsed - startMs) / msPerChar)));
      setCount((prev) => (prev === next ? prev : next));
      return next >= text.length;
    },
    [text, startMs, msPerChar],
  );
  return { shown: text.slice(0, count), done: count >= text.length, started: count > 0 };
}

// Fires a state change at a fixed time into the scene.
export function useBeat(ms: number) {
  const [on, setOn] = useState(false);
  useSceneTimer([{ time: ms, callback: () => setOn(true) }]);
  return on;
}

// Returns the index of the latest beat reached (-1 before the first).
export function useBeats(times: number[]) {
  const [index, setIndex] = useState(-1);
  useSceneTimer(times.map((time, i) => ({ time, callback: () => setIndex(i) })));
  return index;
}

// Counts a number up on the scene clock; used for tickers and fills.
export function useCountUp(target: number, startMs: number, durationMs = 900, from = 0) {
  const [value, setValue] = useState(from);
  usePausableClock(
    (elapsed) => {
      const p = Math.max(0, Math.min(1, (elapsed - startMs) / durationMs));
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      return p >= 1;
    },
    [target, startMs, durationMs, from],
  );
  return value;
}

export function Cursor({ color = ORANGE, height = 34 }: { color?: string; height?: number }) {
  return (
    <motion.span
      style={{ display: 'inline-block', width: 14, height, background: color, verticalAlign: 'text-bottom', marginLeft: 6 }}
      animate={{ opacity: [1, 1, 0, 0] }}
      transition={{ duration: 0.9, repeat: Infinity, times: [0, 0.5, 0.5, 1] }}
    />
  );
}

// Grid + soft glow used behind most scenes.
export function Backdrop({
  glow = 'rgba(252,59,0,0.10)',
  glowX = 1400,
  glowY = 300,
  glowSize = 900,
  grid = true,
}: {
  glow?: string;
  glowX?: number;
  glowY?: number;
  glowSize?: number;
  grid?: boolean;
}) {
  return (
    <>
      {grid ? <div className="texture-overlay" /> : null}
      <div
        style={{
          position: 'absolute',
          left: glowX - glowSize / 2,
          top: glowY - glowSize / 2,
          width: glowSize,
          height: glowSize,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${glow} 0%, rgba(0,0,0,0) 65%)`,
          pointerEvents: 'none',
        }}
      />
    </>
  );
}

// The hero beam from the landing page, positioned and dimmed.
export function Beam({
  opacity = 0.6,
  x = 0,
  scale = 1.2,
  delay = 0,
  fade = 1.4,
}: {
  opacity?: number;
  x?: number;
  scale?: number;
  delay?: number;
  fade?: number;
}) {
  return (
    <motion.div
      className="absolute inset-0"
      style={{ mixBlendMode: 'screen' }}
      initial={{ opacity: 0 }}
      animate={{ opacity }}
      transition={{ duration: fade, delay, ease: 'easeOut' }}
    >
      <video
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: 'cover', transform: `translateX(${x}px) scale(${scale})` }}
        autoPlay
        muted
        loop
        playsInline
        data-duration-sec="8"
        poster={`${import.meta.env.BASE_URL}videos/hero-beam-poster.webp`}
      >
        <source src={`${import.meta.env.BASE_URL}videos/hero-beam.webm`} type="video/webm" />
        <source src={`${import.meta.env.BASE_URL}videos/hero-beam.mp4`} type="video/mp4" />
      </video>
    </motion.div>
  );
}

export function fmt(n: number, digits = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
