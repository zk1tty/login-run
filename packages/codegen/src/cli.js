const { runDemo } = require('./demo');

function createCliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseFlagValue(argv, index, name) {
  const current = argv[index];
  const equalsPrefix = `${name}=`;
  if (current.startsWith(equalsPrefix)) {
    return {
      value: current.slice(equalsPrefix.length),
      nextIndex: index,
    };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw createCliError(`Missing value for ${name}.`);
  }

  return {
    value,
    nextIndex: index + 1,
  };
}

function parseArgs(argv = []) {
  const input = [...argv];
  const command = input[0] && !input[0].startsWith('-') ? input.shift() : 'help';
  const options = {
    command,
    site: 'healthequity',
    out: './loginrun',
    help: false,
  };

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--site' || arg.startsWith('--site=')) {
      const parsed = parseFlagValue(input, index, '--site');
      options.site = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const parsed = parseFlagValue(input, index, '--out');
      options.out = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    throw createCliError(`Unknown argument: ${arg}`);
  }

  return options;
}

function usageText() {
  return [
    'LoginRun Codegen',
    '',
    'Usage:',
    '  npx @loginrun/codegen demo',
    '  npx @loginrun/codegen demo --out ./loginrun',
    '  npx @loginrun/codegen demo --site healthequity',
    '',
    'V1 supports mock demo mode only. It does not submit credentials or call LoginRun APIs.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || (line => console.log(line));
  const options = parseArgs(argv);

  if (options.help || options.command === 'help') {
    stdout(usageText());
    return {
      status: 'help',
    };
  }

  if (options.command !== 'demo') {
    throw createCliError(
      `Unsupported command: ${options.command}. V1 supports "demo" only.`
    );
  }

  return runDemo({
    site: options.site,
    out: options.out,
    cwd: io.cwd || process.cwd(),
    stdout,
  });
}

module.exports = {
  main,
  parseArgs,
  usageText,
};
