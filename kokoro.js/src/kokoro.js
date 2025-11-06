import { env as hf, StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio } from "@huggingface/transformers";
import { phonemizeDetailed } from "./phonemize.js";
import { TextSplitterStream } from "./splitter.js";
import { getVoiceData, VOICES } from "./voices.js";
import fs from 'fs';

const STYLE_DIM = 256;
const SAMPLE_RATE = 24000;
const MAGIC_DIVISOR = 80; // See python pipeline.join_timestamps

class KokoroResult {
  /**
   * @param {{graphemes: string, phonemes: string, tokens: Array<{text: string, phonemes: string, whitespace: boolean, start_ts: number|null, end_ts: number|null}>, audio: RawAudio|null, pred_dur: number[]|null, text_index?: number}} payload
   */
  constructor({ graphemes, phonemes, tokens, audio, pred_dur, text_index = 0 }) {
    this.graphemes = graphemes;
    this.phonemes = phonemes;
    this.tokens = tokens;
    this._audio = audio ?? null;
    this._pred_dur = pred_dur ?? null;
    this.text_index = text_index;
  }

  get audio() {
    return this._audio;
  }

  get pred_dur() {
    return this._pred_dur;
  }

  get text() {
    return this.graphemes;
  }

  /**
   * Provide legacy-style timestamp view.
   * @returns {Array<{index: number, text: string, phonemes: string, start_ts: number, end_ts: number}>}
   */
  get timestamps() {
    if (!Array.isArray(this.tokens)) return [];
    const results = [];
    let idx = 0;
    for (const token of this.tokens) {
      if (token?.phonemes && token.start_ts != null && token.end_ts != null) {
        results.push({
          index: idx,
          text: token.text,
          phonemes: token.phonemes,
          start_ts: token.start_ts,
          end_ts: token.end_ts,
        });
      }
      idx += 1;
    }
    return results;
  }

  *[Symbol.iterator]() {
    yield this.graphemes;
    yield this.phonemes;
    yield this.audio;
  }

  /**
   * Provide tuple-like access similar to Python's __getitem__.
   * @param {number} index
   * @returns {string|RawAudio|null}
   */
  at(index) {
    if (index === 0) return this.graphemes;
    if (index === 1) return this.phonemes;
    if (index === 2) return this.audio;
    return undefined;
  }

  toJSON() {
    return {
      graphemes: this.graphemes,
      phonemes: this.phonemes,
      tokens: this.tokens,
      text_index: this.text_index,
    };
  }
}

/**
 * @typedef {Object} GenerateOptions
 * @property {keyof typeof VOICES} [voice="af_heart"] The voice
 * @property {number} [speed=1] The speaking speed
 */

/**
 * @typedef {Object} StreamProperties
 * @property {RegExp} [split_pattern] The pattern to split the input text. If unset, the default sentence splitter will be used.
 * @typedef {GenerateOptions & StreamProperties} StreamGenerateOptions
 */

export class KokoroTTS {
  /**
   * Create a new KokoroTTS instance.
   * @param {import('@huggingface/transformers').StyleTextToSpeech2Model} model The model
   * @param {import('@huggingface/transformers').PreTrainedTokenizer} tokenizer The tokenizer
   */
  constructor(model, tokenizer) {
    this.model = model;
    this.tokenizer = tokenizer;
  }

  /**
   * Load a KokoroTTS model from the Hugging Face Hub.
   * @param {string} model_id The model id
   * @param {Object} options Additional options
   * @param {"fp32"|"fp16"|"q8"|"q4"|"q4f16"} [options.dtype="fp32"] The data type to use.
   * @param {"wasm"|"webgpu"|"cpu"|null} [options.device=null] The device to run the model on.
   * @param {import("@huggingface/transformers").ProgressCallback} [options.progress_callback=null] A callback function that is called with progress information.
   * @returns {Promise<KokoroTTS>} The loaded model
   */
  static async from_pretrained(model_id, { dtype = "fp32", device = null, progress_callback = null } = {}) {
    const model = StyleTextToSpeech2Model.from_pretrained(model_id, { progress_callback, dtype, device });
    const tokenizer = AutoTokenizer.from_pretrained(model_id, { progress_callback });

    const info = await Promise.all([model, tokenizer]);
    return new KokoroTTS(...info);
  }

 get voices() {
    return VOICES;
  }

  list_voices() {
    console.table(VOICES);
  }

  _validate_voice(voice) {
    if (!VOICES.hasOwnProperty(voice)) {
      console.error(`Voice "${voice}" not found. Available voices:`);
      console.table(VOICES);
      throw new Error(`Voice "${voice}" not found. Should be one of: ${Object.keys(VOICES).join(", ")}.`);
    }
    const language = /** @type {"a"|"b"} */ (voice.at(0)); // "a" or "b"
    return language;
  }

  /**
   * Generate speech and alignment metadata from text, mirroring Python's KPipeline.
   *
   * @param {string} text The input text
   * @param {GenerateOptions} options Additional options
   * @returns {Promise<KokoroResult>} The generated result with audio, phonemes, and tokens
   */
  async generate(text, { voice = "af_heart", speed = 1 } = {}) {
    const language = this._validate_voice(voice);
    const { phonemes, tokens } = await phonemizeDetailed(text, language);
    const { input_ids } = this.tokenizer(phonemes, { truncation: true });
    const { audio, pred_dur } = await this._infer_with_durations(input_ids, { voice, speed });

    const tokenCopies = tokens.map((token) => ({ ...token }));
    if (pred_dur) {
      this._join_timestamps(tokenCopies, pred_dur);
    }

    return new KokoroResult({
      graphemes: text,
      phonemes,
      tokens: tokenCopies,
      audio,
      pred_dur,
      text_index: 0,
    });
  }

  /**
   * Generate speech with alignment metadata (legacy helper). Returns KokoroResult.
   * @param {string} text Input text
   * @param {GenerateOptions} options Options
   * @returns {Promise<KokoroResult>}
   */
  async generate_with_timestamps(text, { voice = "af_heart", speed = 1 } = {}) {
    return this.generate(text, { voice, speed });
  }

  /**
   * Generate audio from input ids.
   * @param {Tensor} input_ids The input ids
   * @param {GenerateOptions} options Additional options
   * @returns {Promise<RawAudio>} The generated audio
   */
  async generate_from_ids(input_ids, { voice = "af_heart", speed = 1 } = {}) {
    const { audio } = await this._infer_with_durations(input_ids, { voice, speed });
    return audio;
  }

  /**
   * Generate speech from text in a streaming fashion.
   * @param {string|TextSplitterStream} text The input text
   * @param {StreamGenerateOptions} options Additional options
   * @returns {AsyncGenerator<KokoroResult, void, void>}
   */
  async *stream(text, { voice = "af_heart", speed = 1, split_pattern = null, return_timestamps = undefined } = {}) {
    const language = this._validate_voice(voice);

    /** @type {TextSplitterStream} */
    let splitter;
    if (text instanceof TextSplitterStream) {
      splitter = text;
    } else if (typeof text === "string") {
      splitter = new TextSplitterStream();
      const chunks = split_pattern
        ? text
          .split(split_pattern)
          .map((chunk) => chunk.trim())
          .filter((chunk) => chunk.length > 0)
        : [text];
      splitter.push(...chunks);
    } else {
      throw new Error("Invalid input type. Expected string or TextSplitterStream.");
    }
    if (return_timestamps !== undefined) {
      // Backwards compatibility: timestamps now available via KokoroResult.timestamps.
    }
    let textIndex = 0;
    for await (const sentence of splitter) {
      if (!sentence?.trim()) {
        continue;
      }
      const { phonemes, tokens } = await phonemizeDetailed(sentence, language);
      const { input_ids } = this.tokenizer(phonemes, { truncation: true });

      // TODO: There may be some cases where - even with splitting - the text is too long.
      // In that case, we should split the text into smaller chunks and process them separately.
      // For now, we just truncate these exceptionally long chunks
      const { audio, pred_dur } = await this._infer_with_durations(input_ids, { voice, speed });
      const tokenCopies = tokens.map((token) => ({ ...token }));
      if (pred_dur) {
        this._join_timestamps(tokenCopies, pred_dur);
      }
      yield new KokoroResult({
        graphemes: sentence,
        phonemes,
        tokens: tokenCopies,
        audio,
        pred_dur,
        text_index: textIndex++,
      });
    }
  }

  /**
   * Internal: run model and return audio and raw duration predictions (if available)
   * @param {Tensor} input_ids
   * @param {GenerateOptions} param1
   * @returns {Promise<{audio: RawAudio, pred_dur: (number[]|null)}>} audio and optional durations
   */
  async _infer_with_durations(input_ids, { voice = "af_heart", speed = 1 } = {}) {
    // Select voice style based on number of input tokens
    const num_tokens = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509);

    // Load voice style
    const data = await getVoiceData(voice);
    const offset = num_tokens * STYLE_DIM;
    const voiceData = data.slice(offset, offset + STYLE_DIM);

    // Prepare model inputs
    const inputs = {
      input_ids,
      style: new Tensor("float32", voiceData, [1, STYLE_DIM]),
      speed: new Tensor("float32", [speed], [1]),
    };

    // Run model
    const outputs = await this.model(inputs);
    // Debug: write outputs schema once if you want to inspect
    try {
      if (!fs.existsSync('outputs.json')) {
        fs.writeFileSync('outputs.json', JSON.stringify(outputs, null, 2));
        console.log('outputs written to outputs.json');
      }
    } catch {}
    const waveform = outputs.waveform ?? outputs['audio'];
    const audio = new RawAudio(waveform.data, SAMPLE_RATE);


    // Try to extract duration predictions (naming may vary by export)
    const durTensor = outputs.pred_dur ?? outputs.duration ?? outputs.durations ?? outputs['dur'];
    let pred_dur = null;
    if (durTensor?.data) {
      const arr = Array.from(durTensor.data);
      // Convert BigInt -> Number if required
      pred_dur = arr.map((x) => (typeof x === 'bigint' ? Number(x) : Number(x)));
    }
    return { audio, pred_dur };
  }

  // No fallback timestamps: if the model does not expose durations,
  // we do not return timestamps and leave it to the caller to decide.

  /**
   * Internal: mutate tokens with timestamp data using duration predictions.
   * Mirrors python KPipeline.join_timestamps.
   * @param {Array<{phonemes: string, whitespace: boolean, start_ts: number|null, end_ts: number|null}>} tokens
   * @param {number[]} pred_dur Duration predictions per character (+spaces) including <bos>/<eos>
   * @returns {Array} The same token array with timestamps applied
   */
  _join_timestamps(tokens, pred_dur) {
    if (!Array.isArray(tokens) || !pred_dur || pred_dur.length < 3) return tokens;

    let left = 2 * Math.max(0, Number(pred_dur[0]) - 3);
    let right = left;
    let i = 1; // Skip <bos>

    for (const token of tokens) {
      const phonemeSeq = token?.phonemes ?? "";
      if (i >= pred_dur.length - 1) break;

      if (!phonemeSeq) {
        if (token?.whitespace && i < pred_dur.length - 1) {
          i += 1;
          left = right + Number(pred_dur[i]);
          right = left + Number(pred_dur[i]);
          i += 1;
        }
        continue;
      }

      const phonemeLen = Array.from(phonemeSeq).length;
      const endIdx = i + phonemeLen;
      if (endIdx >= pred_dur.length) break;

      token.start_ts = left / MAGIC_DIVISOR;
      let tokenDuration = 0;
      for (let idx = i; idx < endIdx; idx++) {
        tokenDuration += Number(pred_dur[idx]);
      }
      const spaceDur = token.whitespace && endIdx < pred_dur.length ? Number(pred_dur[endIdx]) : 0;
      left = right + (2 * tokenDuration) + spaceDur;
      token.end_ts = left / MAGIC_DIVISOR;
      right = left + spaceDur;
      i = endIdx + (token.whitespace ? 1 : 0);
    }

    return tokens;
  }
}

export const env = {
  set cacheDir(value) {
    hf.cacheDir = value
  },
  get cacheDir() {
    return hf.cacheDir
  },
  set wasmPaths(value) {
    hf.backends.onnx.wasm.wasmPaths = value;
  },
  get wasmPaths() {
    return hf.backends.onnx.wasm.wasmPaths;
  },
};

export { TextSplitterStream, KokoroResult };
