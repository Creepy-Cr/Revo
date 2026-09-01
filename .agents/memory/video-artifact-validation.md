---
name: Video artifact validation
description: Reliable validation gates for Replit video-js artifacts when scaffold typechecking is noisy.
---

For video-js artifacts, treat recording-lifecycle validation plus an actual Vite production bundle using the workflow-provided `PORT` and `BASE_PATH` as the reliable pre-export gates.

**Why:** The standalone scaffold typecheck can omit browser DOM libraries and report errors in untouched runtime files, while a bare production build can fail before compilation when the workflow environment is absent.

**How to apply:** Run the artifact's recording validator first, then run its real build command with the configured workflow environment. Finish with one workflow restart and a clean log check before presenting the video for export.

When the user explicitly requests an MP4, the interactive video artifact alone is not the deliverable: render and present an actual H.264/AAC file.

**Why:** A preview-pane export action still leaves the user responsible for producing the requested file.

**How to apply:** Capture the clean top-level playback against its canonical timeline, mux the single synchronized music bed, verify duration and codecs, and fully decode-check the result before presenting it.