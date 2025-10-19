import os
import io
import re
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.responses import JSONResponse

import numpy as np
import soundfile as sf

from kokoro import KPipeline

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class SynthesisRequest(BaseModel):
    text: str
    voice: Optional[str] = "af_heart"
    speed: Optional[float] = 1.0
    lang_code: Optional[str] = "a"
    split_pattern: Optional[str] = r"\n+"
    # Optional metadata from client to reconstruct preview
    preview_html: Optional[str] = None
    source_kind: Optional[str] = None  # url | file | text
    source_url: Optional[str] = None
    raw_content: Optional[str] = None
    raw_content_type: Optional[str] = None  # e.g., text/html, text/markdown, text/plain
    title: Optional[str] = None


app = FastAPI(title="Kokoro TTS Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_pipelines_cache: Dict[str, KPipeline] = {}
SAMPLE_RATE = 24000


def get_pipeline(lang_code: str) -> KPipeline:
    lang_key = (lang_code or "a").strip().lower()
    if lang_key not in _pipelines_cache:
        _pipelines_cache[lang_key] = KPipeline(lang_code=lang_key)
    return _pipelines_cache[lang_key]


def get_audio_root_dir() -> Path:
    """Resolve the shared audios directory. Prefer READL_AUDIO_DIR, fallback to repo_root/audios.

    The repo root is assumed to be the parent of this file's directory.
    """
    env_path = os.environ.get("READL_AUDIO_DIR")
    if env_path:
        p = Path(env_path).expanduser().resolve()
    else:
        # python_service/ -> repo root is parent
        p = (Path(__file__).resolve().parent.parent / "audios").resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def slugify(text: str, max_len: int = 60) -> str:
    """Create a filesystem-friendly slug from text."""
    if not text:
        return "tts"
    t = re.sub(r"\s+", " ", text).strip().lower()
    # keep alnum, dash and underscore
    t = re.sub(r"[^a-z0-9\-\_ ]+", "", t)
    t = t.replace(" ", "-")
    if not t:
        t = "tts"
    return t[:max_len]


def build_save_path(voice: str, lang_code: str, text: str) -> Path:
    root = get_audio_root_dir()
    now = datetime.now()
    day_dir = root / now.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    timestamp = now.strftime("%H%M%S%f")[:-3]  # ms precision
    base = f"{timestamp}_{(voice or 'af_heart').strip()}_{(lang_code or 'a').strip()}"
    preview = slugify(text[:80])
    filename = f"{base}_{preview}.wav" if preview else f"{base}.wav"
    return (day_dir / filename).resolve()


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.post("/synthesize")
def synthesize(req: SynthesisRequest) -> JSONResponse:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    try:
        # Log the parameters being passed to the TTS model
        voice = req.voice or "af_heart"
        speed = req.speed or 1.0
        lang_code = req.lang_code or "a"
        split_pattern = req.split_pattern or r"\n+"
        
        logger.info("=" * 80)
        logger.info("TTS Synthesis Request:")
        logger.info(f"  Voice: {voice}")
        logger.info(f"  Speed: {speed}")
        logger.info(f"  Lang Code: {lang_code}")
        logger.info(f"  Split Pattern: {split_pattern!r}")
        logger.info(f"  Text Length: {len(text)} characters")
        logger.info(f"  Full Text:\n{text}")
        logger.info("=" * 80)
        
        pipeline = get_pipeline(lang_code)
        generator = pipeline(
            text,
            voice=voice,
            speed=speed,
            split_pattern="\n+",
        )

        audio_segments: list[np.ndarray] = []
        segments_metadata: list[dict] = []
        cumulative_samples: int = 0

        for r in generator:
            segment_audio = r.audio
            if segment_audio is None:
                # Skip segments that did not produce audio
                continue

            # Collect token timestamps if available
            tokens_serialized = None
            has_any_token_ts = False
            if getattr(r, "tokens", None):
                tokens_serialized = []
                for idx, t in enumerate(r.tokens):
                    token_info = {
                        "index": idx,
                        "text": getattr(t, "text", None),
                    }
                    start_ts = getattr(t, "start_ts", None)
                    end_ts = getattr(t, "end_ts", None)
                    if start_ts is not None:
                        token_info["start_ts"] = float(start_ts)
                        has_any_token_ts = True
                    if end_ts is not None:
                        token_info["end_ts"] = float(end_ts)
                        has_any_token_ts = True
                    tokens_serialized.append(token_info)

            # Segment timing relative to concatenated audio
            segment_num_samples = int(len(segment_audio))
            segment_offset_seconds = float(cumulative_samples / float(SAMPLE_RATE))
            segment_duration_seconds = float(segment_num_samples / float(SAMPLE_RATE))

            segment_info = {
                "text_index": getattr(r, "text_index", None),
                "offset_seconds": segment_offset_seconds,
                "duration_seconds": segment_duration_seconds,
            }
            if tokens_serialized is not None:
                segment_info["tokens"] = tokens_serialized
                segment_info["has_token_timestamps"] = has_any_token_ts

            segments_metadata.append(segment_info)

            # Accumulate audio and advance offset
            audio_segments.append(segment_audio)
            cumulative_samples += segment_num_samples

        if not audio_segments:
            raise RuntimeError("No audio segments produced by Kokoro pipeline")

        if len(audio_segments) == 1:
            audio_total = audio_segments[0]
        else:
            audio_total = np.concatenate(audio_segments)
        
        # Log synthesis results
        logger.info(f"Synthesis Complete:")
        logger.info(f"  Generated {len(audio_segments)} segment(s)")
        logger.info(f"  Total audio length: {len(audio_total)} samples ({len(audio_total) / SAMPLE_RATE:.2f}s)")
        logger.info(f"  Segments with token timestamps: {sum(1 for s in segments_metadata if s.get('has_token_timestamps', False))}")

        # Persist to disk under shared audios/ directory (WAV + sidecar NDJSON alignment)
        saved_rel_path_str = None
        align_rel_path_str = None
        try:
            save_path = build_save_path(req.voice or "af_heart", req.lang_code or "a", text)
            sf.write(str(save_path), audio_total, SAMPLE_RATE, format="WAV")

            # Write sidecar NDJSON alignment next to WAV
            audio_root = get_audio_root_dir()
            try:
                rel_path = save_path.relative_to(audio_root)
                saved_rel_path_str = str(rel_path)
            except Exception:
                saved_rel_path_str = str(save_path)

            has_any_token_ts_top_level = any(
                bool(s.get("has_token_timestamps")) for s in segments_metadata
            )

            # Build NDJSON file: header + one segment per line
            align_path = save_path.with_suffix('.align.ndjson')
            header = {
                "type": "header",
                "version": 1,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "sample_rate": SAMPLE_RATE,
                "duration_seconds": float(len(audio_total) / float(SAMPLE_RATE)),
                "wav_rel_path": saved_rel_path_str,
                "voice": req.voice or "af_heart",
                "speed": req.speed or 1.0,
                "lang_code": req.lang_code or "a",
                "split_pattern": req.split_pattern or r"\n+",
                "text": text,
                "preview_html": req.preview_html,
                "source_kind": req.source_kind,
                "source_url": req.source_url,
                "raw_content": req.raw_content,
                "raw_content_type": req.raw_content_type,
                "title": req.title,
                "has_token_timestamps": has_any_token_ts_top_level,
            }
            with align_path.open('w', encoding='utf-8') as f:
                f.write(json.dumps(header, ensure_ascii=False) + "\n")
                for seg in segments_metadata:
                    line = {"type": "segment"}
                    line.update(seg)
                    f.write(json.dumps(line, ensure_ascii=False) + "\n")
            try:
                align_rel_path_str = str(align_path.relative_to(audio_root))
            except Exception:
                align_rel_path_str = str(align_path)
        except Exception as save_exc:  # noqa: BLE001
            # Fail the request: we cannot direct client to a file that was not saved
            raise HTTPException(status_code=500, detail=f"Failed to save WAV/metadata to disk: {save_exc}") from save_exc

        # Respond with JSON pointing to saved file paths
        return JSONResponse(
            {
                "ok": True,
                "root_dir": str(get_audio_root_dir()),
                "wav_rel_path": saved_rel_path_str,
                "align_rel_path": align_rel_path_str,
                "sample_rate": SAMPLE_RATE,
                "duration_seconds": float(len(audio_total) / float(SAMPLE_RATE)),
                "voice": req.voice or "af_heart",
                "speed": req.speed or 1.0,
                "lang_code": req.lang_code or "a",
                "text": text,
            }
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)


