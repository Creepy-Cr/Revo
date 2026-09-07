import { AnimatePresence, motion } from 'framer-motion';
import { useMemo } from 'react';

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
  useBeat,
  useBeats,
} from './shared';

const RED = '#FF2D2D';
const GREEN = '#3ddc84';

const BEATS = [4600, 9200];

const AUDIT_ROWS = [
  { action: 'rebalance.executed', who: 'arcus · autonomous', prev: '9f2c', hash: 'a71d' },
  { action: 'mode.changed → managed', who: 'operator 0x4b…e2', prev: 'a71d', hash: '5be0' },
  { action: 'pause.engaged', who: 'operator 0x4b…e2', prev: '5be0', hash: 'c04f' },
];

// Step 04. Operators stay in charge: operating mode, the emergency pause,
// and an append-only audit chain.
export function Scene5() {
  const beat = useBeats(BEATS) + 1;
  const autonomous = useBeat(2500);
  const halted = useBeat(6300);

  const copy = useMemo(
    () => [
      { a: 'You set how', b: 'far it goes.', body: 'Managed mode holds every proposal for an operator. Autonomous mode lets Revo act on its own, still inside the policy.' },
      { a: 'One pause', b: 'stops everything.', body: 'The halt is checked again at the moment of sending. Nothing slips through mid-flight.' },
      { a: 'Every action,', b: 'hash-chained.', body: 'The audit log is append-only. Each entry seals the one before it, so history cannot be quietly rewritten.' },
    ],
    [],
  );

  const current = copy[beat];

  return (
    <SceneRoot seconds={14}>
      <Backdrop glowX={1500} glowY={540} glowSize={1200} glow={beat === 1 ? 'rgba(255,45,45,0.08)' : 'rgba(252,59,0,0.08)'} />

      {/* Left column */}
      <div className="absolute" style={{ left: 160, top: 0, bottom: 0, width: 790, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <Kicker delay={0.3}>How it works &nbsp;·&nbsp; 04 Control</Kicker>
        <div style={{ height: 40 }} />
        <div style={{ height: 196 }}>
          <AnimatePresence mode="wait">
            <motion.h2
              key={beat}
              style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 88, lineHeight: 1, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}
              exit={{ opacity: 0, y: -24 }}
              transition={{ duration: 0.35 }}
            >
              <Words text={current.a} delay={beat === 0 ? 0.6 : 0.1} />
              <br />
              <Words text={current.b} delay={beat === 0 ? 0.9 : 0.4} style={{ color: 'rgba(255,255,255,0.45)' }} />
            </motion.h2>
          </AnimatePresence>
        </div>
        <div style={{ height: 30 }} />
        <div style={{ height: 150 }}>
          <AnimatePresence mode="wait">
            <motion.div key={beat} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <Body delay={beat === 0 ? 2.0 : 1.0} size={31} width={700}>
                {current.body}
              </Body>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Right: one focal control per beat */}
      <div className="absolute" style={{ left: 980, top: 0, bottom: 0, width: 780, display: 'flex', alignItems: 'center' }}>
        <AnimatePresence mode="wait">
          {beat <= 0 ? (
            <motion.div key="mode" style={{ width: 780 }} exit={{ opacity: 0, y: -30 }} transition={{ duration: 0.4 }}>
              <Panel delay={1.0} width={780} style={{ padding: '34px 40px 36px' }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 26 }}>
                  <Mono size={16}>Operating mode</Mono>
                  <Mono size={16} color={autonomous ? ORANGE : 'rgba(255,255,255,0.5)'}>{autonomous ? 'autonomous' : 'managed'}</Mono>
                </div>
                <div style={{ position: 'relative', display: 'flex', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 12, background: 'rgba(0,0,0,0.5)', overflow: 'hidden', height: 128 }}>
                  <motion.div
                    style={{ position: 'absolute', top: 0, bottom: 0, width: '50%', background: `${ORANGE}26`, borderBottom: `4px solid ${ORANGE}` }}
                    initial={false}
                    animate={{ left: autonomous ? '50%' : '0%' }}
                    transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                  />
                  {['Managed', 'Autonomous'].map((label, i) => {
                    const active = (i === 1) === autonomous;
                    return (
                      <div key={label} style={{ flex: 1, display: 'grid', placeItems: 'center', position: 'relative' }}>
                        <span style={{ fontFamily: FONT_MONO, fontSize: 26, letterSpacing: '0.2em', textTransform: 'uppercase', color: active ? '#fff' : 'rgba(255,255,255,0.35)', transition: 'color 0.4s' }}>{label}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 26, minHeight: 60 }}>
                  <AnimatePresence mode="wait">
                    <motion.div key={String(autonomous)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35 }} className="flex items-center" style={{ gap: 14 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: autonomous ? ORANGE : 'rgba(255,255,255,0.5)' }} />
                      <span style={{ fontFamily: FONT_MONO, fontSize: 20, color: 'rgba(255,255,255,0.75)' }}>
                        {autonomous ? 'Acts on its own. Every move still clamped by the active policy.' : 'Every proposal waits for an operator to approve it.'}
                      </span>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </Panel>
            </motion.div>
          ) : beat === 1 ? (
            <motion.div key="pause" style={{ width: 780 }} initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -30 }} transition={{ duration: 0.6, ...EXPO_OUT }}>
              <Panel from="none" width={780} style={{ padding: '34px 40px 36px', borderColor: halted ? `${RED}66` : undefined }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 26 }}>
                  <Mono size={16}>Emergency pause</Mono>
                  <Mono size={16} color={halted ? RED : 'rgba(255,255,255,0.5)'}>{halted ? 'halted' : 'armed'}</Mono>
                </div>
                <motion.div
                  style={{ height: 150, borderRadius: 12, display: 'grid', placeItems: 'center', border: `2px solid ${RED}`, background: halted ? RED : `${RED}14`, boxShadow: halted ? `0 0 80px ${RED}88` : `0 0 30px ${RED}22` }}
                  animate={{ scale: halted ? [1, 0.965, 1] : 1 }}
                  transition={{ duration: 0.35 }}
                >
                  <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 56, letterSpacing: '0.06em', color: '#fff' }}>{halted ? 'HALTED' : 'PAUSE'}</span>
                </motion.div>
                <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {['New proposals', 'Autonomous execution', 'Pending broadcasts'].map((row, i) => (
                    <motion.div key={row} className="flex items-center justify-between" style={{ padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 + i * 0.12 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 20, color: 'rgba(255,255,255,0.75)' }}>{row}</span>
                      <motion.span
                        key={String(halted)}
                        initial={{ opacity: 0, x: 8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: halted ? 0.15 + i * 0.12 : 0 }}
                        style={{ fontFamily: FONT_MONO, fontSize: 16, letterSpacing: '0.2em', textTransform: 'uppercase', color: halted ? RED : GREEN }}
                      >
                        {halted ? 'blocked' : 'allowed'}
                      </motion.span>
                    </motion.div>
                  ))}
                </div>
              </Panel>
            </motion.div>
          ) : (
            <motion.div key="audit" style={{ width: 780 }} initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, ...EXPO_OUT }}>
              <Panel from="none" width={780} style={{ padding: '34px 40px 30px' }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 18 }}>
                  <Mono size={16}>Audit log · append-only</Mono>
                  <Mono size={16} color="rgba(255,255,255,0.5)">hash-linked entries</Mono>
                </div>
                {AUDIT_ROWS.map((row, i) => (
                  <motion.div
                    key={row.hash}
                    style={{ padding: '18px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.5 + i * 0.55, ...EXPO_OUT }}
                  >
                    <div className="flex items-center justify-between">
                      <span style={{ fontFamily: FONT_MONO, fontSize: 21, color: '#fff' }}>{row.action}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 16, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.08em' }}>{row.who}</span>
                    </div>
                    <div className="flex items-center" style={{ gap: 14, marginTop: 10 }}>
                      <Mono size={14}>prev</Mono>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 17, color: 'rgba(255,255,255,0.5)' }}>{row.prev}…</span>
                      <motion.span
                        style={{ height: 1, background: ORANGE, display: 'inline-block', transformOrigin: 'left' }}
                        initial={{ width: 0 }}
                        animate={{ width: 120 }}
                        transition={{ duration: 0.5, delay: 0.9 + i * 0.55, ...EXPO_OUT }}
                      />
                      <Mono size={14} color={ORANGE}>hash</Mono>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 17, color: '#fff' }}>{row.hash}…</span>
                    </div>
                  </motion.div>
                ))}
              </Panel>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </SceneRoot>
  );
}
