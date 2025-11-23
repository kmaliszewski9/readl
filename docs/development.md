# Development

## Setup

Install and build the local Kokoro.js package, then install the Electron app:

```bash
cd kokoro.js
npm install
npm run build

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

## Usage

- Paste text or a URL. If you paste/type a URL (e.g. `https://example.com` or `example.com`), the app fetches the page, renders a sanitized preview, and extracts plain text automatically into the textarea for TTS.
- Or click “Open File…” to select an `.html`/`.htm`, `.txt`, or `.pdf` file.
- Choose a voice (e.g. `af_heart`), select language (e.g. `a` for US English), adjust speed, and press Play.

