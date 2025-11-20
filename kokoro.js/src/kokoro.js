import { env as hf, StyleTextToSpeech2Model, AutoTokenizer, Tensor, RawAudio } from "@huggingface/transformers";
import { phonemizeDetailed } from "./phonemize.js";
import { TextSplitterStream } from "./splitter.js";
import { getVoiceData, VOICES } from "./voices.js";

const STYLE_DIM = 256;
const SAMPLE_RATE = 24000;
const MAGIC_DIVISOR = 80;
const MAX_PHONEME_COUNT = 500;
const MAX_SEQUENCE_TOKEN_LENGTH = 500;
const MIN_SPLIT_PHONEMES = 64;
const WATERFALL_BREAKS = ['!.?…', ':;', ',—'];
const WATERFALL_BUMPS = new Set([')', '”']);

const tokenSymbol = (token) => {
  if (!token) return "";
  if (token.phonemes && token.phonemes.length > 0) {
    return token.phonemes.length === 1 ? token.phonemes : "";
  }
  return token.text && token.text.length === 1 ? token.text : "";
};

const phonemeOrText = (token) => {
  if (!token) return "";
  if (token.phonemes && token.phonemes.length > 0) {
    return token.phonemes;
  }
  return token.text ?? "";
};

const tokensToPhonemeString = (tokens) =>
  tokens
    .map((token) => `${phonemeOrText(token)}${token?.whitespace ? " " : ""}`)
    .join("")
    .trim();

const tokensToTextString = (tokens) =>
  tokens
    .map((token) => `${token?.text ?? ""}${token?.whitespace ? " " : ""}`)
    .join("")
    .trim();

const getChunkDurationSeconds = (tokens) => {
  let duration = 0;
  for (const token of tokens) {
    if (token?.end_ts != null && token.end_ts > duration) {
      duration = token.end_ts;
    }
  }
  return duration;
};

const offsetTokenTimestamps = (tokens, offsetSeconds) => {
  if (!offsetSeconds) return;
  for (const token of tokens) {
    if (token?.start_ts != null) {
      token.start_ts += offsetSeconds;
    }
    if (token?.end_ts != null) {
      token.end_ts += offsetSeconds;
    }
  }
};

const waterfallLastIndex = (tokens, nextCount, maxCount = MAX_PHONEME_COUNT) => {
  for (const group of WATERFALL_BREAKS) {
    const symbols = new Set(Array.from(group));
    let idx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const symbol = tokenSymbol(tokens[i]);
      if (symbol && symbols.has(symbol)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) continue;
    let z = idx + 1;
    if (z < tokens.length) {
      const bumpSymbol = tokenSymbol(tokens[z]);
      if (bumpSymbol && WATERFALL_BUMPS.has(bumpSymbol)) {
        z += 1;
      }
    }
    const leftCount = tokensToPhonemeString(tokens.slice(0, z)).length;
    if (nextCount - leftCount <= maxCount) {
      return z;
    }
  }
  return tokens.length;
};

const chunkEnglishTokens = (tokens, maxCount = MAX_PHONEME_COUNT) => {
  const chunks = [];
  let buffer = [];
  let pcount = 0;

  for (const token of tokens) {
    let nextPs = `${phonemeOrText(token)}${token?.whitespace ? " " : ""}`;
    const nextCount = pcount + nextPs.trimEnd().length;
    if (nextCount > maxCount && buffer.length > 0) {
      let sliceIndex = waterfallLastIndex(buffer, nextCount, maxCount);
      if (sliceIndex === 0) {
        sliceIndex = buffer.length;
      }
      const chunkTokens = buffer.slice(0, sliceIndex);
      chunks.push({
        tokens: chunkTokens,
        phonemes: tokensToPhonemeString(chunkTokens),
        text: tokensToTextString(chunkTokens),
      });
      buffer = buffer.slice(sliceIndex);
      pcount = tokensToPhonemeString(buffer).length;
      if (buffer.length === 0) {
        nextPs = nextPs.trimStart();
      }
    }
    buffer.push(token);
    pcount += nextPs.length;
  }

  if (buffer.length > 0) {
    chunks.push({
      tokens: buffer.slice(),
      phonemes: tokensToPhonemeString(buffer),
      text: tokensToTextString(buffer),
    });
  }

  return chunks;
};

const fallbackSplitChunk = (chunk) => {
  if (!chunk?.tokens?.length) {
    return [];
  }
  const mid = Math.max(1, Math.floor(chunk.tokens.length / 2));
  const left = chunk.tokens.slice(0, mid);
  const right = chunk.tokens.slice(mid);
  return [left, right]
    .filter((segment) => segment.length)
    .map((segment) => ({
      tokens: segment,
      phonemes: tokensToPhonemeString(segment),
      text: tokensToTextString(segment),
    }));
};

const prepareChunksForInference = (chunks, tokenizer) => {
  const ready = [];
  const queue = [...chunks];
  while (queue.length) {
    const chunk = queue.shift();
    if (!chunk || !chunk.phonemes) {
      continue;
    }
    let chunkPhonemes = chunk.phonemes;
    if (chunkPhonemes.length > MAX_PHONEME_COUNT) {
      console.warn(`[kokoro] Unexpected chunk phoneme length ${chunkPhonemes.length} (> ${MAX_PHONEME_COUNT}). Truncating to ${MAX_PHONEME_COUNT}.`);
      chunkPhonemes = chunkPhonemes.slice(0, MAX_PHONEME_COUNT);
      chunk.phonemes = chunkPhonemes;
    }
    const encoded = tokenizer(chunkPhonemes, { truncation: false });
    const sequenceLength = encoded.input_ids.dims.at(-1);
    if (sequenceLength <= MAX_SEQUENCE_TOKEN_LENGTH) {
      ready.push({ chunk, input_ids: encoded.input_ids });
      continue;
    }
    const tokenCount = chunk.tokens?.length ?? 0;
    if (tokenCount <= 1) {
      console.warn(`[kokoro] Token sequence ${sequenceLength} exceeded ${MAX_SEQUENCE_TOKEN_LENGTH} but cannot be split further. Truncating.`);
      const truncated = tokenizer(chunkPhonemes, { truncation: true, max_length: MAX_SEQUENCE_TOKEN_LENGTH });
      ready.push({ chunk, input_ids: truncated.input_ids });
      continue;
    }
    const reducedMax = Math.max(MIN_SPLIT_PHONEMES, Math.floor(chunkPhonemes.length / 2));
    console.warn(`[kokoro] Chunk produced ${sequenceLength} tokens (> ${MAX_SEQUENCE_TOKEN_LENGTH}). Splitting with max phonemes ${reducedMax}.`);
    const smallerChunks = chunkEnglishTokens(chunk.tokens, reducedMax);
    if (smallerChunks.length === 0) {
      const fallbacks = fallbackSplitChunk(chunk);
      if (fallbacks.length === 0) {
        const truncated = tokenizer(chunkPhonemes, { truncation: true, max_length: MAX_SEQUENCE_TOKEN_LENGTH });
        ready.push({ chunk, input_ids: truncated.input_ids });
      } else {
        queue.unshift(...fallbacks);
      }
    } else {
      queue.unshift(...smallerChunks);
    }
  }
  return ready;
};

const concatAudioSegments = (audios) => {
  const valid = audios.filter((audio) => audio);
  if (valid.length === 0) {
    return null;
  }
  if (valid.length === 1) {
    return valid[0];
  }
  const total = valid.reduce((sum, audio) => sum + audio.audio.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const audio of valid) {
    merged.set(audio.audio, offset);
    offset += audio.audio.length;
  }
  return new RawAudio(merged, SAMPLE_RATE);
};

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
   * @param {import("onnxruntime-common").InferenceSession.SessionOptions} [options.session_options] Optional ONNX Runtime session options to control execution behavior.
   * @returns {Promise<KokoroTTS>} The loaded model
   */
  static async from_pretrained(
    model_id,
    {
      dtype = "fp32",
      device = null,
      progress_callback = null,
      session_options = {},
    } = {},
  ) {
    const model = StyleTextToSpeech2Model.from_pretrained(model_id, {
      progress_callback,
      dtype,
      device,
      session_options,
    });
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
    console.info(`[kokoro] Phonemized text length=${text.length}, phonemes=${phonemes.length}, tokens=${tokens.length}`);

    const tokenCopies = tokens.map((token) => ({
      ...token,
      start_ts: token.start_ts ?? null,
      end_ts: token.end_ts ?? null,
    }));
    const chunks = chunkEnglishTokens(tokenCopies);
    const synthesisPlan = chunks.length
      ? chunks
      : [{ tokens: tokenCopies, phonemes, text: text.trim() }];

    const audioSegments = [];
    let combinedPredDur = null;
    let offsetSeconds = 0;

    const preparedChunks = prepareChunksForInference(synthesisPlan, this.tokenizer);
    for (const { chunk, input_ids } of preparedChunks) {
      if (!chunk?.phonemes) {
        continue;
      }
      console.info(`[kokoro] Chunking text length=${chunk.text.length}, phonemes=${chunk.phonemes.length}, tokens=${chunk.tokens.length}`);
      const { audio, pred_dur } = await this._infer_with_durations(input_ids, { voice, speed });
      audioSegments.push(audio);
      if (pred_dur) {
        this._join_timestamps(chunk.tokens, pred_dur);
        const chunkDuration = getChunkDurationSeconds(chunk.tokens);
        offsetTokenTimestamps(chunk.tokens, offsetSeconds);
        offsetSeconds += chunkDuration;
        if (synthesisPlan.length === 1) {
          combinedPredDur = pred_dur;
        }
      }
    }

    const mergedAudio = concatAudioSegments(audioSegments);

    return new KokoroResult({
      graphemes: text,
      phonemes,
      tokens: tokenCopies,
      audio: mergedAudio,
      pred_dur: combinedPredDur,
      text_index: 0,
    });
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
  async *stream(text, { voice = "af_heart", speed = 1, split_pattern = null } = {}) {
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
    let textIndex = 0;
    for await (const sentence of splitter) {
      if (!sentence?.trim()) {
        continue;
      }
      const { phonemes, tokens } = await phonemizeDetailed(sentence, language);
      const tokenCopies = tokens.map((token) => ({
        ...token,
        start_ts: token.start_ts ?? null,
        end_ts: token.end_ts ?? null,
      }));
      const chunks = chunkEnglishTokens(tokenCopies);
      const synthesisPlan = chunks.length
        ? chunks
        : [{ tokens: tokenCopies, phonemes, text: sentence.trim() }];

      const preparedChunks = prepareChunksForInference(synthesisPlan, this.tokenizer);
      for (const { chunk, input_ids } of preparedChunks) {
        if (!chunk?.phonemes) {
          continue;
        }
        const { audio, pred_dur } = await this._infer_with_durations(input_ids, { voice, speed });
        if (pred_dur) {
          this._join_timestamps(chunk.tokens, pred_dur);
        }
        yield new KokoroResult({
          graphemes: chunk.text || sentence,
          phonemes: chunk.phonemes,
          tokens: chunk.tokens.map((token) => ({
            ...token,
            start_ts: token.start_ts ?? null,
            end_ts: token.end_ts ?? null,
          })),
          audio,
          pred_dur,
          text_index: textIndex,
        });
      }
      textIndex += 1;
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
    const sequenceLength = input_ids.dims.at(-1);
    const num_tokens = Math.min(Math.max(sequenceLength - 2, 0), 509);

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
    const waveform = outputs.waveform ?? outputs['audio'];
    const audio = new RawAudio(waveform.data, SAMPLE_RATE);

    const durTensor = outputs.pred_dur;
    let pred_dur = null;
    if (durTensor?.data) {
      const arr = Array.from(durTensor.data);
      // Convert BigInt -> Number if required
      pred_dur = arr.map((x) => (typeof x === 'bigint' ? Number(x) : Number(x)));
    }
    return { audio, pred_dur };
  }

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

export { TextSplitterStream, KokoroResult, phonemizeDetailed };
