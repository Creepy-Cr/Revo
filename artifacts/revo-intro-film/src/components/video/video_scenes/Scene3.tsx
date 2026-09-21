import { motion } from 'framer-motion';

import {
  Backdrop,
  Body,
  EXPO_OUT,
  FONT_DISPLAY,
  FONT_MONO,
  Kicker,
  Mono,
  ORANGE,
  Panel,
  SceneRoot,
  Words,
  fmt,
  useBeat,
  useCountUp,
} from './shared';

const SIGNALS = [
  { label: 'USDC peg', value: '1.0002', note: 'stable', bars: [5, 6, 5, 6, 6, 5, 6, 6] },
  { label: 'EURC / USDC', value: '1.0947', note: '+0.12% 24h', bars: [3, 4, 4, 5, 6, 6, 7, 8] },
  { label: 'Arc whale flow', value: '+2.4M', note: 'net inflow 24h', bars: [2, 3, 5, 4, 6, 7, 6, 8] },
  { label: 'Sentiment', value: '+0.31', note: 'X · Discord · news', bars: [4, 4, 5, 5, 6, 6, 6, 7] },
];

const CEILINGS = ['Slippage ≤ 50 bps', 'Price impact ≤ 5%', 'Pool share ≤ 10%', 'Ref. deviation ≤ 25%'];

// Step 02. Signals in, a deterministic draft out, and the policy clamps it.
export function Scene3() {
  const showClamp = useBeat(5600);
  const overshoot = useBeat(6300);
  const clamped = useBeat(8000);
  const ceilings = useBeat(9600);
  const proposed = useCountUp(37, 6300, 1200, 18);
  const width = clamped ? 30 : overshoot ? proposed : 18;

  return (
    <SceneRoot seconds={14}>
      <Backdrop glowX={300} glowY={900} glowSize={1000} glow="rgba(252,59,0,0.08)" />

      {/* Left column */}
      <div className="absolute" style={{ left: 160, top: 130, width: 760, height: 560, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <Kicker delay={0.3}>How it works &nbsp;·&nbsp; 02 Decide</Kicker>
        <div style={{ height: 40 }} />
        <h2 style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 100, lineHeight: 1, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
          <Words text="Models read." delay={0.6} />
          <br />
          <Words text="Engines decide." delay={0.95} style={{ color: 'rgba(255,255,255,0.45)' }} />
        </h2>
        <div style={{ height: 34 }} />
        <Body delay={2.2} size={31} width={700}>
          Arcus reads prices, the USDC peg, whale flow on Arc and market sentiment. A deterministic engine turns
          that into a draft. The model never touches the math.
        </Body>
      </div>

      {/* Signal board */}
      <Panel delay={1.0} from="right" width={760} style={{ position: 'absolute', left: 1000, top: 150, padding: '30px 38px 26px' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 18 }}>
          <Mono size={16}>Signals · live</Mono>
          <span className="flex items-center" style={{ gap: 10 }}>
            <motion.span style={{ width: 8, height: 8, borderRadius: 999, background: ORANGE }} animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />
            <Mono size={16} color="rgba(255,255,255,0.6)">Arc</Mono>
          </span>
        </div>
        {SIGNALS.map((row, i) => (
          <motion.div
            key={row.label}
            className="flex items-center justify-between"
            style={{ padding: '18px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 1.6 + i * 0.22, ...EXPO_OUT }}
          >
            <div style={{ width: 250 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 20, color: '#fff', letterSpacing: '0.04em' }}>{row.label}</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 14, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.16em', textTransform: 'uppercase', marginTop: 6 }}>{row.note}</div>
            </div>
            <div className="flex items-end" style={{ gap: 5, height: 34 }}>
              {row.bars.map((h, j) => (
                <motion.span
                  key={j}
                  style={{ width: 7, background: j === row.bars.length - 1 ? ORANGE : 'rgba(255,255,255,0.28)', transformOrigin: 'bottom' }}
                  initial={{ height: 0 }}
                  animate={{ height: h * 4 }}
                  transition={{ duration: 0.6, delay: 2.0 + i * 0.22 + j * 0.05, ...EXPO_OUT }}
                />
              ))}
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 40, color: '#fff', width: 170, textAlign: 'right', letterSpacing: '-0.01em' }}>{row.value}</div>
          </motion.div>
        ))}
      </Panel>

      {/* Clamp strip */}
      <motion.div
        className="absolute"
        style={{ left: 160, right: 160, top: 745 }}
        initial={{ opacity: 0, y: 30 }}
        animate={showClamp ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
        transition={{ duration: 0.9, ...EXPO_OUT }}
      >
        <div className="flex items-end justify-between" style={{ marginBottom: 16 }}>
          <div className="flex items-center" style={{ gap: 22 }}>
            <Mono size={17} color="#fff">Draft rebalance · EURC allocation</Mono>
            <motion.span
              style={{ fontFamily: FONT_MONO, fontSize: 15, letterSpacing: '0.2em', textTransform: 'uppercase', color: clamped ? '#fff' : ORANGE, border: `1px solid ${clamped ? '#fff' : ORANGE}`, padding: '6px 12px', borderRadius: 4 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: overshoot ? 1 : 0 }}
              transition={{ duration: 0.3 }}
            >
              {clamped ? 'Clamped to policy' : 'Draft exceeds policy'}
            </motion.span>
          </div>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 44, color: clamped ? '#fff' : ORANGE, letterSpacing: '-0.01em', lineHeight: 1 }}>
            {fmt(width, 1)}%
          </div>
        </div>

        <div style={{ position: 'relative', height: 26, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'visible' }}>
          <motion.div
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, background: clamped ? '#fff' : ORANGE, boxShadow: clamped ? 'none' : `0 0 30px ${ORANGE}88` }}
            animate={{ width: `${(width / 50) * 100}%` }}
            transition={clamped ? { type: 'spring', stiffness: 420, damping: 30 } : { duration: 0.05 }}
          />
          {/* Policy limit marker at 30% of a 50% scale */}
          <div style={{ position: 'absolute', left: '60%', top: -14, bottom: -14, width: 3, background: '#fff' }} />
          <div style={{ position: 'absolute', left: 'calc(60% + 14px)', top: -16 }}>
            <Mono size={15} color="#fff">policy max 30%</Mono>
          </div>
          <div style={{ position: 'absolute', left: 0, top: 36 }}>
            <Mono size={14}>0%</Mono>
          </div>
          <div style={{ position: 'absolute', right: 0, top: 36 }}>
            <Mono size={14}>50%</Mono>
          </div>
        </div>

        <div className="flex" style={{ gap: 14, marginTop: 64 }}>
          {CEILINGS.map((c, i) => (
            <motion.span
              key={c}
              style={{ fontFamily: FONT_MONO, fontSize: 17, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)', border: '1px solid rgba(255,255,255,0.14)', padding: '11px 18px', borderRadius: 999, background: 'rgba(255,255,255,0.03)' }}
              initial={{ opacity: 0, y: 12 }}
              animate={ceilings ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
              transition={{ duration: 0.7, delay: i * 0.12, ...EXPO_OUT }}
            >
              {c}
            </motion.span>
          ))}
          <motion.span
            style={{ marginLeft: 'auto' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: ceilings ? 1 : 0 }}
            transition={{ duration: 0.7, delay: 0.6 }}
          >
            <Mono size={16} color="rgba(255,255,255,0.45)">Hard ceilings. Not suggestions.</Mono>
          </motion.span>
        </div>
      </motion.div>
    </SceneRoot>
  );
}
