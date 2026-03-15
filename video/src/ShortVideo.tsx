import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";

// ── Types ──────────────────────────────────────────────────────────
interface Segment {
  id: string;
  start_s: number;
  duration_s: number;
  visual: string;
  narration: string;
  caption?: string | null;
}
interface SegTiming {
  id: string;
  audio_start_ms: number;
  audio_end_ms: number;
  duration_ms: number;
}
interface Props {
  script: {
    title: string;
    hook_text: string;
    cta: string;
    product_id: number;
    product_images: string[];
    product_price: number | string;
    product_rating: number | string;
    product_sold_display: string;
    segments: Segment[];
    hashtags: string[];
  };
  timing: { total_ms: number; segments: SegTiming[] };
  music?: string;
  musicVolume?: number;
  voiceVolume?: number;
  captionsEnabled?: boolean;
}

// ── Caption helpers ────────────────────────────────────────────────
const MAX_WORDS_PER_SCREEN = 6;

function splitSentences(text: string): string[] {
  const t = text.replace(/\s*---+\s*/g, ' --- ').replace(/(^\s*---\s*|\s*---\s*$)/g, '').trim();
  let blocks: string[];
  if (t.includes(' --- ')) {
    blocks = t.split(' --- ').map(s => s.trim()).filter(Boolean);
  } else {
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z\u00C0-\u024F"'])/).map(s => s.trim()).filter(Boolean);
    blocks = parts.length ? parts : [t];
  }
  const result: string[] = [];
  for (const block of blocks) {
    const words = block.split(/\s+/);
    if (words.length <= MAX_WORDS_PER_SCREEN) {
      result.push(block);
    } else {
      for (let i = 0; i < words.length; i += MAX_WORDS_PER_SCREEN)
        result.push(words.slice(i, i + MAX_WORDS_PER_SCREEN).join(' '));
    }
  }
  return result.length ? result : [t];
}

function charStartTimes(items: string[], totalMs: number): number[] {
  const lens = items.map(s => Math.max(s.replace(/\s/g, '').length, 3));
  const total = lens.reduce((a, b) => a + b, 0);
  return lens.map((_, i) => (lens.slice(0, i).reduce((a, b) => a + b, 0) / total) * totalMs);
}

// ── Caption bar — dark bg + orange active-word highlight ───────────
const CaptionBar: React.FC<{
  narration: string;
  segStartMs: number;
  segDurationMs: number;
  currentMs: number;
}> = ({ narration, segStartMs, segDurationMs, currentMs }) => {
  if (!narration || segDurationMs <= 0) return null;

  const elapsed   = Math.max(0, currentMs - segStartMs);
  const sentences = splitSentences(narration);
  const sentStarts = charStartTimes(sentences, segDurationMs);
  const sentIdx    = sentStarts.reduce((best, t, i) => elapsed >= t ? i : best, 0);
  const sentence   = sentences[sentIdx] ?? "";

  const sentStart   = sentStarts[sentIdx] ?? 0;
  const sentEnd     = sentStarts[sentIdx + 1] ?? segDurationMs;
  const sentDur     = Math.max(1, sentEnd - sentStart);
  const sentElapsed = Math.max(0, elapsed - sentStart);

  const words      = sentence.split(/\s+/).filter(Boolean);
  const wordStarts = charStartTimes(words, sentDur);
  const activeWord = wordStarts.reduce((best, t, i) => sentElapsed >= t ? i : best, 0);

  return (
    <div style={{
      position: "absolute",
      bottom: 205,
      left: 0,
      right: 0,
      display: "flex",
      justifyContent: "center",
      paddingLeft: 40,
      paddingRight: 40,
      zIndex: 100,
    }}>
      <div style={{
        background: "rgba(0,0,0,0.72)",
        borderRadius: 16,
        paddingTop: 16,
        paddingBottom: 16,
        paddingLeft: 22,
        paddingRight: 22,
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        rowGap: 8,
        justifyContent: "center",
        maxWidth: "92%",
      }}>
        {words.map((word, i) => (
          <span key={i} style={{
            display: "inline-block",
            background: i === activeWord ? "#F97316" : "transparent",
            borderRadius: 7,
            paddingLeft: i === activeWord ? 10 : 2,
            paddingRight: i === activeWord ? 10 : 2,
            paddingTop: 3,
            paddingBottom: 3,
            fontSize: 44,
            fontWeight: 800,
            fontFamily: "'Montserrat','Arial Black',sans-serif",
            letterSpacing: "0.01em",
            color: "white",
            lineHeight: 1.25,
            textShadow: i === activeWord
              ? "none"
              : "2px 2px 0 rgba(0,0,0,0.95), -2px -2px 0 rgba(0,0,0,0.95), 2px -2px 0 rgba(0,0,0,0.95), -2px 2px 0 rgba(0,0,0,0.95)",
          }}>{word}</span>
        ))}
      </div>
    </div>
  );
};

// ── Logo — "Finding•id" with wave-fill animated dot ───────────────
const LogoBadge: React.FC<{ frame: number }> = ({ frame }) => {
  const DOT = 22;
  const FS  = 42;
  const ANIM = 180;
  const lf = frame % ANIM;

  const dotScale = lf < 18 ? 3 : lf < 36 ? interpolate(lf, [18, 36], [3, 1]) : 1;
  const dotOpacity = lf < 18 ? interpolate(lf, [0, 18], [0, 1]) : 1;
  const dotTy = lf < 36 ? 0
    : lf < 54  ? interpolate(lf, [36, 54],  [0, 55])
    : lf < 72  ? interpolate(lf, [54, 72],  [55, -90])
    : lf < 90  ? interpolate(lf, [72, 90],  [-90, 18])
    : lf < 101 ? interpolate(lf, [90, 101], [18, -55])
    : lf < 112 ? interpolate(lf, [101, 112], [-55, 0])
    : 0;

  const findingOp = lf < 49 ? 0 : lf < 62 ? interpolate(lf, [49, 62], [0, 1]) : 1;
  const idOp      = lf < 144 ? 0 : lf < 158 ? interpolate(lf, [144, 158], [0, 1]) : 1;

  const textSty = (op: number): React.CSSProperties => ({
    fontFamily: "'Montserrat','Arial Black',sans-serif",
    fontWeight: 900, color: "white", fontSize: FS,
    opacity: op, lineHeight: 1,
    textShadow: "2px 2px 6px rgba(0,0,0,0.95), -1px -1px 0 rgba(0,0,0,0.6)",
  });

  return (
    <div style={{
      position: "absolute", top: 270, left: 0, right: 0, zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4em",
      transform: "translateX(-15px)",
    }}>
      <span style={textSty(findingOp)}>Finding</span>
      <div style={{
        width: DOT, height: DOT, flexShrink: 0,
        borderRadius: "50%", overflow: "hidden",
        transform: `translateY(${dotTy}px) scale(${dotScale})`,
        opacity: dotOpacity,
        background: "#F97316",
        boxShadow: "0 2px 10px rgba(0,0,0,0.55)",
        margin: "0 10px",
      }}>
        <svg width={DOT} height={DOT} viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="50" fill="#F97316" />
        </svg>
      </div>
      <span style={textSty(idOp)}>id</span>
    </div>
  );
};

// ── Background image with ken-burns ──────────────────────────────
const BGImage: React.FC<{ src: string; frame: number; duration: number; index: number }> = ({
  src, frame, duration, index,
}) => {
  const p = frame / Math.max(duration, 1);
  const scale = interpolate(p, [0, 1], [1.0, 1.03]);
  const tx    = index % 2 === 0 ? interpolate(p, [0, 1], [0, -30]) : interpolate(p, [0, 1], [0, 30]);
  const ty    = index % 3 === 0 ? interpolate(p, [0, 1], [0, -15]) : interpolate(p, [0, 1], [0, 15]);
  return (
    <Img src={src} onError={() => { /* silently skip missing images */ }} style={{
      width: "100%", height: "100%", objectFit: "contain",
      transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
      background: "#000",
    }} />
  );
};

// ── Main ──────────────────────────────────────────────────────────
export const ShortVideo: React.FC<Props> = ({
  script, timing, music = "music.mp3",
  musicVolume = 0.18, voiceVolume = 1.0, captionsEnabled = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  // Active segment (for captions)
  const activeSegTiming = timing.segments.find(
    s => currentMs >= s.audio_start_ms && currentMs <= s.audio_end_ms + 300
  ) ?? timing.segments[0];
  const activeSegScript = script.segments.find(s => s.id === activeSegTiming?.id);
  const segNarration    = activeSegScript?.caption || activeSegScript?.narration || "";
  const segStartMs      = activeSegTiming?.audio_start_ms ?? 0;
  const segDurationMs   = activeSegTiming ? activeSegTiming.audio_end_ms - activeSegTiming.audio_start_ms : 0;

  // Image cycling through all available product images
  const pid       = script.product_id;
  const numImages = Math.max(1, script.product_images?.length ?? 1);
  const imgSlotMs = 3200;
  const imgSlot   = Math.floor(currentMs / imgSlotMs) % numImages;
  const suffix    = imgSlot === 0 ? "" : `_${imgSlot}`;
  const imgFile   = `${pid}${suffix}.jpg`;
  const imgFrame  = (currentMs % imgSlotMs) / 1000 * fps;

  return (
    <AbsoluteFill style={{ background: "#000", fontFamily: "'Barlow Condensed','Arial Narrow',sans-serif" }}>
      <style>{`
        @font-face {
          font-family: 'Barlow Condensed';
          font-weight: 700;
          font-style: normal;
          src: url('${staticFile("fonts/BarlowCondensed-700.ttf")}') format('truetype');
        }
        @font-face {
          font-family: 'Barlow Condensed';
          font-weight: 900;
          font-style: normal;
          src: url('${staticFile("fonts/BarlowCondensed-900.ttf")}') format('truetype');
        }
      `}</style>

      {/* ── Background image ── */}
      <AbsoluteFill>
        <BGImage
          src={staticFile(`uploads/products/${imgFile}`)}
          frame={imgFrame}
          duration={(imgSlotMs / 1000) * fps}
          index={imgSlot}
        />
      </AbsoluteFill>

      {/* ── Gradient overlay ── */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.1) 0%, transparent 35%, rgba(0,0,0,0.85) 100%)" }} />

      {/* ── Captions ── */}
      {captionsEnabled && (
        <CaptionBar
          narration={segNarration}
          segStartMs={segStartMs}
          segDurationMs={segDurationMs}
          currentMs={currentMs}
        />
      )}

      {/* ── Logo ── */}
      <LogoBadge frame={frame} />

      {/* ── Audio: narration + background music ── */}
      <Audio src={staticFile(`scripts/short_${script.product_id}_audio.mp3`)} volume={voiceVolume} />
      <Audio src={staticFile(music)} volume={musicVolume} />

    </AbsoluteFill>
  );
};
