# Alignment Sidecars (`.align.ndjson`)

Each synthesis produces an NDJSON sidecar next to the WAV. The first line is a header and every subsequent line represents a segment:

Header line:

```json
{"type":"header","version":1,"created_at":"2025-10-04T13:14:49","sample_rate":24000,"duration_seconds":3.21,"wav_rel_path":"2025-10-04/131449419_af_heart_a_hello-world.wav","voice":"af_heart","speed":1.0,"lang_code":"a","text":"Hello world","preview_html":"<p>Hello…</p>","source_kind":"url","source_url":"https://example.com","raw_content":"…","raw_content_type":"text/html","title":"Example","has_token_timestamps":true}
```

Segment line:

```json
{"type":"segment","text_index":0,"offset_seconds":0.0,"duration_seconds":1.23,"has_token_timestamps":true,"tokens":[{"index":0,"text":"Hello","start_ts":0.12,"end_ts":0.48},{"index":1,"text":"world","start_ts":0.62,"end_ts":1.18}]}
```

- Token timestamps are in seconds and typically segment-relative; the app computes absolute times using `offset_seconds + start_ts`.
- When timestamps are not available, `has_token_timestamps` is false; tokens may still be present without `start_ts`/`end_ts`.

