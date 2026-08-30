import { useEffect, useRef, useState } from 'react';

/**
 * Cinematic hero light-beam video. Blends over pure black via `screen`
 * so the video's black background disappears and only the light remains.
 *
 * Loop behavior: the "light falling from the top" intro plays only once
 * (on page load / refresh). After that, playback jumps back to the
 * steady-state section of the clip - never to 0 - so the beam keeps
 * shimmering ambiently without visibly restarting. A brief opacity dip
 * masks the seek so the cut reads as a natural breath of the light.
 *
 * Respects prefers-reduced-motion: falls back to the static CSS glow.
 */

/** Seconds into the clip where the beam is fully formed (skip the intro when looping). */
const LOOP_START = 3.2;
/** Start easing the light down this many seconds before the clip ends. */
const PRE_FADE = 0.5;
/** Seek back when this close to the end (before the browser fires `ended`). */
const SEEK_AT = 0.15;

export function BeamVideo() {
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [loadVideo, setLoadVideo] = useState(false);
  const [dim, setDim] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (
      navigator as Navigator & {
        connection?: EventTarget & { saveData?: boolean };
      }
    ).connection;
    const update = () => setMotionAllowed(!mq.matches && !connection?.saveData);
    update();
    mq.addEventListener('change', update);
    connection?.addEventListener('change', update);
    return () => {
      mq.removeEventListener('change', update);
      connection?.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (!motionAllowed) {
      setLoadVideo(false);
      return;
    }

    let idleId: number | undefined;
    let fallbackId: ReturnType<typeof globalThis.setTimeout> | undefined;

    const scheduleVideo = () => {
      if ('requestIdleCallback' in window) {
        idleId = window.requestIdleCallback(() => setLoadVideo(true), { timeout: 2500 });
      } else {
        fallbackId = globalThis.setTimeout(() => setLoadVideo(true), 1200);
      }
    };

    if (document.readyState === 'complete') {
      scheduleVideo();
    } else {
      window.addEventListener('load', scheduleVideo, { once: true });
    }

    return () => {
      window.removeEventListener('load', scheduleVideo);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (fallbackId !== undefined) globalThis.clearTimeout(fallbackId);
    };
  }, [motionAllowed]);

  useEffect(() => {
    if (!loadVideo) return;
    const v = ref.current;
    if (!v) return;

    let raf = 0;
    const tick = () => {
      if (v.duration && !v.paused) {
        const remain = v.duration - v.currentTime;
        if (remain <= PRE_FADE) setDim(true);
        if (remain <= SEEK_AT) v.currentTime = LOOP_START;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onSeeked = () => {
      setDim(false);
      if (v.paused) v.play().catch(() => {});
    };
    // Safety net: if the browser reaches the end before our seek lands.
    const onEnded = () => {
      v.currentTime = LOOP_START;
      v.play().catch(() => {});
    };
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ended', onEnded);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ended', onEnded);
    };
  }, [loadVideo]);

  if (!loadVideo) return null;

  return (
    <video
      ref={ref}
      className={`beam-video${dim ? ' beam-video--dim' : ''}`}
      autoPlay
      muted
      playsInline
      preload="none"
      poster={`${import.meta.env.BASE_URL}videos/hero-beam-poster.webp`}
      width="1280"
      height="720"
      aria-hidden="true"
      data-testid="hero-beam-video"
    >
      <source
        src={`${import.meta.env.BASE_URL}videos/hero-beam.webm`}
        type="video/webm"
      />
      <source
        src={`${import.meta.env.BASE_URL}videos/hero-beam.mp4`}
        type="video/mp4"
      />
    </video>
  );
}
