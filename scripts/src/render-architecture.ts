/**
 * Renders docs/architecture/revo-architecture.svg to a 2x PNG.
 *
 * The SVG is the source of truth for the architecture diagram and embeds its
 * own fonts, so the render is deterministic wherever a Chromium binary and
 * ffmpeg are available (both ship in the Replit workspace).
 *
 *   pnpm --filter @workspace/scripts run render-architecture
 *
 * Set CHROMIUM_BIN if the browser is not on PATH as `chromium`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCALE = 2;
const ROOT = resolve(import.meta.dirname, "../..");
const SVG_PATH = join(ROOT, "docs/architecture/revo-architecture.svg");
const PNG_PATH = join(ROOT, "docs/architecture/revo-architecture.png");

function readDimension(svg: string, name: "width" | "height"): number {
  const match = svg.match(new RegExp(`<svg[^>]*\\s${name}="(\\d+)"`));
  if (!match) {
    throw new Error(`Could not read the root ${name} attribute from ${SVG_PATH}`);
  }
  return Number(match[1]);
}

const svg = readFileSync(SVG_PATH, "utf8");
const width = readDimension(svg, "width");
const height = readDimension(svg, "height");

// Headless Chromium reserves part of --window-size for browser chrome, so the
// capture is taken taller than the drawing and cropped back to size.
const workDir = mkdtempSync(join(tmpdir(), "revo-architecture-"));
const capture = join(workDir, "capture.png");

try {
  execFileSync(
    process.env.CHROMIUM_BIN ?? "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      `--force-device-scale-factor=${SCALE}`,
      `--window-size=${width},${height + 256}`,
      `--screenshot=${capture}`,
      pathToFileURL(SVG_PATH).href,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      capture,
      "-vf",
      `crop=${width * SCALE}:${height * SCALE}:0:0`,
      PNG_PATH,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`Rendered ${PNG_PATH} at ${width * SCALE}x${height * SCALE}`);
