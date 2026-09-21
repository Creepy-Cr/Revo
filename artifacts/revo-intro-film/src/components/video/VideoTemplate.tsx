import {
  VideoCanvas,
  VideoPausedContext,
  type VideoAspectRatio,
  useVideoPlayer,
} from '@/lib/video';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

import { Scene0 } from './video_scenes/Scene0';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';
import { Scene6 } from './video_scenes/Scene6';
import { FONT_MONO, ORANGE } from './video_scenes/shared';

export const SCENE_DURATIONS = {
  cold_open: 8000,
  reveal: 9000,
  instruct: 13000,
  decide: 14000,
  settle: 14000,
  control: 14000,
  close: 8000,
};

type SceneKey = keyof typeof SCENE_DURATIONS;

const VIDEO_ASPECT_RATIO: VideoAspectRatio = '16:9';

// Every scene is composed on this fixed stage and scaled to the canvas, so
// the preview, the export and the rendered MP4 are the same picture.
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

const SCENE_COMPONENTS: Record<SceneKey, ComponentType> = {
  cold_open: Scene0,
  reveal: Scene1,
  instruct: Scene2,
  decide: Scene3,
  settle: Scene4,
  control: Scene5,
  close: Scene6,
};

// Scenes that belong to the numbered "how it works" run, for the rail.
const STEP_LABEL: Partial<Record<SceneKey, string>> = {
  instruct: '01 / 04',
  decide: '02 / 04',
  settle: '03 / 04',
  control: '04 / 04',
};

const SCENE_START_SEC: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let cumulativeMs = 0;
  for (const [key, ms] of Object.entries(SCENE_DURATIONS)) {
    out[key] = cumulativeMs / 1000;
    cumulativeMs += ms;
  }
  return out;
})();

const AUDIO_SEEK_EPSILON_SEC = 0.18;

interface VideoTemplateProps {
  durations?: Record<string, number>;
  loop?: boolean;
  paused?: boolean;
  muted?: boolean;
  onSceneChange?: (sceneKey: string) => void;
}

function Stage({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      setScale(Math.min(rect.width / STAGE_WIDTH, rect.height / STAGE_HEIGHT));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden" style={{ background: '#000' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center center',
          overflow: 'hidden',
          background: '#000',
        }}
      >
        {children}
      </div>
    </div>
  );
}

// Persistent frame furniture: grain, vignette and the bottom rail.
function Furniture({ sceneKey }: { sceneKey: SceneKey }) {
  const step = STEP_LABEL[sceneKey];
  const showRail = sceneKey !== 'cold_open' && sceneKey !== 'close';
  return (
    <>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)', zIndex: 20 }}
      />
      <div className="noise-overlay" style={{ zIndex: 21 }} />
      <motion.div
        className="absolute pointer-events-none"
        style={{ left: 96, right: 96, bottom: 56, zIndex: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: showRail ? 1 : 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="flex items-center" style={{ gap: 16 }}>
          <img src={`${import.meta.env.BASE_URL}brand/revo-mark.png`} alt="" style={{ height: 22, width: 'auto', opacity: 0.85 }} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 15, letterSpacing: '0.26em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>
            Revo · Introduction
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 28 }}>
          <AnimatePresence mode="wait">
            {step ? (
              <motion.span
                key={step}
                style={{ fontFamily: FONT_MONO, fontSize: 15, letterSpacing: '0.26em', color: 'rgba(255,255,255,0.55)' }}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.35 }}
              >
                {step}
              </motion.span>
            ) : null}
          </AnimatePresence>
          <span className="flex items-center" style={{ gap: 10 }}>
            <motion.span
              style={{ width: 7, height: 7, borderRadius: 999, background: ORANGE, boxShadow: `0 0 10px ${ORANGE}` }}
              animate={{ opacity: [1, 0.35, 1] }}
              transition={{ duration: 1.8, repeat: Infinity }}
            />
            <span style={{ fontFamily: FONT_MONO, fontSize: 15, letterSpacing: '0.26em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>
              Arc
            </span>
          </span>
        </div>
      </motion.div>
    </>
  );
}

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  paused = false,
  muted = false,
  onSceneChange,
}: VideoTemplateProps = {}) {
  const { currentSceneKey } = useVideoPlayer({
    durations,
    loop,
    paused,
  });

  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '') as SceneKey;
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Seek only on scene transitions. Resuming from pause must continue from
  // the frozen timestamp, not snap back to the scene start.
  const lastSceneKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0.45;
    if (paused) {
      audio.pause();
      return;
    }
    if (lastSceneKeyRef.current !== currentSceneKey) {
      lastSceneKeyRef.current = currentSceneKey;
      const targetTime = SCENE_START_SEC[baseSceneKey] ?? 0;
      if (Math.abs(audio.currentTime - targetTime) > AUDIO_SEEK_EPSILON_SEC) {
        audio.currentTime = targetTime;
      }
    }
    audio.play().catch(() => {});
  }, [currentSceneKey, baseSceneKey, muted, paused]);

  return (
    <VideoPausedContext.Provider value={paused}>
      <VideoCanvas aspectRatio={VIDEO_ASPECT_RATIO} style={{ backgroundColor: '#000000' }}>
        <Stage>
          <AnimatePresence mode="popLayout">
            {SceneComponent && <SceneComponent key={currentSceneKey} />}
          </AnimatePresence>
          <Furniture sceneKey={baseSceneKey} />
        </Stage>
        <audio
          ref={audioRef}
          src={`${import.meta.env.BASE_URL}audio/bg_music.mp3`}
          preload="auto"
          autoPlay
          muted={muted}
        />
      </VideoCanvas>
    </VideoPausedContext.Provider>
  );
}
