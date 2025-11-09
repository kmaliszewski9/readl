import { phonemize as espeakng } from "phonemizer";

/**
 * Helper function to split a string on a regex, but keep the delimiters.
 * This is required, because the JavaScript `.split()` method does not keep the delimiters,
 * and wrapping in a capturing group causes issues with existing capturing groups (due to nesting).
 * @param {string} text The text to split.
 * @param {RegExp} regex The regex to split on.
 * @returns {{match: boolean; text: string}[]} The split string.
 */
function split(text, regex) {
  const result = [];
  let prev = 0;
  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    if (prev < match.index) {
      result.push({ match: false, text: text.slice(prev, match.index) });
    }
    if (fullMatch.length > 0) {
      result.push({ match: true, text: fullMatch });
    }
    prev = match.index + fullMatch.length;
  }
  if (prev < text.length) {
    result.push({ match: false, text: text.slice(prev) });
  }
  return result;
}

/**
 * Helper function to split numbers into phonetic equivalents
 * @param {string} match The matched number
 * @returns {string} The phonetic equivalent
 */
function split_num(match) {
  if (match.includes(".")) {
    return match;
  } else if (match.includes(":")) {
    let [h, m] = match.split(":").map(Number);
    if (m === 0) {
      return `${h} o'clock`;
    } else if (m < 10) {
      return `${h} oh ${m}`;
    }
    return `${h} ${m}`;
  }
  let year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) {
    return match;
  }
  let left = match.slice(0, 2);
  let right = parseInt(match.slice(2, 4), 10);
  let suffix = match.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) {
      return `${left} hundred${suffix}`;
    } else if (right < 10) {
      return `${left} oh ${right}${suffix}`;
    }
  }
  return `${left} ${right}${suffix}`;
}

/**
 * Helper function to format monetary values
 * @param {string} match The matched currency
 * @returns {string} The formatted currency
 */
function flip_money(match) {
  const bill = match[0] === "$" ? "dollar" : "pound";
  if (isNaN(Number(match.slice(1)))) {
    return `${match.slice(1)} ${bill}s`;
  } else if (!match.includes(".")) {
    let suffix = match.slice(1) === "1" ? "" : "s";
    return `${match.slice(1)} ${bill}${suffix}`;
  }
  const [b, c] = match.slice(1).split(".");
  const d = parseInt(c.padEnd(2, "0"), 10);
  let coins = match[0] === "$" ? (d === 1 ? "cent" : "cents") : d === 1 ? "penny" : "pence";
  return `${b} ${bill}${b === "1" ? "" : "s"} and ${d} ${coins}`;
}

/**
 * Helper function to process decimal numbers
 * @param {string} match The matched number
 * @returns {string} The formatted number
 */
function point_num(match) {
  let [a, b] = match.split(".");
  return `${a} point ${b.split("").join(" ")}`;
}

/**
 * Normalize text for phonemization
 * @param {string} text The text to normalize
 * @returns {string} The normalized text
 */
function normalize_text(text) {
  return (
    text
      // 1. Handle quotes and brackets
      .replace(/[‘’]/g, "'")
      .replace(/«/g, "“")
      .replace(/»/g, "”")
      .replace(/[“”]/g, '"')
      .replace(/\(/g, "«")
      .replace(/\)/g, "»")

      // 2. Replace uncommon punctuation marks
      .replace(/、/g, ", ")
      .replace(/。/g, ". ")
      .replace(/！/g, "! ")
      .replace(/，/g, ", ")
      .replace(/：/g, ": ")
      .replace(/；/g, "; ")
      .replace(/？/g, "? ")

      // 3. Whitespace normalization
      .replace(/[^\S \n]/g, " ")
      .replace(/  +/, " ")
      .replace(/(?<=\n) +(?=\n)/g, "")

      // 4. Abbreviations
      .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
      .replace(/\betc\.(?! [A-Z])/gi, "etc")

      // 5. Normalize casual words
      .replace(/\b(y)eah?\b/gi, "$1e'a")

      // 5. Handle numbers and currencies
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, split_num)
      .replace(/(?<=\d),(?=\d)/g, "")
      .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flip_money)
      .replace(/\d*\.\d+/g, point_num)
      .replace(/(?<=\d)-(?=\d)/g, " to ")
      .replace(/(?<=\d)S/g, " S")

      // 6. Handle possessives
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, "s")

      // 7. Handle hyphenated words/letters
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")

      // 8. Strip leading and trailing whitespace
      .trim()
  );
}

/**
 * Escapes regular expression special characters from a string by replacing them with their escaped counterparts.
 *
 * @param {string} string The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${escapeRegExp(PUNCTUATION)}]+\\s*)+`, "g");

/**
 * @typedef {Object} PhonemeToken
 * @property {string} text Original token text (word or punctuation)
 * @property {string} phonemes Phoneme sequence for this token (empty for punctuation)
 * @property {boolean} whitespace Whether the original token was followed by whitespace
 * @property {number | null} [start_ts] Start timestamp in seconds (filled later)
 * @property {number | null} [end_ts] End timestamp in seconds (filled later)
 * @property {"word"|"punctuation"} [type] Internal token type
 * @property {string} [leadingWhitespace] Internal: whitespace preceding this token
 * @property {string} [trailingWhitespace] Internal: whitespace following this token
 */

/**
 * Apply per-token phoneme post-processing to align with Python pipeline.
 * @param {string} phonemes
 * @param {"a"|"b"} language
 * @returns {string}
 */
function postProcessPhonemes(phonemes, language) {
  let processed = phonemes
    // https://en.wiktionary.org/wiki/kokoro#English
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (language === "a") {
    processed = processed.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  }
  return processed;
}

/**
 * Split a punctuation-free section into words along with their surrounding whitespace.
 * @param {string} text Section text without punctuation
 * @returns {{text: string, leadingWhitespace: string, trailingWhitespace: string}[]}
 */
function extractWordSegments(text) {
  const segments = [];
  const length = text.length;
  let cursor = 0;
  let initialWhitespace = "";

  while (cursor < length && /\s/.test(text[cursor])) {
    initialWhitespace += text[cursor++];
  }

  while (cursor < length) {
    let word = "";
    while (cursor < length && !/\s/.test(text[cursor])) {
      word += text[cursor++];
    }

    if (!word) {
      // Defensive: skip unexpected whitespace-only fragments
      cursor++;
      continue;
    }

    let trailingWhitespace = "";
    while (cursor < length && /\s/.test(text[cursor])) {
      trailingWhitespace += text[cursor++];
    }

    segments.push({
      text: word,
      leadingWhitespace: segments.length === 0 ? initialWhitespace : "",
      trailingWhitespace,
    });
  }

  return segments;
}


const wordPhonemeCache = new Map();

async function phonemizeWord(word, lang) {
  if (!word) return "";
  const key = `${lang}::${word}`;
  if (wordPhonemeCache.has(key)) {
    return wordPhonemeCache.get(key);
  }
  const [raw] = await espeakng(word, lang);
  const phoneme = (raw ?? "").trim();
  wordPhonemeCache.set(key, phoneme);
  return phoneme;
}

async function buildWordTokens(text, lang) {
  const segments = extractWordSegments(text);
  if (!segments.length) {
    return { tokens: [], raw: "" };
  }

  const tokens = /** @type {PhonemeToken[]} */ ([]);
  let raw = "";

  for (const segment of segments) {
    if (!segment.text) {
      raw += segment.leadingWhitespace;
      continue;
    }
    const phoneme = await phonemizeWord(segment.text, lang);
    const trailingWhitespace = segment.trailingWhitespace ?? "";
    const leadingWhitespace = segment.leadingWhitespace ?? "";

    tokens.push({
      type: /** @type {"word"} */ ("word"),
      text: segment.text,
      phonemes: phoneme,
      whitespace: trailingWhitespace.length > 0,
      leadingWhitespace,
      trailingWhitespace,
      start_ts: null,
      end_ts: null,
    });

    raw += `${leadingWhitespace}${phoneme}${trailingWhitespace}`;
  }

  return { tokens, raw };
}

/**
 * Build punctuation tokens from a punctuation section.
 * @param {string} text Section containing punctuation (and optional whitespace)
 * @returns {PhonemeToken[]}
 */
function buildPunctuationTokens(text) {
  const tokens = /** @type {PhonemeToken[]} */ ([]);
  const length = text.length;
  let cursor = 0;

  while (cursor < length) {
    let leadingWhitespace = "";
    while (cursor < length && /\s/.test(text[cursor])) {
      leadingWhitespace += text[cursor++];
    }
    if (cursor >= length) {
      if (leadingWhitespace && tokens.length) {
        tokens[tokens.length - 1].trailingWhitespace += leadingWhitespace;
        tokens[tokens.length - 1].whitespace = tokens[tokens.length - 1].trailingWhitespace.length > 0;
      }
      break;
    }

    let punct = "";
    while (cursor < length && !/\s/.test(text[cursor])) {
      punct += text[cursor++];
    }

    let trailingWhitespace = "";
    while (cursor < length && /\s/.test(text[cursor])) {
      trailingWhitespace += text[cursor++];
    }

    tokens.push({
      type: /** @type {"punctuation"} */ ("punctuation"),
      text: punct,
      phonemes: "",
      whitespace: trailingWhitespace.length > 0,
      leadingWhitespace,
      trailingWhitespace,
      start_ts: null,
      end_ts: null,
    });
  }

  return tokens;
}

/**
 * Remove a given number of leading spaces from the token sequence.
 * This keeps phoneme strings and whitespace metadata in sync when trimming.
 * @param {PhonemeToken[]} tokens
 * @param {number} count
 */
function consumeLeadingSpaces(tokens, count) {
  let remaining = count;
  for (const token of tokens) {
    if (remaining <= 0) break;
    if (token.leadingWhitespace) {
      const removal = Math.min(token.leadingWhitespace.length, remaining);
      token.leadingWhitespace = token.leadingWhitespace.slice(removal);
      remaining -= removal;
    }
    if (remaining <= 0) break;
    if (token.phonemes) {
      const match = token.phonemes.match(/^ +/);
      if (match) {
        const removal = Math.min(match[0].length, remaining);
        token.phonemes = token.phonemes.slice(removal);
        remaining -= removal;
      }
    }
    if (remaining <= 0) break;
    if (token.trailingWhitespace) {
      const removal = Math.min(token.trailingWhitespace.length, remaining);
      token.trailingWhitespace = token.trailingWhitespace.slice(removal);
      token.whitespace = token.trailingWhitespace.length > 0;
      remaining -= removal;
    }
  }
}

/**
 * Remove a given number of trailing spaces from the token sequence.
 * @param {PhonemeToken[]} tokens
 * @param {number} count
 */
function consumeTrailingSpaces(tokens, count) {
  let remaining = count;
  for (let idx = tokens.length - 1; idx >= 0 && remaining > 0; idx--) {
    const token = tokens[idx];

    if (token.trailingWhitespace) {
      const removal = Math.min(token.trailingWhitespace.length, remaining);
      token.trailingWhitespace = token.trailingWhitespace.slice(0, token.trailingWhitespace.length - removal);
      token.whitespace = token.trailingWhitespace.length > 0;
      remaining -= removal;
    }
    if (remaining <= 0) break;

    if (token.phonemes) {
      const match = token.phonemes.match(/ +$/);
      if (match) {
        const removal = Math.min(match[0].length, remaining);
        token.phonemes = token.phonemes.slice(0, token.phonemes.length - removal);
        remaining -= removal;
      }
    }
    if (remaining <= 0) break;

    if (token.leadingWhitespace) {
      const removal = Math.min(token.leadingWhitespace.length, remaining);
      token.leadingWhitespace = token.leadingWhitespace.slice(0, token.leadingWhitespace.length - removal);
      remaining -= removal;
    }
  }
}

/**
 * Reconstruct phoneme string from token metadata.
 * @param {PhonemeToken[]} tokens
 * @returns {string}
 */
function buildPhonemeString(tokens) {
  let builder = "";
  for (const token of tokens) {
    if (token.leadingWhitespace) {
      builder += token.leadingWhitespace;
    }
    builder += token.type === "punctuation" ? token.text : token.phonemes;
    if (token.trailingWhitespace) {
      builder += token.trailingWhitespace;
    } else if (token.whitespace && token.type !== "punctuation") {
      builder += " ";
    }
  }
  return builder;
}

/**
 * Phonemize text and return both the phoneme string and token metadata.
 * @param {string} text The text to phonemize
 * @param {"a"|"b"} language Language key ("a" → American English, "b" → British English)
 * @param {boolean} norm Whether to normalize the text prior to phonemization
 * @returns {Promise<{phonemes: string, tokens: PhonemeToken[]}>}
 */
export async function phonemizeDetailed(text, language = "a", norm = true) {
  if (norm) {
    text = normalize_text(text);
  }

  const sections = split(text, PUNCTUATION_PATTERN);
  const lang = language === "a" ? "en-us" : "en";
  const tokens = /** @type {PhonemeToken[]} */ ([]);
  const rawPieces = [];

  for (const section of sections) {
    if (section.match) {
      rawPieces.push(section.text);
      tokens.push(...buildPunctuationTokens(section.text));
    } else {
      const { tokens: wordTokens, raw } = await buildWordTokens(section.text, lang);
      rawPieces.push(raw);
      tokens.push(...wordTokens);
    }
  }

  const rawPhonemeString = rawPieces.join("");
  const processedString = postProcessPhonemes(rawPhonemeString, language);

  tokens.forEach((token) => {
    if (token.phonemes) {
      token.phonemes = postProcessPhonemes(token.phonemes, language);
    }
  });

  const trimmedStart = processedString.length - processedString.trimStart().length;
  const trimmedEnd = processedString.length - processedString.trimEnd().length;

  if (trimmedStart > 0) {
    consumeLeadingSpaces(tokens, trimmedStart);
  }
  if (trimmedEnd > 0) {
    consumeTrailingSpaces(tokens, trimmedEnd);
  }

  const phonemeString = buildPhonemeString(tokens).trim();

  const publicTokens = tokens.map((token) => ({
    text: token.text,
    phonemes: token.phonemes,
    whitespace: (token.trailingWhitespace ?? "").length > 0,
    start_ts: token.start_ts,
    end_ts: token.end_ts,
  }));

  return {
    phonemes: phonemeString,
    tokens: publicTokens,
  };
}

/**
 * Phonemize text using the eSpeak-NG phonemizer (string-only helper)
 * @param {string} text The text to phonemize
 * @param {"a"|"b"} language The language to use
 * @param {boolean} norm Whether to normalize the text
 * @returns {Promise<string>} The phonemized text
 */
export async function phonemize(text, language = "a", norm = true) {
  const { phonemes } = await phonemizeDetailed(text, language, norm);
  return phonemes;
}
