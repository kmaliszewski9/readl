# Readl — Kokoro TTS Desktop

Electron app that synthesizes speech locally using Kokoro-82M via the Kokoro.js Node runtime (ONNX on CPU).

## Features

- Paste plain text or a URL (auto-fetches website and shows preview)
- Pick voice, language, and speed
- Audio is saved to disk; play from disk and manage recordings
- Open local HTML/TXT/PDF files
- See a sanitized, formatted preview; text is auto-extracted for TTS. When input is HTML or a website URL, the app attempts to parse the page using a Reader Mode extractor (Mozilla Readability) to focus on the main article content. If Reader Mode fails, it falls back to sanitized full-page text.
- When token-level alignment is available, the preview highlights each spoken word in sync with playback

## Quick Start

See [Development Guide](docs/development.md) for full setup instructions.

```bash
# 1. Build Kokoro.js
cd kokoro.js && npm install && npm run build

# 2. Run Electron App
cd ../electron-app && npm install && npm start
```

## Documentation

- [Architecture & Technical Notes](docs/architecture.md) - Details on internal design, HTML sanitization, Reader Mode, and PDF handling.
- [Development Guide](docs/development.md) - Setup, build, run, and usage instructions.

## Reference

- Kokoro TTS: https://github.com/hexgrad/kokoro
