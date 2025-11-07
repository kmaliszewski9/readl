import argparse
import json
import os
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download

from .model import KModel, KModelForONNX


def export_kokoro(
    out_dir: str,
    repo_id: str = "hexgrad/Kokoro-82M",
    opset: int = 18,
    device: str = "cpu",
    context_len: int = 32,
):
    """
    Export Kokoro to ONNX with duration predictions as a second output.

    Produces a directory layout compatible with transformers.js:

    out_dir/
      config.json                  # {"model_type":"style_text_to_speech_2"}
      tokenizer.json               # copied from ONNX model repo
      tokenizer_config.json        # copied from ONNX model repo
      onnx/model.onnx              # ONNX with inputs (input_ids, style, speed) and outputs (waveform, pred_dur)
    """
    out_path = Path(out_dir)
    onnx_path = out_path / "onnx"
    onnx_path.mkdir(parents=True, exist_ok=True)

    # 1) Initialize Torch model
    model = KModel(repo_id=repo_id, disable_complex=True).to(device).eval()
    wrapper = KModelForONNX(model).to(device).eval()

    # 2) Create sample inputs
    # input_ids: [1, T]
    T = min(context_len, model.context_length - 2)
    sample_ids = torch.zeros((1, T), dtype=torch.long, device=device)
    # style embedding (256)
    style = torch.zeros((1, 256), dtype=torch.float32, device=device)
    # speed scalar
    speed = torch.tensor([1.0], dtype=torch.float32, device=device)

    # 3) Export ONNX with named IO
    torch.onnx.export(
        wrapper,
        (sample_ids, style, speed),
        onnx_path / "model.onnx",
        input_names=["input_ids", "style", "speed"],
        output_names=["waveform", "pred_dur"],
        dynamic_axes={
            "input_ids": {1: "sequence"},
            "waveform": {1: "n_samples"},  # waveform has shape [1, n]
            "pred_dur": {0: "sequence"},
        },
        opset_version=opset,
        do_constant_folding=True,
        # Use legacy (non-dynamo) exporter to avoid torch.export guards
        dynamo=False,
        training=torch.onnx.TrainingMode.EVAL,
    )

    # 4) Minimal config for transformers.js to select the right class
    (out_path / "config.json").write_text(json.dumps({"model_type": "style_text_to_speech_2"}), encoding="utf-8")

    # 5) Copy tokenizer files from the public ONNX repo for JS tokenization
    for fname in ["tokenizer.json", "tokenizer_config.json"]:
        local = hf_hub_download(repo_id="onnx-community/Kokoro-82M-v1.0-ONNX", filename=fname)
        with open(local, "rb") as r, open(out_path / fname, "wb") as w:
            w.write(r.read())

    print(f"Export complete: {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Export Kokoro ONNX with duration predictions")
    parser.add_argument("--out-dir", type=str, default="kokoro-onnx-export", help="Output directory")
    parser.add_argument("--repo-id", type=str, default="hexgrad/Kokoro-82M", help="Source weights repo")
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset version")
    parser.add_argument("--device", type=str, default="cpu", choices=["cpu", "cuda"], help="Export device")
    parser.add_argument("--context-len", type=int, default=32, help="Sample input token length for tracing")
    args = parser.parse_args()

    export_kokoro(args.out_dir, repo_id=args.repo_id, opset=args.opset, device=args.device, context_len=args.context_len)


if __name__ == "__main__":
    main()
