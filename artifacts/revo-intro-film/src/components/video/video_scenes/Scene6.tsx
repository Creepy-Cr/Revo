import { motion } from 'framer-motion';

import { Beam, EXPO_OUT, FONT_DISPLAY, FONT_MONO, ORANGE, SceneRoot, useBeat } from './shared';

// Close. The lockup, the address, a held ending that settles to black.
export function Scene6() {
  const fadeOut = useBeat(7200);

  return (
    <SceneRoot seconds={8} push={1.03} exit={{ opacity: 1 }} exitDuration={0}>
      <Beam opacity={0.5} x={0} scale={1.15} fade={1.8} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 20%, rgba(0,0,0,0.75) 70%, #000 100%)' }} />
      <div className="noise-overlay" />
      <div
        className="absolute"
        style={{ left: 460, top: 190, width: 1000, height: 700, background: 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.55) 40%, rgba(0,0,0,0) 70%)' }}
      />

      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ paddingBottom: 30 }}>
        <motion.img
          src={`${import.meta.env.BASE_URL}brand/revo-mark.png`}
          alt=""
          style={{ height: 176, width: 'auto', filter: `drop-shadow(0 0 40px ${ORANGE}80)` }}
          initial={{ opacity: 0, scale: 0.86, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1.4, delay: 0.5, ...EXPO_OUT }}
        />
        <motion.div
          style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 96, color: '#fff', marginTop: 34, lineHeight: 1 }}
          initial={{ opacity: 0, letterSpacing: '0.6em', x: '0.3em' }}
          animate={{ opacity: 1, letterSpacing: '0.2em', x: '0.1em' }}
          transition={{ duration: 1.6, delay: 1.2, ...EXPO_OUT }}
        >
          REVO
        </motion.div>
        <motion.div
          style={{ height: 1, background: `linear-gradient(90deg, transparent, ${ORANGE}, transparent)`, marginTop: 40 }}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 520, opacity: 1 }}
          transition={{ duration: 1.2, delay: 2.4, ...EXPO_OUT }}
        />
        <motion.div
          style={{ fontFamily: FONT_MONO, fontSize: 30, letterSpacing: '0.24em', color: '#fff', marginTop: 36 }}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 3.0, ...EXPO_OUT }}
        >
          therevo.xyz
        </motion.div>
        <motion.div
          style={{ fontFamily: FONT_MONO, fontSize: 17, letterSpacing: '0.26em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', marginTop: 22 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.9, delay: 3.7 }}
        >
          Built on Arc Testnet · AI-managed · Policy-bound
        </motion.div>
      </div>

      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{ background: '#000' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: fadeOut ? 1 : 0 }}
        transition={{ duration: 0.75, ease: 'easeIn' }}
      />
    </SceneRoot>
  );
}
