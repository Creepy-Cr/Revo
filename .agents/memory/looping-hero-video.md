---
name: Looping hero video
description: Why a background video that loops mid-clip must have its loop point on a keyframe, and how to drive the wrap cheaply.
---

A background video that loops back to a mid-clip timestamp (rather than to 0) must be
authored so that the loop point is **on a keyframe**, and so that the clip's closing
frames crossfade back into the exact loop-point frame.

**Why:** Seeking to a non-keyframe forces the decoder to re-decode every frame from the
previous keyframe forward, which stutters on every single loop — the stutter grows with
the distance from the keyframe. Separately, if the last frame and the loop-point frame
do not match, the jump is visible, which tempts a cosmetic workaround (dimming opacity
around the seek) that hides the symptom while leaving the decode cost in place.

**How to apply:** Encode with the loop point forced as a keyframe (a regular GOP that
lands on it, plus an explicit force-keyframe at that timestamp). Build the seamless
timeline by crossfading the tail back into the loop-point frame, keeping the intro
intact. Verify three things afterwards: the keyframe timestamps include the loop point,
the frame-difference between the last frame and the loop-point frame is near the natural
frame-to-frame delta, and the container has its metadata before the media data so
playback can start before the whole file arrives.

Drive the wrap with `requestVideoFrameCallback`, not a `requestAnimationFrame` poll:
rVFC fires once per *presented* frame and only while playing, so it costs the frame rate
of the video instead of the display, and it goes quiet automatically when paused.
Firefox has no rVFC, so fall back to `timeupdate` with a wider threshold, since
`timeupdate` only fires a few times per second.

Also pause a full-bleed decorative video when it scrolls out of view and when the tab is
hidden. Decoding and compositing an off-screen blended video is pure waste.
