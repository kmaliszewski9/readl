# Kokoro TTS Python Service

FastAPI wrapper around Kokoro-82M. Accepts text and returns WAV audio.

## Setup

- Python 3.9+
- (Optional) install `espeak-ng` via Homebrew for some languages/fallback:

```bash
brew install espeak-ng
```

Commands:

```bash
cd python_service
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Health check: `http://127.0.0.1:8000/health`

Kokoro reference: https://github.com/hexgrad/kokoro
