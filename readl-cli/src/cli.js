const path = require('path');
const { Command, InvalidArgumentError } = require('commander');
const { loadInput } = require('./input-loader');
const { runSynthesis } = require('./synth-runner');
const { listLibraryEntries, deleteLibraryEntry } = require('./library');

function clampSpeed(value) {
  if (!Number.isFinite(value)) return 1;
  const min = 0.5;
  const max = 1.5;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseFloatOption(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new InvalidArgumentError(`${label} must be a number`);
  }
  return num;
}

function resolveAudioDir(optionValue) {
  if (!optionValue) return null;
  const abs = path.resolve(process.cwd(), optionValue);
  process.env.READL_AUDIO_DIR = abs;
  return abs;
}

async function handleSynthCommand(options) {
  resolveAudioDir(options.audioDir);
  const speed = clampSpeed(parseFloatOption(options.speed ?? '1', 'speed'));
  const loadResult = await loadInput({
    text: options.text,
    textFile: options.textFile,
    stdin: options.stdin,
    url: options.url,
    title: options.title,
  });

  const payload = {
    text: loadResult.text,
    voice: options.voice || 'af_heart',
    lang_code: options.lang || 'a',
    speed,
    preview_html: loadResult.metadata.preview_html,
    source_kind: loadResult.metadata.source_kind,
    source_url: loadResult.metadata.source_url,
    raw_content: loadResult.metadata.raw_content,
    raw_content_type: loadResult.metadata.raw_content_type,
    title: options.title || loadResult.metadata.title,
  };

  const result = await runSynthesis(payload, { json: options.json, quiet: options.quiet });
  return result;
}

async function handleLibraryList(options) {
  resolveAudioDir(options.audioDir);
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? options.limit
    : undefined;
  const entries = await listLibraryEntries({ limit, loadMetadata: options.details });
  if (options.json) {
    console.log(JSON.stringify({ ok: true, entries }, null, 2));
    return;
  }
  if (!entries.length) {
    console.log('No saved audios found.');
    return;
  }
  const rows = entries.map((entry) => {
    const duration = typeof entry.duration_seconds === 'number'
      ? `${entry.duration_seconds.toFixed(1)}s`
      : '—';
    const title = entry.title || entry.relPath;
    const voice = entry.voice || '—';
    const source = entry.source_label || '';
    return `${duration.padStart(8)}  ${voice.padEnd(10)}  ${title}${source ? `  (${source})` : ''}`;
  });
  console.log(rows.join('\n'));
}

async function handleLibraryDelete(relPath, options) {
  resolveAudioDir(options.audioDir);
  await deleteLibraryEntry(relPath, { json: options.json, yes: options.yes });
}

function logError(err, opts, prefix) {
  const message = err && err.message ? err.message : String(err);
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: message }));
  } else {
    console.error(`${prefix}: ${message}`);
  }
}

async function run() {
  const program = new Command();
  program
    .name('readl-cli')
    .description('Headless Readl CLI for Kokoro TTS')
    .showHelpAfterError()
    .configureOutput({
      outputError: (str, write) => write(`Error: ${str}`),
    });

  program
    .command('synth')
    .description('Ingest input and synthesize speech with Kokoro')
    .option('--text <value>', 'Text to synthesize')
    .option('--text-file <path>', 'Read text/html/pdf from a file')
    .option('--stdin', 'Read text from STDIN')
    .option('--url <url>', 'Fetch content from a URL')
    .option('--voice <id>', 'Voice id', 'af_heart')
    .option('--lang <code>', 'Language/phoneme set code', 'a')
    .option('--speed <number>', 'Speaking speed between 0.5 and 1.5', '1')
    .option('--title <text>', 'Optional title metadata')
    .option('--audio-dir <path>', 'Override READL audio output directory')
    .option('--json', 'Emit JSON output', false)
    .option('--quiet', 'Suppress progress logs', false)
    .action(async (opts) => {
      try {
        await handleSynthCommand(opts);
      } catch (err) {
        if (!err || !err.__readlAlreadyReported) {
          logError(err, opts, 'Synthesis failed');
        }
        process.exitCode = 1;
      }
    });

  const library = program
    .command('library')
    .description('Manage saved Kokoro outputs');

  library
    .command('list')
    .description('List saved audios')
    .option('--limit <n>', 'Limit number of rows (default: all)', (value) => {
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new InvalidArgumentError('limit must be a positive integer');
      }
      return parsed;
    })
    .option('--details', 'Load align metadata for labels', false)
    .option('--audio-dir <path>', 'Override READL audio directory')
    .option('--json', 'Emit JSON output', false)
    .action(async (opts) => {
      try {
        await handleLibraryList(opts);
      } catch (err) {
        logError(err, opts, 'List failed');
        process.exitCode = 1;
      }
    });

  library
    .command('delete <relPath>')
    .description('Delete a saved audio (and matching alignment)')
    .option('--yes', 'Skip confirmation prompt', false)
    .option('--audio-dir <path>', 'Override READL audio directory')
    .option('--json', 'Emit JSON output', false)
    .action(async (relPath, opts) => {
      try {
        await handleLibraryDelete(relPath, opts);
      } catch (err) {
        logError(err, opts, 'Delete failed');
        process.exitCode = 1;
      }
    });

  if (!process.argv.slice(2).length) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

module.exports = {
  run,
};
