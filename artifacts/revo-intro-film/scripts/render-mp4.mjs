#!/usr/bin/env node
// Deterministic frame renderer for the video-js artifact.
//
// Drives the page with a virtual clock (timers, rAF, performance.now, Date,
// CSS/WAAPI animations, <video> elements) and captures one screenshot per
// frame over raw CDP, so output quality does not depend on how fast the
// machine can paint. Frames stream straight into ffmpeg (H.264 + AAC).
//
// Usage (with the artifact's dev workflow running):
//   node scripts/render-mp4.mjs --url http://localhost:$PORT/revo-intro-film/ \
//     --out dist/revo-intro-film.mp4 --fps 60 --audio public/audio/bg_music.mp3
//
// Options: [--width 1920] [--height 1080] [--seconds <n>] [--audio-gain-db <n>]
//          [--lead-in-ms <n>] [--chromium <binary>] (or CHROMIUM_BIN env)
// Review:  --stills-dir <dir> [--still-every <sec> | --still-times 1,5.5,20]
//          writes PNG stills instead of a movie.
// Needs a Chromium binary and ffmpeg (libx264 + aac) on PATH.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const out = arg('out');
const fps = Number(arg('fps', '60'));
const width = Number(arg('width', '1920'));
const height = Number(arg('height', '1080'));
const audio = arg('audio', null);
const forcedSeconds = arg('seconds', null);
const chromium = arg('chromium', process.env.CHROMIUM_BIN || 'chromium');
const audioGainDb = Number(arg('audio-gain-db', '0'));
const leadInMs = Number(arg('lead-in-ms', '0'));
// Review mode: write a PNG still every --still-every seconds into --stills-dir
// instead of encoding a movie.
const stillsDir = arg('stills-dir', null);
const stillEvery = Number(arg('still-every', '2'));
// Optional explicit capture times (seconds, comma separated) for review.
const stillTimes = (arg('still-times', '') || '')
  .split(',')
  .map((v) => Number(v))
  .filter((v) => Number.isFinite(v));

if (stillsDir && !existsSync(stillsDir)) mkdirSync(stillsDir, { recursive: true });
if (!url || (!out && !stillsDir)) {
  console.error(
    'usage: render-mp4.mjs --url <url> --out <file.mp4> [--fps 60] [--audio bg.mp3] [--seconds n]',
  );
  process.exit(2);
}
if (out && !existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });

// ---------------------------------------------------------------------------
// Virtual clock injected before any page script runs.
// ---------------------------------------------------------------------------
const VIRTUAL_CLOCK = `(() => {
  if (window.__vt) return;
  const realRAF = window.requestAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const RealDate = Date;
  const startEpoch = RealDate.now();
  let vnow = 0;
  let nextId = 1;
  const timers = new Map();
  const rafs = new Map();
  const tracked = new Map();
  const errors = [];

  // Force framer-motion (and anything else) onto JS-driven animations so the
  // virtual rAF owns every tween. CSS animations/transitions are handled
  // through document.getAnimations() below.
  try { delete Element.prototype.animate; } catch (e) {}

  window.setTimeout = (fn, delay = 0, ...args) => {
    const id = nextId++;
    const d = Math.max(0, Number(delay) || 0);
    timers.set(id, { time: vnow + d, fn, args, interval: null, seq: id });
    return id;
  };
  window.setInterval = (fn, delay = 0, ...args) => {
    const id = nextId++;
    const d = Math.max(1, Number(delay) || 1);
    timers.set(id, { time: vnow + d, fn, args, interval: d, seq: id });
    return id;
  };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = nextId++; rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  window.requestIdleCallback = (fn) => window.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1);
  window.cancelIdleCallback = (id) => { timers.delete(id); };
  performance.now = () => vnow;
  class VirtualDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(startEpoch + vnow); else super(...a); }
    static now() { return startEpoch + vnow; }
  }
  window.Date = VirtualDate;
  try {
    Object.defineProperty(AnimationTimeline.prototype, 'currentTime', { get() { return vnow; }, configurable: true });
  } catch (e) {}

  function runTimersUntil(t) {
    for (;;) {
      let best = null; let bestId = 0;
      for (const [id, tm] of timers) {
        if (tm.time <= t && (best === null || tm.time < best.time || (tm.time === best.time && tm.seq < best.seq))) { best = tm; bestId = id; }
      }
      if (!best) break;
      vnow = Math.max(vnow, best.time);
      if (best.interval) { best.time = vnow + best.interval; best.seq = nextId++; } else { timers.delete(bestId); }
      try { best.fn(...best.args); } catch (e) { errors.push(String(e && e.stack || e)); }
    }
    vnow = t;
  }

  function syncAnimations() {
    let list = [];
    try { list = document.getAnimations(); } catch (e) { return; }
    for (const a of list) {
      let rec = tracked.get(a);
      if (!rec) {
        rec = { start: vnow };
        tracked.set(a, rec);
        try { a.pause(); } catch (e) {}
      }
      const t = vnow - rec.start;
      try {
        const timing = a.effect ? a.effect.getComputedTiming() : null;
        const end = timing && Number.isFinite(timing.endTime) ? timing.endTime : Infinity;
        if (t >= end) {
          if (a.playState !== 'finished') { a.currentTime = end; a.finish(); }
        } else {
          a.currentTime = t;
        }
      } catch (e) {}
    }
  }

  const realPause = HTMLMediaElement.prototype.pause;
  const realPausedGet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused').get;
  const videoDuration = (v) => {
    if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
    try { if (v.seekable && v.seekable.length) return v.seekable.end(v.seekable.length - 1); } catch (e) {}
    const hint = Number(v.dataset.durationSec);
    return Number.isFinite(hint) && hint > 0 ? hint : 0;
  };
  function syncVideos() {
    const vids = Array.from(document.querySelectorAll('video'));
    return Promise.all(vids.map((v) => {
      let rec = tracked.get(v);
      if (!rec) {
        rec = { start: vnow };
        tracked.set(v, rec);
        try { v.removeAttribute('autoplay'); v.autoplay = false; } catch (e) {}
        try { realPause.call(v); } catch (e) {}
        try { Object.defineProperty(v, 'play', { value: () => Promise.resolve(), configurable: true }); } catch (e) {}
        try { Object.defineProperty(v, 'paused', { get: () => false, configurable: true }); } catch (e) {}
      }
      // Autoplay or a late play() can restart the element behind our back;
      // the real clock must never drive it.
      try { if (!realPausedGet.call(v)) realPause.call(v); } catch (e) {}
      const dur = videoDuration(v);
      if (!dur || v.readyState < 1) return Promise.resolve();
      let t = ((vnow - rec.start) / 1000) * (v.playbackRate || 1);
      if (v.loop) t = t % dur; else t = Math.min(t, Math.max(0, dur - 0.001));
      if (Math.abs(v.currentTime - t) < 0.0005) return Promise.resolve();
      return new Promise((res) => {
        let done = false;
        const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', finish); res(); };
        v.addEventListener('seeked', finish);
        realSetTimeout(finish, 1500);
        try { v.currentTime = t; } catch (e) { finish(); }
      });
    }));
  }

  window.__vt = {
    now: () => vnow,
    errors,
    async step(t) {
      runTimersUntil(t);
      const list = Array.from(rafs.values());
      rafs.clear();
      for (const fn of list) { try { fn(vnow); } catch (e) { errors.push(String(e && e.stack || e)); } }
      syncAnimations();
      await syncVideos();
      await new Promise((r) => { let fired = false; const go = () => { if (!fired) { fired = true; r(); } }; realRAF(() => realRAF(go)); realSetTimeout(go, 120); });
      return vnow;
    },
    async ready() {
      try { await document.fonts.ready; } catch (e) {}
      const vids = Array.from(document.querySelectorAll('video'));
      await Promise.all(vids.map((v) => new Promise((res) => {
        if (v.readyState >= 3) return res();
        const done = () => res();
        v.addEventListener('canplaythrough', done, { once: true });
        v.addEventListener('loadeddata', done, { once: true });
        v.addEventListener('error', done, { once: true });
        realSetTimeout(done, 8000);
        try { v.load(); } catch (e) {}
      })));
      const videoInfo = vids.map((v) => ({ src: (v.currentSrc || v.src || '').split('/').pop(), duration: v.duration, seekable: v.seekable && v.seekable.length ? v.seekable.end(0) : null, readyState: v.readyState }));
      return { fonts: document.fonts.size, videos: videoInfo, total: window.__replitVideoTotalDurationMs || null, mounted: !!window.__replitVideoPlayerMounted };
    },
  };
})();`;

// ---------------------------------------------------------------------------
// Minimal CDP client over --remote-debugging-pipe (fd 3 out, fd 4 in).
// ---------------------------------------------------------------------------
const CDP_TIMEOUT_MS = 60000;

class CDP {
  constructor(proc) {
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.buf = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => this.onData(chunk));
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const idx = this.buf.indexOf(0);
      if (idx < 0) break;
      const raw = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        const key = `${msg.sessionId || ''}:${msg.method}`;
        for (const fn of this.listeners.get(key) || []) fn(msg.params);
        for (const fn of this.listeners.get(`*:${msg.method}`) || []) fn(msg.params, msg.sessionId);
      }
    }
  }
  send(method, params = {}, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.proc.stdio[3].write(JSON.stringify(payload) + '\0');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  // Reject everything in flight; used when the browser dies underneath us.
  fail(err) {
    this.closed = err;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
  on(method, fn, sessionId) {
    const key = `${sessionId || '*'}:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(fn);
  }
}

async function main() {
  const chromeArgs = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI,IsolateOrigins,site-per-process',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  const chrome = spawn(chromium, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const cdp = new CDP(chrome);
  let chromeErr = '';
  let shuttingDown = false;
  let ff = null;
  chrome.stderr.on('data', (d) => {
    chromeErr += d.toString();
    if (chromeErr.length > 20000) chromeErr = chromeErr.slice(-20000);
  });
  chrome.on('error', (err) => cdp.fail(new Error(`could not launch chromium (${chromium}): ${err.message}`)));
  chrome.on('exit', (code) => {
    if (shuttingDown) return;
    cdp.fail(new Error(`chromium exited early (code ${code}) ${chromeErr.slice(-2000)}`));
  });

  const teardown = async () => {
    shuttingDown = true;
    if (ff) {
      try {
        if (!ff.stdin.destroyed) ff.stdin.destroy();
      } catch {}
      if (ff.exitCode === null) {
        try {
          ff.kill('SIGKILL');
        } catch {}
      }
    }
    if (!cdp.closed) {
      try {
        await cdp.send('Browser.close', {}, undefined, 5000);
      } catch {}
    }
    if (chrome.exitCode === null) {
      try {
        chrome.kill('SIGKILL');
      } catch {}
    }
  };

  try {
    await renderSession();
  } finally {
    await teardown();
  }

  async function renderSession() {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', width, height });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => cdp.send(m, p, sessionId);

    const consoleLines = [];
    cdp.on(
      'Runtime.consoleAPICalled',
      (p) => {
        if (p.type === 'error' || p.type === 'warning')
          consoleLines.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      },
      sessionId,
    );
    cdp.on(
      'Runtime.exceptionThrown',
      (p) => {
        consoleLines.push(
          `exception: ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description || ''}`,
        );
      },
      sessionId,
    );

    await s('Page.enable');
    await s('Runtime.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await s('Emulation.setFocusEmulationEnabled', { enabled: true });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: VIRTUAL_CLOCK });

    const loaded = new Promise((r) => cdp.on('Page.loadEventFired', () => r(), sessionId));
    await s('Page.navigate', { url });
    await loaded;

    const evalJson = async (expr) => {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails)
        throw new Error(
          `page eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`,
        );
      return r.result.value;
    };

    // Let React mount under the frozen clock, then wait for fonts and media.
    await new Promise((r) => setTimeout(r, 1500));
    const ready = await evalJson('window.__vt.ready()');
    console.error('page ready:', JSON.stringify(ready));
    if (!ready.mounted)
      throw new Error('video player did not mount (window.__replitVideoPlayerMounted is false)');

    const totalMs = forcedSeconds ? Number(forcedSeconds) * 1000 : ready.total;
    if (!totalMs || !Number.isFinite(totalMs)) throw new Error('could not determine total duration');
    const frameMs = 1000 / fps;
    const totalFrames = Math.round(totalMs / frameMs);
    console.error(
      `rendering ${totalFrames} frames at ${fps} fps (${(totalMs / 1000).toFixed(2)}s) -> ${out}`,
    );

    // Optional lead-in: walk the clock frame by frame up to the first captured
    // frame, exactly as a full render would, so a segment rendered with
    // --lead-in-ms 20000 --seconds 20 is frame-identical to that stretch of a
    // full render and segments can be concatenated losslessly.
    if (leadInMs > 0) {
      const leadFrames = Math.round(leadInMs / frameMs);
      const leadStarted = Date.now();
      for (let i = 0; i < leadFrames; i++) {
        await evalJson(`window.__vt.step(${(i * frameMs).toFixed(4)})`);
      }
      console.error(`lead-in: ${leadFrames} frames in ${((Date.now() - leadStarted) / 1000).toFixed(0)}s`);
    }

    if (stillsDir) {
      const { writeFileSync } = await import('node:fs');
      const everyFrames = Math.max(1, Math.round(stillEvery * fps));
      const wantedFrames = new Set(stillTimes.map((sec) => Math.round((sec * 1000 - leadInMs) / frameMs)));
      const lastWanted = stillTimes.length ? Math.max(...wantedFrames) : totalFrames - 1;
      for (let i = 0; i < totalFrames && i <= lastWanted; i++) {
        const t = leadInMs + i * frameMs;
        await evalJson(`window.__vt.step(${t.toFixed(4)})`);
        const wanted = stillTimes.length
          ? wantedFrames.has(i)
          : i % everyFrames === 0 || i === totalFrames - 1;
        if (wanted) {
          const shot = await s('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
          const name = `t${String(Math.round(t / 100) / 10)
            .padStart(6, '0')
            .replace('.', '_')}.png`;
          writeFileSync(`${stillsDir}/${name}`, Buffer.from(shot.data, 'base64'));
          console.error(`still ${name}`);
        }
      }
      const pageErrors = await evalJson('window.__vt.errors.slice(0, 20)');
      if (pageErrors.length) console.error('page timer/raf errors:', pageErrors);
      if (consoleLines.length) console.error('console:', consoleLines.slice(0, 30).join('\n'));
      console.error('stills done:', stillsDir);
      return;
    }

    const ffArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-stats',
      '-framerate',
      String(fps),
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-i',
      'pipe:0',
    ];
    const totalSec = totalMs / 1000;
    if (audio) {
      const fadeStart = Math.max(0, totalSec - 2.5).toFixed(3);
      ffArgs.push(
        '-i',
        audio,
        '-filter_complex',
        `[1:a]atrim=0:${totalSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${audioGainDb}dB,afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeStart}:d=2.5[a]`,
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
      );
    } else {
      ffArgs.push('-map', '0:v');
    }
    ffArgs.push(
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '16',
      '-profile:v',
      'high',
      '-level',
      '4.2',
      '-pix_fmt',
      'yuv420p',
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-r',
      String(fps),
      '-vsync',
      'cfr',
      '-movflags',
      '+faststart',
      '-t',
      totalSec.toFixed(3),
      out,
    );
    ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    const ffDone = new Promise((resolve, reject) => {
      ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
      ff.on('error', reject);
    });
    // A broken pipe must surface as a render failure, not an unhandled error.
    ff.stdin.on('error', () => {});
    const write = (buf) =>
      new Promise((resolve, reject) => {
        if (ff.stdin.destroyed) return reject(new Error('ffmpeg stdin closed'));
        const ok = ff.stdin.write(buf, (err) => (err ? reject(err) : undefined));
        if (ok) resolve();
        else ff.stdin.once('drain', resolve);
      });

    const startedAt = Date.now();
    for (let i = 0; i < totalFrames; i++) {
      const t = leadInMs + i * frameMs;
      await evalJson(`window.__vt.step(${t.toFixed(4)})`);
      const shot = await s('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true,
        captureBeyondViewport: false,
      });
      await write(Buffer.from(shot.data, 'base64'));
      if (i % (fps * 5) === 0 || i === totalFrames - 1) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = (i + 1) / Math.max(elapsed, 0.001);
        console.error(
          `frame ${i + 1}/${totalFrames} t=${(t / 1000).toFixed(2)}s elapsed=${elapsed.toFixed(0)}s eta=${((totalFrames - i - 1) / rate).toFixed(0)}s`,
        );
      }
    }
    ff.stdin.end();
    await ffDone;

    const pageErrors = await evalJson('window.__vt.errors.slice(0, 20)');
    if (pageErrors.length) console.error('page timer/raf errors:', pageErrors);
    if (consoleLines.length) console.error('console:', consoleLines.slice(0, 30).join('\n'));

    console.error('done:', out);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('render failed:', (err && err.stack) || err);
    process.exit(1);
  },
);
