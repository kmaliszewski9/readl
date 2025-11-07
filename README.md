# Readl — Kokoro TTS Desktop

Electron app that synthesizes speech locally using Kokoro-82M via the Kokoro.js Node runtime (ONNX on CPU). Everything runs inside the Electron main process—no separate Python service required.

- Paste plain text or a URL (auto-fetches website and shows preview)
- Pick voice, language, and speed
- Audio is saved to disk; play from disk and manage recordings
- Open local HTML/TXT/PDF files
- See a sanitized, formatted preview; text is auto-extracted for TTS. When input is HTML or a website URL, the app attempts to parse the page using a Reader Mode extractor (Mozilla Readability) to focus on the main article content. If Reader Mode fails, it falls back to sanitized full-page text.
- When token-level alignment is available, the preview highlights each spoken word in sync with playback (requires a browser engine with the CSS Highlight API, e.g. Chromium 105+).

## Prerequisites

- macOS (Apple Silicon supported)
- Node.js 18+
- Optional: set `READL_AUDIO_DIR="/absolute/path/to/audios"` before launching to control where synthesized WAVs and alignment sidecars are stored (defaults to `<repo>/audios`).

The first synthesis downloads the Kokoro ONNX weights from Hugging Face (roughly 300 MB) and caches them under `.kokoro-cache` in the repo root.

## Setup

Install dependencies for the local Kokoro.js package and the Electron app:

```bash
cd kokoro.js
npm install

cd ../electron-app
npm install
```

You only need to run the installs once (or whenever `package.json` changes).

## Run the Electron app

In a separate terminal:

```bash
cd electron-app
npm start
```

Usage:

- Paste text or a URL. If you paste/type a URL (e.g. `https://example.com` or `example.com`), the app fetches the page, renders a sanitized preview, and extracts plain text automatically into the textarea for TTS.
- Or click “Open File…” to select an `.html`/`.htm`, `.txt`, or `.pdf` file.
- Choose a voice (e.g. `af_heart`), select language (e.g. `a` for US English), adjust speed, and press Play.

Notes:

- HTML is sanitized at render-time (JavaScript is not executed) using DOMPurify.
- Website URLs are fetched by the app (no CORS prompts). HTML/plain text responses are supported; other content types fall back to HTML rendering. Bare domains are auto-prefixed with `https://`.
  - For HTML pages, the app first tries Reader Mode (Readability) extraction to isolate the main article and uses that for both preview and TTS text.
  - For PDF files/URLs, the app renders with PDF.js using a real text layer (selectable `<span>` text). The TTS text is derived from the same PDF.js `getTextContent()` output to minimize mismatches with the text layer.
  - The existing highlighting pipeline is reused for PDFs: we rebuild the preview text-node index when the PDF text layer renders, and when view changes (zoom/rotation). Tokens are mapped to DOM Ranges and painted via the CSS Highlight API.
  
The Electron main process calls Kokoro.js directly, streams the generated PCM in memory, and writes a WAV plus `.align.ndjson` sidecar into the shared audio directory. When synthesis completes the renderer plays the saved file from disk and loads alignment metadata for highlighting.

## Alignment sidecars (`.align.ndjson`)

Each synthesis produces an NDJSON sidecar next to the WAV. The first line is a header and every subsequent line represents a segment:

Header line:

```json
{"type":"header","version":1,"created_at":"2025-10-04T13:14:49","sample_rate":24000,"duration_seconds":3.21,"wav_rel_path":"2025-10-04/131449419_af_heart_a_hello-world.wav","voice":"af_heart","speed":1.0,"lang_code":"a","split_pattern":"\\n+","text":"Hello world","preview_html":"<p>Hello…</p>","source_kind":"url","source_url":"https://example.com","raw_content":"…","raw_content_type":"text/html","title":"Example","has_token_timestamps":true}
```

Segment line:

```json
{"type":"segment","text_index":0,"offset_seconds":0.0,"duration_seconds":1.23,"has_token_timestamps":true,"tokens":[{"index":0,"text":"Hello","start_ts":0.12,"end_ts":0.48},{"index":1,"text":"world","start_ts":0.62,"end_ts":1.18}]}
```

- Token timestamps are in seconds and typically segment-relative; the app computes absolute times using `offset_seconds + start_ts`.
- When timestamps are not available, `has_token_timestamps` is false; tokens may still be present without `start_ts`/`end_ts`.

### Language codes (Kokoro)

- `a`: English (US)
- `b`: English (UK)
- `e`: Spanish
- `f`: French
- `h`: Hindi
- `i`: Italian
- `j`: Japanese
- `p`: Portuguese (BR)
- `z`: Mandarin

## Troubleshooting

- First run can take a while while Kokoro weights download; watch the Electron console for progress.
- If synthesis fails immediately, ensure the Kokoro.js dependencies are installed (`cd kokoro.js && npm install`) and that Hugging Face downloads are not blocked by a firewall.
- Set `READL_AUDIO_DIR` to a writable path if the default `audios/` directory is not desirable.

## Reference

- Kokoro TTS: https://github.com/hexgrad/kokoro
