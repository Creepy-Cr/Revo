import { motion } from 'framer-motion';

import {
  Backdrop,
  Body,
  Cursor,
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
  useTypewriter,
} from './shared';

const INSTRUCTION = 'Keep 30% in EURC. Never let drawdown pass 5%. Hold 25% liquid for withdrawals.';

const POLICY_ROWS = [
  { key: 'allocation.EURC.max', value: '30%' },
  { key: 'drawdown.limit', value: '5%' },
  { key: 'liquidity.reserve', value: '25%' },
];

// Step 01. A plain-English instruction is typed, Arcus compiles it, and the
// result is a policy the server enforces.
export function Scene2() {
  const { shown, done } = useTypewriter(INSTRUCTION, 1900, 30);
  const compiling = useBeat(5100);
  const compiled = useBeat(6300);
  const enforced = useBeat(7500);
  const swapOut = useBeat(8300);
  const swapIn = useBeat(8850);

  return (
    <SceneRoot seconds={13}>
      <Backdrop glowX={1500} glowY={200} glowSize={1100} glow="rgba(252,59,0,0.09)" />

      {/* Left column */}
      <div className="absolute" style={{ left: 160, top: 0, bottom: 0, width: 790, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <Kicker delay={0.3}>How it works &nbsp;·&nbsp; 01 Instruct</Kicker>
        <div style={{ height: 40 }} />
        <h2 style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 88, lineHeight: 1, letterSpacing: '-0.025em', color: '#fff', margin: 0, height: 196 }}>
          {!swapIn ? (
            <>
              <Words text="Write the rule" delay={0.6} out={swapOut} />
              <br />
              <Words text="in plain English." delay={0.9} style={{ color: 'rgba(255,255,255,0.45)' }} out={swapOut} outDelay={0.05} />
            </>
          ) : (
            <>
              <Words text="Arcus compiles it." delay={0.05} />
              <br />
              <Words text="Code enforces it." delay={0.35} style={{ color: 'rgba(255,255,255,0.45)' }} />
            </>
          )}
        </h2>
        <div style={{ height: 36 }} />
        <div style={{ height: 140 }}>
          {!swapIn ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: swapOut ? 0 : 1 }} transition={{ duration: 0.5, delay: swapOut ? 0 : 1.6 }}>
              <Body size={31} width={680}>
                No config files. No governance vote for every adjustment. You tell Arcus what the treasury must hold to.
              </Body>
            </motion.div>
          ) : (
            <Body delay={0.7} size={31} width={680}>
              Not a prompt in a chat window. A policy the code checks before every single move.
            </Body>
          )}
        </div>
      </div>

      {/* Right column: instruction panel and compiled policy */}
      <div className="absolute" style={{ left: 980, top: 0, bottom: 0, width: 780, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 22 }}>
        <Panel delay={1.2} width={780} style={{ padding: '34px 40px 38px' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 26 }}>
            <Mono size={16}>Instruction</Mono>
            <Mono size={16} color={ORANGE}>operator · you</Mono>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 33, lineHeight: 1.5, color: '#fff', minHeight: 150 }}>
            <span style={{ color: ORANGE, marginRight: 18 }}>&gt;</span>
            {shown}
            {!done ? <Cursor /> : null}
          </div>

          {/* Compile status */}
          <motion.div
            className="flex items-center"
            style={{ gap: 18, marginTop: 24, height: 28 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: compiling ? 1 : 0 }}
            transition={{ duration: 0.4 }}
          >
            <Mono size={15} color="rgba(255,255,255,0.7)">Arcus · policy compiler</Mono>
            <div style={{ flex: 1, height: 2, background: 'rgba(255,255,255,0.1)', position: 'relative', overflow: 'hidden' }}>
              <motion.div
                style={{ position: 'absolute', inset: 0, background: ORANGE, transformOrigin: 'left' }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: compiling ? 1 : 0 }}
                transition={{ duration: 1.05, ease: [0.4, 0, 0.2, 1] }}
              />
            </div>
            <Mono size={15} color={compiled ? '#fff' : 'rgba(255,255,255,0.4)'}>{compiled ? 'compiled' : 'compiling'}</Mono>
          </motion.div>
        </Panel>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={compiled ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.9, ...EXPO_OUT }}
        >
          <Panel from="none" width={780} style={{ padding: '30px 40px 34px', borderColor: `${ORANGE}55` }}>
            <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${ORANGE}, transparent)` }} />
            <div className="flex items-center justify-between" style={{ marginBottom: 22 }}>
              <Mono size={16}>Compiled policy</Mono>
              <Mono size={16} color="rgba(255,255,255,0.35)">from your words · nothing else</Mono>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {POLICY_ROWS.map((row, i) => (
                <motion.div
                  key={row.key}
                  className="flex items-baseline justify-between"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 12 }}
                  initial={{ opacity: 0, x: 26 }}
                  animate={compiled ? { opacity: 1, x: 0 } : { opacity: 0, x: 26 }}
                  transition={{ duration: 0.7, delay: 0.25 + i * 0.18, ...EXPO_OUT }}
                >
                  <span style={{ fontFamily: FONT_MONO, fontSize: 26, color: 'rgba(255,255,255,0.78)' }}>{row.key}</span>
                  <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 500, fontSize: 44, color: '#fff', letterSpacing: '-0.01em' }}>{row.value}</span>
                </motion.div>
              ))}
            </div>
            <motion.div
              className="flex items-center"
              style={{ gap: 14, marginTop: 20 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: enforced ? 1 : 0 }}
              transition={{ duration: 0.5 }}
            >
              <motion.span
                style={{ width: 10, height: 10, borderRadius: 999, background: '#3ddc84', boxShadow: '0 0 14px #3ddc84' }}
                animate={{ opacity: [1, 0.35, 1] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
              <Mono size={18} color="#fff">Enforced server-side on every proposal</Mono>
            </motion.div>
          </Panel>
        </motion.div>
      </div>
    </SceneRoot>
  );
}
