---
name: Headless browser codecs
description: The automated test browser has no H.264 and no GPU, so video codec support and dropped-frame counts there do not reflect real users.
---

The Playwright-based test browser is an open-source Chromium build: it reports an empty
string for `canPlayType('video/mp4; codecs="avc1..."')` — i.e. **no H.264** — and it runs
without GPU acceleration.

**Why it matters twice over:**

1. A page that offers *only* an H.264 MP4 will show the video stuck at `readyState: 0`
   with `duration: null` and **no console error and no failed network request**. That
   looks exactly like a broken asset or a broken server, and it is neither. Confirm the
   file actually serves (status, length, byte-range support) before touching the code,
   then check `canPlayType` for the codecs offered.
2. Dropped-frame counts from `getVideoPlaybackQuality()` in that browser are not
   representative. Software VP9 decode with no GPU can drop ~80% of frames on content
   that plays perfectly for real users on hardware H.264.

**How to apply:** Keep a VP9/WebM `<source>` as a fallback even when H.264 is listed
first for hardware decode — it is what lets the automated browser exercise the feature at
all, and it also covers browser builds shipped without proprietary codecs. When a
dropped-frame number looks alarming, isolate before believing it: toggle the expensive
CSS (blend mode, mask, overlays) and shrink the element, each over its own measurement
window. If the drop rate barely moves, the cost is decode, not compositing, and the
number is an artifact of the test environment rather than a real regression.
