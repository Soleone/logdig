import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createDemo } from "./demo.js";

const exec = promisify(execFile);
const outputDirectory = process.argv[2];
if (process.argv.includes("--help")) {
  console.log("node scripts/capture-demo.js [NEW_OUTPUT_DIRECTORY]\nRequires agent-browser with its Linux browser installed, plus FFmpeg. Outputs hero.png, demo.mp4, demo.webp, demo.gif and editable replay. Never calls a provider.");
} else {
  capture().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

async function capture() {
  await exec("agent-browser", ["--version"]);
  await exec("ffmpeg", ["-version"]);
  const { root, recording } = await createDemo({ outputDirectory });
  const assets = path.join(root, "assets");
  await mkdir(assets);
  const session = `logdig-capture-${process.pid}`;
  const browser = (...args) => exec("agent-browser", ["--session", session, ...args], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  try {
    await browser("open", pathToFileURL(path.join(root, "index.html")).href);
    await browser("set", "viewport", "1600", "1000");
    await browser("eval", "document.fonts.ready.then(() => true)");
    await browser("eval", "window.seek(1.5)");
    await browser("screenshot", path.join(assets, "hero.png"));
    await browser("record", "start", path.join(assets, "demo.webm"));
    await browser("eval", "window.play()");
    await browser("wait", "--fn", "window.demoDone === true");
    await browser("record", "stop");
    const { stdout } = await browser("errors");
    if (stdout.trim() && !stdout.includes("No errors")) throw new Error(`Browser capture needs review: ${stdout}`);
  } finally { await browser("close"); }
  const encode = (args) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  await encode(["-i", path.join(assets, "demo.webm"), "-an", "-vf", "fps=30", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(assets, "demo.mp4")]);
  await encode(["-i", path.join(assets, "demo.mp4"), "-filter_complex", "[0:v]fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", path.join(assets, "demo.gif")]);
  await encode(["-i", path.join(assets, "demo.mp4"), "-vf", "fps=8,scale=960:-1:flags=lanczos", "-c:v", "libwebp_anim", "-quality", "85", "-compression_level", "6", "-loop", "0", "-an", path.join(assets, "demo.webp")]);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    synthetic: true, dimensions: [1600, 1000], intendedDurationMs: recording.durationMs + 8500,
    source: "index.html + recording.json; docs/launch/artboard.html; scripts/demo.js",
    outputs: ["assets/hero.png", "assets/demo.mp4", "assets/demo.webp", "assets/demo.gif"],
    provenance: "Real LogDig pipeline and progress renderer; ten authored synthetic sessions; deterministic canned summaries and delays. Markdown preview, not an Obsidian screenshot. No audio, private history or provider calls. Lato fonts: SIL OFL, see Lato-LICENSE.txt.",
    verification: recording.verification, review: "Exports require visual review before publication. Timing is illustrative, not a model benchmark.",
  }, null, 2) + "\n");
  console.log(root);
}
