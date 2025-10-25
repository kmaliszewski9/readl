import os
import re
import json
import logging
import asyncio
import contextlib
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.websockets import WebSocketState

import numpy as np
import soundfile as sf

from kokoro import KPipeline

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


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


@app.websocket("/ws/synthesize")
async def ws_synthesize(websocket: WebSocket) -> None:
    await websocket.accept()
    job_id = str(uuid.uuid4())
    cancel_event = threading.Event()
    cancel_reason = {"reason": None}  # mutable holder for thread/receiver communication
    loop = asyncio.get_running_loop()
    # Holder for total segment count computed during quiet pre-count
    total_segments_holder: Dict[str, Optional[int]] = {"value": None}

    async def send_json(message: dict) -> None:
        try:
            await websocket.send_text(json.dumps(message))
        except Exception as send_exc:
            logger.warning(f"Failed to send WS message: {send_exc}")
            cancel_event.set()

    def send_json_from_thread(message: dict) -> None:
        if cancel_event.is_set():
            return
        try:
            fut = asyncio.run_coroutine_threadsafe(websocket.send_text(json.dumps(message)), loop)
            # wait for the send to complete to maintain ordering
            fut.result()
        except Exception as exc:
            # Connection likely closed
            logger.warning(f"WS send failed in worker thread: {exc}")
            cancel_event.set()

    async def receiver_task() -> None:
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "cancel":
                    cancel_reason["reason"] = "client_request"
                    cancel_event.set()
        except asyncio.CancelledError:
            # Receiver task cancelled during shutdown/close; treat as normal
            cancel_event.set()
            return
        except WebSocketDisconnect:
            cancel_reason["reason"] = "client_disconnected"
            cancel_event.set()
        except Exception as rec_exc:
            logger.warning(f"Receiver task error: {rec_exc}")
            cancel_event.set()

    def run_generation(req_payload: dict) -> dict:
        text_local = (req_payload.get("text") or "").strip()
        if not text_local:
            raise ValueError("Text is required")

        voice_local = req_payload.get("voice") or "af_heart"
        speed_local = req_payload.get("speed") or 1.0
        lang_local = req_payload.get("lang_code") or "a"
        split_pattern_local = (req_payload.get("split_pattern") or r"\n+")

        logger.info("=" * 80)
        logger.info("TTS Synthesis Request (WS):")
        logger.info(f"  Voice: {voice_local}")
        logger.info(f"  Speed: {speed_local}")
        logger.info(f"  Lang Code: {lang_local}")
        logger.info(f"  Split Pattern: {split_pattern_local!r}")
        logger.info(f"  Text Length: {len(text_local)} characters")
        logger.info("=" * 80)

        pipeline = get_pipeline(lang_local)
        generator = pipeline(
            text_local,
            voice=voice_local,
            speed=speed_local,
            split_pattern=split_pattern_local,
        )

        audio_segments: list[np.ndarray] = []
        segments_metadata: list[dict] = []
        cumulative_samples: int = 0
        segment_index = 0

        for r in generator:
            if cancel_event.is_set():
                return {"cancelled": True}
            segment_audio = getattr(r, "audio", None)
            if segment_audio is None:
                continue

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
            audio_segments.append(segment_audio)
            cumulative_samples += segment_num_samples

            # Notify client synchronously per segment (with progress when available)
            try:
                local_total_segments = total_segments_holder.get("value")
                progress_value = None
                if isinstance(local_total_segments, int) and local_total_segments > 0:
                    progress_value = min((segment_index + 1) / float(local_total_segments), 1.0)

                payload = {
                    "type": "segment",
                    "job_id": job_id,
                    "index": segment_index,
                    "offset_seconds": segment_offset_seconds,
                    "duration_seconds": segment_duration_seconds,
                }
                if progress_value is not None:
                    payload["progress"] = progress_value

                send_json_from_thread(payload)
            except Exception:
                # best effort; cancellation likely triggered
                pass
            segment_index += 1

        if cancel_event.is_set():
            return {"cancelled": True}

        if not audio_segments:
            raise RuntimeError("No audio segments produced by Kokoro pipeline")

        if len(audio_segments) == 1:
            audio_total = audio_segments[0]
        else:
            audio_total = np.concatenate(audio_segments)

        logger.info("Synthesis Complete (WS):")
        logger.info(f"  Generated {len(audio_segments)} segment(s)")
        logger.info(f"  Total audio length: {len(audio_total)} samples ({len(audio_total) / SAMPLE_RATE:.2f}s)")
        logger.info(f"  Segments with token timestamps: {sum(1 for s in segments_metadata if s.get('has_token_timestamps', False))}")

        # Persist outputs only on successful completion
        saved_rel_path_str = None
        align_rel_path_str = None
        save_path = build_save_path(voice_local, lang_local, text_local)
        sf.write(str(save_path), audio_total, SAMPLE_RATE, format="WAV")

        audio_root = get_audio_root_dir()
        try:
            rel_path = save_path.relative_to(audio_root)
            saved_rel_path_str = str(rel_path)
        except Exception:
            saved_rel_path_str = str(save_path)

        has_any_token_ts_top_level = any(
            bool(s.get("has_token_timestamps")) for s in segments_metadata
        )

        align_path = save_path.with_suffix('.align.ndjson')
        header = {
            "type": "header",
            "version": 1,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "sample_rate": SAMPLE_RATE,
            "duration_seconds": float(len(audio_total) / float(SAMPLE_RATE)),
            "wav_rel_path": saved_rel_path_str,
            "voice": voice_local,
            "speed": speed_local,
            "lang_code": lang_local,
            "split_pattern": split_pattern_local,
            "text": text_local,
            "preview_html": req_payload.get("preview_html"),
            "source_kind": req_payload.get("source_kind"),
            "source_url": req_payload.get("source_url"),
            "raw_content": req_payload.get("raw_content"),
            "raw_content_type": req_payload.get("raw_content_type"),
            "title": req_payload.get("title"),
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

        return {
            "ok": True,
            "wav_rel_path": saved_rel_path_str,
            "align_rel_path": align_rel_path_str,
            "sample_rate": SAMPLE_RATE,
            "duration_seconds": float(len(audio_total) / float(SAMPLE_RATE)),
            "segment_count": len(audio_segments),
        }

    # Expect a start message first
    try:
        first_raw = await websocket.receive_text()
        first = json.loads(first_raw)
        if not isinstance(first, dict) or first.get("type") != "start" or not isinstance(first.get("request"), dict):
            await send_json({"type": "error", "job_id": job_id, "message": "First message must be {type:'start', request:{...}}"})
            await websocket.close(code=1002)
            return
        req_payload = first["request"]
    except WebSocketDisconnect:
        return
    except Exception as parse_exc:
        await send_json({"type": "error", "job_id": job_id, "message": f"Invalid start message: {parse_exc}"})
        await websocket.close(code=1002)
        return

    # Compute quiet pre-count of total segments and announce start
    try:
        # Extract request parameters mirroring generation logic
        text_local = (req_payload.get("text") or "").strip()
        voice_local = req_payload.get("voice") or "af_heart"
        speed_local = req_payload.get("speed") or 1.0
        lang_local = req_payload.get("lang_code") or "a"
        # Mirror split pattern used in generation to keep counts consistent
        split_pattern_local = (req_payload.get("split_pattern") or r"\n+")

        quiet_pipeline = KPipeline(lang_code=(lang_local or "a"), model=False)
        total_segments = sum(1 for _ in quiet_pipeline(
            text_local,
            voice=None,
            speed=speed_local,
            split_pattern=split_pattern_local,
            model=False
        ))
    except Exception:
        total_segments = None

    total_segments_holder["value"] = total_segments if isinstance(total_segments, int) else None
    await send_json({"type": "started", "job_id": job_id, "total_segments": total_segments_holder["value"]})

    # Start receiver
    recv_task = asyncio.create_task(receiver_task())

    try:
        result = await asyncio.to_thread(run_generation, req_payload)
        if result.get("cancelled"):
            if websocket.client_state == WebSocketState.CONNECTED:
                await send_json({"type": "cancelled", "job_id": job_id, "reason": cancel_reason["reason"] or "client_request"})
                await websocket.close(code=1000)
            return
        if result.get("ok"):
            if websocket.client_state == WebSocketState.CONNECTED:
                await send_json({
                    "type": "complete",
                    "job_id": job_id,
                    "ok": True,
                    "wav_rel_path": result.get("wav_rel_path"),
                    "align_rel_path": result.get("align_rel_path"),
                    "sample_rate": result.get("sample_rate"),
                    "duration_seconds": result.get("duration_seconds"),
                    "segment_count": result.get("segment_count"),
                    "progress": 1.0,
                })
                await websocket.close(code=1000)
            return
        # Fallback: unexpected result
        raise RuntimeError("Generation returned unexpected result")
    except Exception as exc:  # noqa: BLE001
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await send_json({"type": "error", "job_id": job_id, "message": f"Synthesis failed: {exc}"})
                await websocket.close(code=1011)
        finally:
            return
    finally:
        try:
            if not recv_task.done():
                recv_task.cancel()
                # Await completion but ignore cancellation/close-related errors
                with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, Exception):
                    await recv_task
        except BaseException:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)


