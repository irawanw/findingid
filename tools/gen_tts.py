#!/usr/bin/env python3
"""
gen_tts.py — TTS via ElevenLabs + word timestamps via faster-whisper.

Usage:
    python3 tools/gen_tts.py scripts/short_86558.json

Output:
    scripts/short_86558_audio.mp3
    scripts/short_86558_words.json     [{word, start_ms, end_ms, segment}]
    scripts/short_86558_timing.json    segment boundaries
"""

import asyncio, json, sys, os, re
from pathlib import Path
from elevenlabs import ElevenLabs

ELEVENLABS_API_KEYS = [
    "sk_a04bb139a775b8deecb61aa478eb0b1339bf271f02ea96d6",
    "sk_566241f178b1da90339d60aa0c111eae54c40619f4eb2622",
]
VOICE_ID      = "cgSgspJ2msm6clMCkdW9"   # Jessica
GAP_MS        = 350   # silence gap between segments (ms)
WHISPER_MODEL = "base"

_key_index = 0

def get_client():
    return ElevenLabs(api_key=ELEVENLABS_API_KEYS[_key_index % len(ELEVENLABS_API_KEYS)])

def synthesize_segment(text: str, audio_path: str) -> int:
    """Generate TTS for one segment. Rotates API keys on quota/auth errors."""
    global _key_index
    last_err = None
    for _ in range(len(ELEVENLABS_API_KEYS)):
        try:
            c = get_client()
            audio = c.text_to_speech.convert(
                voice_id=VOICE_ID,
                text=text,
                model_id="eleven_multilingual_v2",
                voice_settings={
                    "stability":        0.35,
                    "similarity_boost": 0.80,
                    "style":            0.50,
                    "use_speaker_boost": True,
                },
                output_format="mp3_44100_128",
            )
            with open(audio_path, "wb") as f:
                for chunk in audio:
                    f.write(chunk)
            _key_index += 1  # round-robin: rotate after each successful call
            return os.path.getsize(audio_path)
        except Exception as e:
            last_err = e
            # Rotate to next key on quota / auth errors
            if hasattr(e, 'status_code') and e.status_code in (401, 403, 429):  # type: ignore
                _key_index += 1
                print(f"  [TTS] key error ({e.status_code}), rotating to key {_key_index % len(ELEVENLABS_API_KEYS)}")  # type: ignore
            else:
                raise
    raise RuntimeError(f"All ElevenLabs keys exhausted: {last_err}")

def get_audio_duration_ms(path: str) -> int:
    import subprocess
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True
    )
    try:
        return int(float(r.stdout.strip()) * 1000)
    except Exception:
        return 0

def create_silence(path: str, duration_ms: int):
    os.system(
        f"ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo "
        f"-t {duration_ms/1000} -acodec libmp3lame -q:a 4 '{path}' -loglevel error"
    )

def transcribe_words(audio_path: str) -> list:
    from faster_whisper import WhisperModel
    print(f"  Transcribing with whisper-{WHISPER_MODEL}...")
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        audio_path,
        language="id",
        word_timestamps=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({
                "word":     w.word.strip(),
                "start_ms": int(w.start * 1000),
                "end_ms":   int(w.end   * 1000),
            })
    return words

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 gen_tts.py <script.json>")
        sys.exit(1)

    script_path = Path(sys.argv[1]).resolve()
    with open(script_path) as f:
        script = json.load(f)

    out_dir = script_path.parent
    stem    = script_path.stem
    seg_dir = out_dir / f"{stem}_segments"
    seg_dir.mkdir(exist_ok=True)

    segments = script.get("segments", [])
    print(f"\nElevenLabs TTS — voice={VOICE_ID} model=eleven_multilingual_v2")
    print(f"Segments: {len(segments)}\n")

    concat_files  = []
    seg_meta      = []

    for seg in segments:
        seg_id   = seg["id"]
        narr     = re.sub(r'\s*---+\s*', ', ', seg.get("narration", "")).strip(', ')  # strip caption separators for TTS
        if not narr: continue  # skip segments with no narration
        seg_path = seg_dir / f"{seg_id}.mp3"
        sil_path = seg_dir / f"{seg_id}_gap.mp3"

        print(f"  [{seg_id}] \"{narr[:60]}...\"" if len(narr)>60 else f"  [{seg_id}] \"{narr}\"")
        size = synthesize_segment(narr, str(seg_path))
        dur  = get_audio_duration_ms(str(seg_path))
        print(f"    → {dur}ms  ({size//1024}KB)")

        concat_files.append(str(seg_path.resolve()))
        seg_meta.append((seg_id, dur))

        create_silence(str(sil_path), GAP_MS)
        concat_files.append(str(sil_path.resolve()))

    # Merge
    merged   = out_dir / f"{stem}_audio.mp3"
    cat_list = seg_dir / "concat.txt"
    with open(cat_list, "w") as f:
        for ap in concat_files:
            f.write(f"file '{ap}'\n")

    print(f"\nMerging → {merged}")
    os.system(f"ffmpeg -y -f concat -safe 0 -i '{cat_list}' "
              f"-acodec libmp3lame -q:a 0 '{merged}' -loglevel error")
    total_ms = get_audio_duration_ms(str(merged))
    print(f"✓ {round(total_ms/1000,1)}s total")

    # Segment timing map
    offset = 0
    seg_timing = []
    for (seg_id, dur_ms) in seg_meta:
        seg_timing.append({
            "id": seg_id,
            "audio_start_ms": offset,
            "audio_end_ms":   offset + dur_ms,
            "duration_ms":    dur_ms,
        })
        offset += dur_ms + GAP_MS

    # Whisper word timestamps
    print("\nExtracting word timestamps...")
    raw_words = transcribe_words(str(merged))

    def find_seg(ms):
        for st in seg_timing:
            if st["audio_start_ms"] <= ms <= st["audio_end_ms"] + 200:
                return st["id"]
        return "unknown"

    words = [{"word": w["word"], "start_ms": w["start_ms"],
              "end_ms": w["end_ms"], "segment": find_seg(w["start_ms"])}
             for w in raw_words]

    # Save
    words_out  = out_dir / f"{stem}_words.json"
    timing_out = out_dir / f"{stem}_timing.json"

    with open(words_out,  "w") as f: json.dump(words,    f, ensure_ascii=False, indent=2)
    with open(timing_out, "w") as f: json.dump({
        "total_ms": total_ms, "total_s": round(total_ms/1000,1),
        "segments": seg_timing,
    }, f, ensure_ascii=False, indent=2)

    print(f"\n✓ Audio:  {merged}")
    print(f"✓ Words:  {words_out}  ({len(words)} words)")
    print(f"✓ Timing: {timing_out}")
    print(f"✓ Total:  {round(total_ms/1000,1)}s\n")
    print("Sample:")
    for w in words[:10]:
        print(f"  {w['start_ms']:5}ms  \"{w['word']}\"  [{w['segment']}]")

main()
