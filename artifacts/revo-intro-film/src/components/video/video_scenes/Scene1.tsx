import { motion } from 'framer-motion';

import { Beam, Body, EXPO_OUT, FONT_DISPLAY, FONT_MONO, ORANGE, SceneRoot, Words } from './shared';

const CHIPS = ['Arc Testnet', 'USDC / EURC', 'Policy-bound execution'];

// The reveal. Beam on the right, the definition of Revo on the left.
export function Scene1() {
  return (
    <SceneRoot seconds={9} push={1.04}>
      <Beam opacity={0.8} x={420} scale={1.3} fade={1.6} />
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(90deg, #000 0%, #000 28%, rgba(0,0,0,0.72) 52%, rgba(0,0,0,0.05) 78%)' }}
      />
      <div className="texture-overlay" />

      <div className="absolute" style={{ left: 160, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <motion.div
          className="flex items-center"
          style={{ gap: 26, marginBottom: 54 }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.1, delay: 0.5, ...EXPO_OUT }}
        >
          <img
            src={`${import.meta.env.BASE_URL}brand/revo-mark.png`}
            alt=""
            style={{ height: 96, width: 'auto', filter: `drop-shadow(0 0 28px ${ORANGE}66)` }}
          />
          <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 64, letterSpacing: '0.16em', color: '#fff', paddingTop: 6 }}>REVO</span>
        </motion.div>

        <h1 style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 118, lineHeight: 0.98, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
          <Words text="Autonomous." delay={1.4} />
          <br />
          <Words text="Inside the lines." delay={1.75} style={{ color: 'rgba(255,255,255,0.45)' }} />
        </h1>

        <div style={{ height: 44 }} />

        <Body delay={3.0} size={33} width={840} color="rgba(255,255,255,0.72)">
          Revo is an AI-managed treasury for DAOs on Arc Testnet. It reads the market, proposes
          moves and settles them <span style={{ whiteSpace: 'nowrap' }}>on-chain</span>, bound by policy you write.
        </Body>

        <div className="flex" style={{ gap: 14, marginTop: 48 }}>
          {CHIPS.map((chip, i) => (
            <motion.span
              key={chip}
              style={{
                fontFamily: FONT_MONO,
                fontSize: 17,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: i === 0 ? '#fff' : 'rgba(255,255,255,0.6)',
                border: `1px solid ${i === 0 ? ORANGE + 'aa' : 'rgba(255,255,255,0.14)'}`,
                background: i === 0 ? ORANGE + '1f' : 'rgba(255,255,255,0.03)',
                padding: '12px 20px',
                borderRadius: 999,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 12,
              }}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 4.3 + i * 0.14, ...EXPO_OUT }}
            >
              {i === 0 ? <span style={{ width: 8, height: 8, borderRadius: 999, background: ORANGE, boxShadow: `0 0 12px ${ORANGE}` }} /> : null}
              {chip}
            </motion.span>
          ))}
        </div>
      </div>
    </SceneRoot>
  );
}
