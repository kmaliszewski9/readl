# Readl — Kokoro TTS Desktop

Electron app + Python FastAPI service to synthesize speech locally using Kokoro-82M.

- Paste plain text or a URL (auto-fetches website and shows preview)
- Pick voice, language, and speed
- Audio is saved to disk; play from disk and manage recordings
- Open local HTML/Markdown/TXT files
- See a sanitized, formatted preview; text is auto-extracted for TTS. When input is HTML or a website URL, the app attempts to parse the page using a Reader Mode extractor (Mozilla Readability) to focus on the main article content. If Reader Mode fails, it falls back to sanitized full-page text.

## Prerequisites

- macOS (Apple Silicon supported)
- Python 3.9+
- Node.js 18+
- Recommended: install espeak-ng for some languages/fallback:

```bash
brew install espeak-ng
```

Apple Silicon GPU acceleration (optional):

```bash
export PYTORCH_ENABLE_MPS_FALLBACK=1
```

Shared audio directory (optional, recommended):

```bash
# Directory where synthesized WAVs and metadata JSON are stored
export READL_AUDIO_DIR="/absolute/path/to/audios"
```

## 1) Start the Python TTS service

```bash
cd python_service
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

- Health check: http://127.0.0.1:8000/health
- API docs: http://127.0.0.1:8000/docs

### Language notes

The service is configured with `misaki[en]`. For additional languages, install the corresponding extras in the same venv:

```bash
# Examples
pip install 'misaki[ja]'   # Japanese
pip install 'misaki[zh]'   # Mandarin Chinese
```

### API

- POST `/synthesize` → returns JSON with saved file paths
- JSON body:
  - `text` (string, required)
  - `voice` (string, default `af_heart`)
  - `speed` (number, default `1.0`)
  - `lang_code` (string, default `a`)
  - `split_pattern` (string regex, default `\n+`)
  - Optional metadata to recreate preview in the app:
    - `preview_html` (string) — sanitized HTML preview
    - `source_kind` (string) — one of `url` | `file` | `text`
    - `source_url` (string) — source URL or file path
    - `raw_content` (string) — original raw content
    - `raw_content_type` (string) — e.g., `text/html`, `text/markdown`, `text/plain`
    - `title` (string)

Example request and response:

```bash
curl -X POST http://127.0.0.1:8000/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","voice":"af_heart","speed":1.0,"lang_code":"a"}'
```

Response (200):

```json
{
  "ok": true,
  "root_dir": "/path/to/audios",
  "wav_rel_path": "2025-10-02/182409399_af_heart_a_hello-world.wav",
  "meta_rel_path": "2025-10-02/182409399_af_heart_a_hello-world.json",
  "sample_rate": 24000,
  "duration_seconds": 1.23,
  "voice": "af_heart",
  "speed": 1.0,
  "lang_code": "a",
  "text": "Hello world"
}
```

#### Sidecar metadata (.json)

The service writes a sidecar JSON next to each WAV containing per-segment info and per-token timestamps when available.

Example schema:

```json
{
  "created_at": "2025-10-04T13:14:49",
  "sample_rate": 24000,
  "duration_seconds": 3.21,
  "wav_rel_path": "2025-10-04/131449419_af_heart_a_hello-world.wav",
  "voice": "af_heart",
  "speed": 1.0,
  "lang_code": "a",
  "split_pattern": "\\n+",
  "text": "Hello world",
  "segments": [
    {
      "text_index": 0,
      "offset_seconds": 0.0,
      "duration_seconds": 1.23,
      "has_token_timestamps": true,
      "tokens": [
        { "index": 0, "text": "Hello", "start_ts": 0.12, "end_ts": 0.48 },
        { "index": 1, "text": "world", "start_ts": 0.62, "end_ts": 1.18 }
      ]
    }
  ],
  "has_token_timestamps": true
}
```

- Token timestamps are in seconds and are relative to their segment; use `offset_seconds + start_ts` to compute absolute times within the full WAV.
- When timestamps are not available, `has_token_timestamps` is false; tokens may still be present without `start_ts`/`end_ts`.

Language codes (Kokoro):

- `a`: English (US)
- `b`: English (UK)
- `e`: Spanish
- `f`: French
- `h`: Hindi
- `i`: Italian
- `j`: Japanese (requires `misaki[ja]`)
- `p`: Portuguese (BR)
- `z`: Mandarin (requires `misaki[zh]`)

## 2) Start the Electron app

In a separate terminal:

```bash
cd electron-app
npm install
npm start
```

Usage:

- Paste text or a URL. If you paste/type a URL (e.g. `https://example.com` or `example.com`), the app fetches the page, renders a sanitized preview, and extracts plain text automatically into the textarea for TTS.
- Or click “Open File…” to select an `.html`/`.htm`, `.md`/`.markdown`, or `.txt` file.
- Choose a voice (e.g. `af_heart`), select language (e.g. `a` for US English), adjust speed, and press Play.

Notes:

- HTML is sanitized at render-time (JavaScript is not executed) using DOMPurify.
- Markdown is rendered with `marked` and then sanitized before preview.
- Website URLs are fetched by the app (no CORS prompts). HTML/Markdown/plain text responses are supported; other content types fall back to HTML rendering. Bare domains are auto-prefixed with `https://`.
  - For HTML pages, the app first tries Reader Mode (Readability) extraction to isolate the main article and uses that for both preview and TTS text.
  
The app calls the local Python service at `http://127.0.0.1:8000`. The service saves audio to disk and returns JSON pointing to the saved file; the app plays the file directly from disk.

## Troubleshooting

- If synthesis fails, ensure the Python service is running and espeak-ng is installed.
- For Japanese/Mandarin, install the `misaki` extras mentioned above.
- On Apple Silicon, try enabling `PYTORCH_ENABLE_MPS_FALLBACK=1` before starting the service.

## Reference

- Kokoro TTS: https://github.com/hexgrad/kokoro
