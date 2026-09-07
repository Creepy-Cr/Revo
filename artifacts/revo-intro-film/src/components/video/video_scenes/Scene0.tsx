import { motion } from 'framer-motion';

import { EXPO_OUT, FONT_DISPLAY, FONT_MONO, ORANGE, SceneRoot, Words, useBeat } from './shared';

// Cold open. Two statements set up the gap Revo closes, then the policy
// line takes over the frame and flashes into the reveal.
export function Scene0() {
  const firstOut = useBeat(3050);
  const second = useBeat(3700);
  const collapse = useBeat(6300);
  const flash = useBeat(7150);

  return (
    <SceneRoot seconds={8} push={1.02} exit={{ opacity: 0 }} exitDuration={0.4}>
      <div className="absolute" style={{ left: 160, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {/* The policy line, drawn first and later widened across the frame */}
        <motion.div
          style={{ height: 3, background: ORANGE, transformOrigin: 'left', boxShadow: `0 0 24px ${ORANGE}66` }}
          initial={{ width: 0 }}
          animate={collapse ? { width: 1760, height: 4, boxShadow: `0 0 60px ${ORANGE}` } : { width: 220 }}
          transition={collapse ? { duration: 0.9, ...EXPO_OUT } : { duration: 1.1, delay: 0.25, ...EXPO_OUT }}
        />

        <div style={{ height: 56 }} />

        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 132, lineHeight: 0.98, letterSpacing: '-0.025em', color: '#fff', height: 300 }}>
          {!second ? (
            <div>
              <Words text="Markets move" delay={0.9} out={firstOut} />
              <br />
              <Words text="in seconds." delay={1.35} style={{ color: 'rgba(255,255,255,0.42)' }} out={firstOut} outDelay={0.05} />
            </div>
          ) : (
            <div>
              <Words text="Treasuries move" delay={0.1} out={collapse} />
              <br />
              <Words text="in weeks." delay={0.5} style={{ color: ORANGE }} out={collapse} outDelay={0.05} />
            </div>
          )}
        </div>

        <motion.div
          style={{ fontFamily: FONT_MONO, fontSize: 20, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.38)', marginTop: 28 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: second && !collapse ? 1 : 0 }}
          transition={{ duration: 0.6, delay: second && !collapse ? 0.9 : 0 }}
        >
          Forum threads. Multisig queues. Time zones.
        </motion.div>
      </div>

      {/* Orange flash that hands over to the reveal */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at 50% 50%, ${ORANGE} 0%, #ff8a4c 30%, #000 75%)` }}
        initial={{ opacity: 0 }}
        animate={{ opacity: flash ? [0, 1, 0.92, 0] : 0 }}
        transition={{ duration: 0.85, times: [0, 0.18, 0.4, 1], ease: 'easeOut' }}
      />
    </SceneRoot>
  );
}
