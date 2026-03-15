import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 0; // 0 = OS picks a free port, avoids EADDRINUSE between renders

// ── Config: --product=ID or render_config.json or default 86558 ───
const productArg = process.argv.find(a => a.startsWith("--product="));
const framesArg  = process.argv.find(a => a.startsWith("--frames="));

let productId = 86558;
let musicFile = "music.mp3";
let musicVolume = 0.18;
let voiceVolume = 1.0;
let captionsEnabled = true;
if (productArg) {
  productId = parseInt(productArg.replace("--product=", ""));
}
// Always read render_config.json for music/volume — even when --product= is passed
if (existsSync(join(__dirname, "render_config.json"))) {
  const cfg = JSON.parse(readFileSync(join(__dirname, "render_config.json"), "utf8"));
  if (!productArg) productId = cfg.product_id || 86558;
  if (cfg.music) musicFile = cfg.music;
  if (cfg.music_volume != null) musicVolume = cfg.music_volume / 100;
  if (cfg.voice_volume != null) voiceVolume = cfg.voice_volume / 100;
  if (cfg.captions_enabled != null) captionsEnabled = !!cfg.captions_enabled;
}

let frameRange = null;
if (framesArg) {
  const [from, to] = framesArg.replace("--frames=", "").split("-").map(Number);
  frameRange = [from, to];
}

const isTest  = !!frameRange;
const OUTPUT  = join(__dirname, `../scripts/output_${productId}${isTest ? "_test" : ""}.mp4`);
const ENTRY   = join(__dirname, "src/index.tsx");

// ── Load product data ─────────────────────────────────────────────
const SCRIPTS_DIR = join(__dirname, "../scripts");
const scriptPath  = join(SCRIPTS_DIR, `short_${productId}.json`);
const timingPath  = join(SCRIPTS_DIR, `short_${productId}_timing.json`);

if (!existsSync(scriptPath)) throw new Error(`Script not found: ${scriptPath}`);
if (!existsSync(timingPath)) throw new Error(`Timing not found: ${timingPath}`);

const inputProps = {
  script:          JSON.parse(readFileSync(scriptPath, "utf8")),
  timing:          JSON.parse(readFileSync(timingPath, "utf8")),
  music:           musicFile,
  musicVolume,
  voiceVolume,
  captionsEnabled,
};

const MIME = {
  ".html": "text/html", ".js": "application/javascript",
  ".css":  "text/css",  ".json": "application/json",
  ".mp3":  "audio/mpeg",".jpg":  "image/jpeg",
  ".png":  "image/png", ".woff2":"font/woff2",
};

// ── Bundle ────────────────────────────────────────────────────────
console.log(`Bundling for product ${productId}...`);
const bundled = await bundle({
  entryPoint: ENTRY,
  webpackOverride: (c) => c,
  publicDir: join(__dirname, "public"),
});
console.log(`Bundle → ${bundled}`);

// ── Serve ─────────────────────────────────────────────────────────
const serveUrl = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    const url  = new URL(req.url, `http://localhost`);
    const ext  = extname(url.pathname);
    // For non-HTML requests (images, audio, fonts), return 404 if missing — don't fall back to index.html
    const isAsset = ext && ext !== ".html";
    let   file = join(bundled, url.pathname === "/" ? "index.html" : url.pathname);
    if (!existsSync(file)) {
      if (isAsset) { res.writeHead(404); res.end("not found"); return; }
      file = join(bundled, "index.html");
    }
    try {
      const data = readFileSync(file);
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(data);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  server.listen(PORT, () => {
    const port = (server.address()).port;
    console.log(`Serving on http://localhost:${port}`);
    resolve(`http://localhost:${port}`);
  });
});

// ── Composition ───────────────────────────────────────────────────
const comp = await selectComposition({
  serveUrl, id: "ShortVideo", inputProps, forceIPv4: true,
});
console.log(`Composition: ${comp.id}  ${comp.durationInFrames}f @ ${comp.fps}fps  ${comp.width}x${comp.height}`);

// ── Render ────────────────────────────────────────────────────────
console.log(`Rendering → ${OUTPUT}${frameRange ? ` [frames ${frameRange[0]}-${frameRange[1]}]` : ""}`);
await renderMedia({
  composition: comp,
  serveUrl,
  codec: "h264",
  outputLocation: OUTPUT,
  concurrency: 4,
  forceIPv4: true,
  inputProps,
  frameRange: frameRange ?? null,
  pixelFormat: "yuv420p",   // proper TV range, broad compat
  crf: 10,                  // higher quality source — gives Shopee's transcoder more detail to preserve
  x264Preset: "slow",       // better compression efficiency at same CRF
  audioBitrate: "320k",     // max audio quality before Shopee transcodes
  jpegQuality: 100,         // max frame quality
  onProgress: ({ progress, renderedFrames, totalFrames, stitchStage }) => {
    // Emit parseable progress line (30%→95% range, leaving 0-30 for TTS)
    const pct = Math.round(30 + progress * 65);
    process.stdout.write(`RENDER_PROGRESS:${pct}\n`);
    // Human-readable status
    if (stitchStage) {
      process.stdout.write(`\r  stitching ${stitchStage}…   `);
    } else if (totalFrames) {
      process.stdout.write(`\r  ${renderedFrames}/${totalFrames} frames   `);
    }
  },
});
console.log(`\n✓ Done → ${OUTPUT}`);
process.exit(0);
