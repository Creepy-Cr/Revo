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
  useTypewriter,
} from './shared';

const TX_HASH = '0x7f3a9c04e1b2d8f6a5c3e9b7d1f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4c21e';
const GREEN = '#3ddc84';

// Step 03. A rebalance leaves as a real swap on Arc and comes back
// as a receipt.
export function Scene4() {
  const quoted = useBeat(1800);
  const broadcast = useBeat(3600);
  const confirmed = useBeat(6500);
  const footer = useBeat(9800);
  const hash = useTypewriter(TX_HASH, 3700, 9);
  const fill = useCountUp(22831.24, 6500, 1100, 0);

  const steps = [
    { label: 'Quoted', on: quoted, detail: '0.91346 EURC per USDC · Uniswap v4 pool' },
    { label: 'Broadcast', on: broadcast, detail: hash.shown ? hash.shown.slice(0, 22) + (hash.done ? '…' + TX_HASH.slice(-6) : '') : '' },
    { label: 'Confirmed', on: confirmed, detail: 'block 18,204,553 · transfer logs read' },
  ];

  return (
    <SceneRoot seconds={14}>
      <Backdrop glowX={1500} glowY={850} glowSize={1100} glow="rgba(61,220,132,0.06)" />
      <Backdrop grid={false} glowX={300} glowY={200} glowSize={900} glow="rgba(252,59,0,0.07)" />

      {/* Left column */}
      <div className="absolute" style={{ left: 160, top: 0, bottom: 0, width: 720, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <Kicker delay={0.3}>How it works &nbsp;·&nbsp; 03 Settle</Kicker>
        <div style={{ height: 40 }} />
        <h2 style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 104, lineHeight: 0.98, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
          <Words text="Real swaps." delay={0.6} />
          <br />
          <Words text="Real receipts." delay={0.9} style={{ color: 'rgba(255,255,255,0.45)' }} />
        </h2>
        <div style={{ height: 36 }} />
        <Body delay={2.1} size={31} width={700}>
          Executed on Arc through Uniswap v4. The filled amount is read from the confirmed transfer logs,
          never from an estimate.
        </Body>
        <motion.div
          className="flex items-center"
          style={{ gap: 16, marginTop: 44 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: footer ? 1 : 0 }}
          transition={{ duration: 0.8 }}
        >
          <span style={{ width: 44, height: 1, background: 'rgba(255,255,255,0.3)' }} />
          <Mono size={16} color="rgba(255,255,255,0.55)">Receipts re-read from the chain every 30 seconds</Mono>
        </motion.div>
      </div>

      {/* Swap ticket */}
      <Panel delay={1.0} from="right" width={800} style={{ position: 'absolute', left: 960, top: 150, padding: '32px 40px 34px' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 26 }}>
          <Mono size={16}>Rebalance · USDC → EURC</Mono>
          <Mono size={16} color="rgba(255,255,255,0.7)">venue · Uniswap v4 · Arc</Mono>
        </div>

        <div className="flex items-center" style={{ gap: 20 }}>
          <div style={{ flex: 1, background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '22px 26px' }}>
            <Mono size={14}>Sell</Mono>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 46, color: '#fff', marginTop: 10, letterSpacing: '-0.01em' }}>25,000.00</div>
            <Mono size={15} color="rgba(255,255,255,0.7)">USDC</Mono>
          </div>
          <motion.div
            style={{ width: 54, height: 54, borderRadius: 999, border: '1px solid rgba(255,255,255,0.2)', display: 'grid', placeItems: 'center', fontFamily: FONT_MONO, fontSize: 24, color: '#fff' }}
            animate={broadcast && !confirmed ? { rotate: 360 } : { rotate: 0 }}
            transition={broadcast && !confirmed ? { duration: 1.4, repeat: Infinity, ease: 'linear' } : { duration: 0.4 }}
          >
            →
          </motion.div>
          <div style={{ flex: 1, background: 'rgba(0,0,0,0.45)', border: `1px solid ${confirmed ? GREEN + '66' : 'rgba(255,255,255,0.08)'}`, borderRadius: 10, padding: '22px 26px', transition: 'border-color 0.4s' }}>
            <Mono size={14}>{confirmed ? 'Filled' : 'Buy · quoted'}</Mono>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 46, color: '#fff', marginTop: 10, letterSpacing: '-0.01em' }}>
              {confirmed ? fmt(fill) : quoted ? '22,836.50' : '0.00'}
            </div>
            <Mono size={15} color="rgba(255,255,255,0.7)">EURC</Mono>
          </div>
        </div>

        {/* Timeline */}
        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 0 }}>
          {steps.map((step, i) => (
            <motion.div
              key={step.label}
              className="flex items-center"
              style={{ gap: 20, padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}
              initial={{ opacity: 0.25 }}
              animate={{ opacity: step.on ? 1 : 0.25 }}
              transition={{ duration: 0.4 }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: step.on ? (i === 2 ? GREEN : ORANGE) : 'transparent',
                  border: `2px solid ${step.on ? (i === 2 ? GREEN : ORANGE) : 'rgba(255,255,255,0.3)'}`,
                  boxShadow: step.on ? `0 0 14px ${i === 2 ? GREEN : ORANGE}` : 'none',
                }}
              />
              <Mono size={16} color="#fff" style={{ width: 150 }}>{step.label}</Mono>
              <span style={{ fontFamily: FONT_MONO, fontSize: 18, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>{step.detail}</span>
            </motion.div>
          ))}
        </div>

        {/* Receipt readout */}
        <motion.div
          className="flex items-center justify-between"
          style={{ marginTop: 22, padding: '16px 20px', borderRadius: 8, background: `${GREEN}14`, border: `1px solid ${GREEN}55` }}
          initial={{ opacity: 0, y: 12 }}
          animate={confirmed ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
          transition={{ duration: 0.7, delay: 0.3, ...EXPO_OUT }}
        >
          <span className="flex items-center" style={{ gap: 12 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <Mono size={16} color={GREEN}>Receipt verified</Mono>
          </span>
          <Mono size={16} color="rgba(255,255,255,0.8)">slippage 2.3 bps · gas 0.0412 USDC</Mono>
        </motion.div>
      </Panel>
    </SceneRoot>
  );
}
