# Architecture

The Kokoro runtime lives in the sibling `kokoro.js` package. This is a fork of the original library, extended to return token timestamps (similar to the Python API) for alignment support. We build it with Rollup/TypeScript and install it into the Electron app via a local `file:` dependency. Inside Electron, a lightweight worker thread (`kokoro-worker.js`) hosts the TTS engine (`kokoro-engine.js`) so the main process stays responsive while synthesis runs and can abort work on demand. The renderer only talks to the main process over IPC, which then proxies requests to the worker and streams results back; this keeps audio buffers and ONNX execution off the UI thread.

The Electron main process calls Kokoro.js directly, streams the generated PCM in memory, and writes a WAV plus `.align.ndjson` sidecar into the shared audio directory (see [Alignment Format](alignment.md)). When synthesis completes the renderer plays the saved file from disk and loads alignment metadata for highlighting.

## Alignment & Highlighting

The app features real-time word highlighting during playback, powered by the **CSS Highlight API**.

1. **Generation**: During synthesis, Kokoro estimates start/end timestamps for each token. These are streamed from the worker and saved to a `.align.ndjson` sidecar file alongside the audio WAV.
2. **Indexing**: When the renderer displays text (HTML or PDF), it traverses the DOM text nodes to build an index mapping character offsets to DOM ranges.
3. **Playback**: As audio plays, the current playback time is matched against the token timestamps loaded from the sidecar.
4. **Painting**: The active token's corresponding DOM Range is registered with the CSS Custom Highlight API, visually highlighting the word.

For PDFs, this pipeline handles dynamic re-rendering of the text layer (e.g., on zoom) by rebuilding the node index and re-applying highlights on the fly.

## Technical Notes

- HTML is sanitized at render-time (JavaScript is not executed) using DOMPurify.
- Website URLs are fetched by the app (no CORS prompts). HTML/plain text responses are supported; other content types fall back to HTML rendering. Bare domains are auto-prefixed with `https://`.
  - For HTML pages, the app first tries Reader Mode (Readability) extraction to isolate the main article and uses that for both preview and TTS text.
  - For PDF files/URLs, the app renders with PDF.js using a real text layer (selectable `<span>` text). The TTS text is derived from the same PDF.js `getTextContent()` output to minimize mismatches with the text layer.
