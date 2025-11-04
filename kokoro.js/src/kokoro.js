import { env as hf, StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio } from "@huggingface/transformers";
import { phonemize } from "./phonemize.js";
import { TextSplitterStream } from "./splitter.js";
import { getVoiceData, VOICES } from "./voices.js";
import fs from 'fs';

const STYLE_DIM = 256;
const SAMPLE_RATE = 24000;
const MAGIC_DIVISOR = 80; // See python pipeline.join_timestamps
const PUNCTUATION_CHARS = ';:,.!?¡¿—…"«»“”(){}[]';

/**
 * @typedef {Object} Timestamp
 * @property {number} index Index of the token in sequence
 * @property {string} phonemes Phoneme string for this token
 * @property {number} start_ts Start time in seconds
 * @property {number} end_ts End time in seconds
 */

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
   * Generate audio from text.
   *
   * @param {string} text The input text
   * @param {GenerateOptions} options Additional options
   * @returns {Promise<RawAudio>} The generated audio
   */
  async generate(text, { voice = "af_heart", speed = 1 } = {}) {
    const language = this._validate_voice(voice);

    const phonemes = await phonemize(text, language);
    const { input_ids } = this.tokenizer(phonemes, {
      truncation: true,
    });

    return this.generate_from_ids(input_ids, { voice, speed });
  }

  /**
   * Generate audio and timestamps from text.
   * @param {string} text Input text
   * @param {GenerateOptions} options Options
   * @returns {Promise<{audio: RawAudio, phonemes: string, timestamps: Timestamp[]|null}>}
   */
  async generate_with_timestamps(text, { voice = "af_heart", speed = 1 } = {}) {
    const language = this._validate_voice(voice);
    const phonemes = await phonemize(text, language);
    const { input_ids } = this.tokenizer(phonemes, { truncation: true });
    const { audio, pred_dur } = await this._infer_with_durations(input_ids, { voice, speed });
    const timestamps = pred_dur ? this._join_timestamps_from_phonemes(phonemes, pred_dur) : null;
    return { audio, phonemes, timestamps };
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
   * Generate audio from text in a streaming fashion.
   * @param {string|TextSplitterStream} text The input text
   * @param {StreamGenerateOptions} options Additional options
   * @returns {AsyncGenerator<{text: string, phonemes: string, audio: RawAudio}, void, void>}
   */
  async *stream(text, { voice = "af_heart", speed = 1, split_pattern = null, return_timestamps = false } = {}) {
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
    for await (const sentence of splitter) {
      const phonemes = await phonemize(sentence, language);
      const { input_ids } = this.tokenizer(phonemes, {
        truncation: true,
      });

      // TODO: There may be some cases where - even with splitting - the text is too long.
      // In that case, we should split the text into smaller chunks and process them separately.
      // For now, we just truncate these exceptionally long chunks
      const { audio, pred_dur } = await this._infer_with_durations(input_ids, { voice, speed });
      const timestamps = return_timestamps && pred_dur ? this._join_timestamps_from_phonemes(phonemes, pred_dur) : null;
      yield { text: sentence, phonemes, audio, timestamps };
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
   * Internal: join per-character durations into word-level timestamps based on phoneme string
   * Mirrors python KPipeline.join_timestamps
   * @param {string} phonemes Phoneme string passed to tokenizer
   * @param {number[]} pred_dur Duration predictions per character (+spaces) including <bos>/<eos>
   * @returns {Timestamp[]}
   */
  _join_timestamps_from_phonemes(phonemes, pred_dur) {
    if (!phonemes || !pred_dur || pred_dur.length < 3) return [];

    // Tokenize phonemes by spaces, preserving consecutive spaces as separate counters
    const tokens = [];
    let i = 0;
    while (i < phonemes.length) {
      // Skip any leading spaces (treated as whitespace after previous token)
      let j = i;
      while (j < phonemes.length && phonemes[j] === ' ') j++;
      if (j > i) {
        // Leading spaces; treat as whitespace following previous token (handled implicitly by counting space durations)
        i = j;
        continue;
      }
      // Find end of non-space segment
      j = i;
      while (j < phonemes.length && phonemes[j] !== ' ') j++;
      const seg = phonemes.slice(i, j);
      // Count following single space (if any). Model typically has one space token after words
      let spaceCount = 0;
      let k = j;
      while (k < phonemes.length && phonemes[k] === ' ') { spaceCount++; k++; }

      tokens.push({
        phonemes: seg,
        // Consider tokens that are purely punctuation as having no phonemes
        phoneme_len: seg.split('').filter(ch => !PUNCTUATION_CHARS.includes(ch)).length,
        whitespace: spaceCount > 0,
      });
      i = j + spaceCount;
    }

    // Now join timestamps similar to python
    const results = [];
    let left = 2 * Math.max(0, pred_dur[0] - 3);
    let right = left;
    let p = 1; // skip <bos>
    let idx = 0;
    for (const t of tokens) {
      if (p >= pred_dur.length - 1) break; // leave room for <eos>

      if (t.phoneme_len === 0) {
        // Punctuation (no phonemes). Only advance on space.
        if (t.whitespace && p < pred_dur.length - 1) {
          p += 1; // move to space duration
          left = right + pred_dur[p];
          right = left + pred_dur[p];
          p += 1; // advance past space
        }
        idx++;
        continue;
      }

      const end_idx = p + t.phoneme_len;
      if (end_idx >= pred_dur.length) break;
      const start_ts = left / MAGIC_DIVISOR;
      let token_dur = 0;
      for (let s = p; s < end_idx; s++) token_dur += pred_dur[s];
      const space_dur = t.whitespace && end_idx < pred_dur.length ? pred_dur[end_idx] : 0;
      left = right + (2 * token_dur) + space_dur;
      const end_ts = left / MAGIC_DIVISOR;
      right = left + space_dur;
      results.push({ index: idx, phonemes: t.phonemes, start_ts, end_ts });
      p = end_idx + (t.whitespace ? 1 : 0);
      idx++;
    }
    return results;
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

export { TextSplitterStream };
