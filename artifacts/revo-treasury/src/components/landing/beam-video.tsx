import { useEffect, useRef, useState } from 'react';

/**
 * Cinematic hero light-beam video. Blends over pure black via `screen`
 * so the video's black background disappears and only the light remains.
 *
 * Loop behavior: the "light falling from the top" intro plays only once
 * (on page load / refresh). After that, playback returns to LOOP_START - never
 * to 0 - so the beam keeps shimmering ambiently without visibly restarting.
 *
 * The asset is authored for exactly this: its closing frames crossfade back
 * into the LOOP_START frame, and LOOP_START sits on a keyframe. That makes the
 * jump invisible and costs the decoder a single frame, instead of replaying the
 * whole clip up to the loop point. No opacity dip is needed to hide a seam.
 *
 * Cost control: the wrap is driven by requestVideoFrameCallback - one call per
 * presented frame (~24/s) and only while playing - instead of a 60fps rAF poll,
 * and playback stops whenever the hero scrolls out of view or the tab is
 * hidden, so nothing is decoded or blend-composited off-screen.
 *
 * Respects prefers-reduced-motion and Save-Data: falls back to the static CSS glow.
 */

/** Seconds into the clip where the steady-state loop begins. Must stay on a keyframe. */
const LOOP_START = 4;
/** Wrap back when this close to the end, before the browser fires `ended`. */
const WRAP_AT = 0.1;
/** Firefox has no requestVideoFrameCallback; `timeupdate` fires ~4x/s, so wrap earlier. */
const WRAP_AT_FALLBACK = 0.3;

export function BeamVideo() {
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [loadVideo, setLoadVideo] = useState(false);
  const [ready, setReady] = useState(false);
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
    if (!loadVideo) {
      // Reduced-motion / Save-Data can flip at runtime. Reset so a later mount
      // fades in from scratch rather than appearing at full opacity instantly.
      setReady(false);
      return;
    }
    const video = ref.current;
    if (!video) return;

    // Chrome/Safari/Edge expose requestVideoFrameCallback; Firefox does not.
    const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    const wrapAt = hasFrameCallback ? WRAP_AT : WRAP_AT_FALLBACK;

    // Set on teardown so an in-flight play() request cannot revive a video we
    // have already detached.
    let disposed = false;
    let onScreen = true;

    // The single gate deciding whether the video should be running at all.
    // Everything that wants to resume playback goes through here.
    const syncPlayback = () => {
      if (disposed) return;
      if (onScreen && !document.hidden) {
        void video.play().catch(() => {});
      } else if (!video.paused) {
        video.pause();
      }
    };

    const wrapIfDue = () => {
      const { duration, currentTime } = video;
      if (!Number.isFinite(duration) || duration <= LOOP_START) return;
      if (duration - currentTime <= wrapAt) video.currentTime = LOOP_START;
    };

    let frameHandle = 0;
    const onFrame = () => {
      wrapIfDue();
      frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    if (hasFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener('timeupdate', wrapIfDue);
    }

    // Safety net if the browser reaches the very end before the wrap lands.
    // Resumes via syncPlayback so it can never restart an off-screen video.
    const onEnded = () => {
      video.currentTime = LOOP_START;
      syncPlayback();
    };
    const onLoadedData = () => setReady(true);
    video.addEventListener('ended', onEnded);
    video.addEventListener('loadeddata', onLoadedData);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);

    // A blended, masked, full-bleed video is expensive to decode and composite,
    // so stop it outright whenever it is not actually on screen.
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) onScreen = latest.isIntersecting;
        syncPlayback();
      },
      { rootMargin: '10% 0px' },
    );
    observer.observe(video);
    document.addEventListener('visibilitychange', syncPlayback);

    return () => {
      disposed = true;
      if (hasFrameCallback) {
        video.cancelVideoFrameCallback(frameHandle);
      } else {
        video.removeEventListener('timeupdate', wrapIfDue);
      }
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('loadeddata', onLoadedData);
      document.removeEventListener('visibilitychange', syncPlayback);
      observer.disconnect();
      // A detached element keeps decoding otherwise.
      video.pause();
    };
  }, [loadVideo]);

  if (!loadVideo) return null;

  return (
    <video
      ref={ref}
      className={`beam-video${ready ? ' beam-video--ready' : ''}`}
      autoPlay
      muted
      playsInline
      preload="auto"
      poster={`${import.meta.env.BASE_URL}videos/hero-beam-poster.webp`}
      width="1280"
      height="720"
      aria-hidden="true"
      data-testid="hero-beam-video"
    >
      {/* H.264 is listed first on purpose: it is hardware-decoded on virtually
          all mainstream browsers, which is what keeps this full-bleed blended
          video smooth on modest hardware. VP9 is only slightly smaller here and
          is often decoded in software for grain-heavy content like this, so it
          stays as the fallback for builds shipped without H.264. */}
      <source
        src={`${import.meta.env.BASE_URL}videos/hero-beam.mp4`}
        type="video/mp4"
      />
      <source
        src={`${import.meta.env.BASE_URL}videos/hero-beam.webm`}
        type="video/webm"
      />
    </video>
  );
}
