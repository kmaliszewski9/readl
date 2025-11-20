# Readl CLI

Headless command-line interface for the Readl Kokoro TTS workflow. It reuses the Electron app's Kokoro engine and audio storage helpers so you can ingest content and run synthesis without launching the GUI.

## Installation

From the repo root:

```bash
cd readl-cli
npm install
```

The CLI entry point is exposed as `readl-cli` via the package `bin` field. Run it with `node` or add it to your `$PATH` (e.g., `npm link`).

## Usage

### Synthesize audio

```
readl-cli synth [options]
```

Key options:

- `--text <value>`: inline text
- `--text-file <path>`: load from text/HTML/PDF file
- `--stdin`: read piped input
- `--url <https://...>`: fetch a URL (HTML/PDF)
- `--voice <id>`: Kokoro voice (default `af_heart`)
- `--lang <code>`: language/phoneme set (default `a`)
- `--speed <0.5-1.5>`: speaking speed (default `1`)
- `--audio-dir <path>`: override output directory (`READL_AUDIO_DIR`)
- `--json`: emit structured JSON instead of logs

Examples:

```bash
# Quick text synthesis
readl-cli synth --text "Life is like a box of chocolates"

# HTML file (reader mode extraction)
readl-cli synth --text-file ./samples/article.html --voice bf_emma

# PDF URL with JSON output and custom audio directory
readl-cli synth --url https://example.com/report.pdf --audio-dir ./audios --json
```

### Manage the audio library

```
readl-cli library list [--limit N] [--details] [--json]
readl-cli library delete <relPath> [--yes]
```

- `list` inspects the same `audios/` tree the GUI uses. `--details` parses `.align.ndjson` files for labels and metadata.
- `delete` removes a `.wav` file (and companion alignment). Use `--yes` to skip the confirmation prompt or `--json` for machine-readable output.

## Environment

The CLI respects these environment variables, matching the Electron app:

- `READL_AUDIO_DIR`: root directory for synthesized files (defaults to `../audios` relative to repo root)
- `READL_KOKORO_MODEL_ID`, `READL_KOKORO_DEVICE`, `READL_KOKORO_DTYPE`, `READL_KOKORO_CACHE_DIR`: forwarded to the shared Kokoro engine

## Notes

- PDF ingestion uses `pdfjs-dist`, while HTML ingestion relies on `@mozilla/readability`, `jsdom`, and `dompurify`, mirroring the renderer pipeline.
- Press `Ctrl+C` during synthesis to request cancellation; the CLI wires this into the Kokoro abort signal.
