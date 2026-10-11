/**
 * One-step start for GodsView Command. Checks Node.js, installs packages,
 * creates .env, offers to download and install God's Eye View (GodsView),
 * then starts the console, which opens your browser.
 *
 *   node scripts/start.mjs                 interactive setup, then start
 *   node scripts/start.mjs --yes           accept every offer without asking
 *   node scripts/start.mjs --no-godsview   skip the GodsView steps
 *   node scripts/start.mjs --check         set up, start, confirm the page loads, stop
 *   node scripts/start.mjs --setup-only    set up (with --yes: download GodsView too), don't start
 *
 * start.bat (Windows), start.command (macOS) and start.sh (macOS, Linux) run
 * this. It avoids newer syntax so that an old Node can still say it is old.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEV_REPO = 'https://github.com/bilawalsidhu/gods-eye-view.git';
const GEV_ZIP = 'https://github.com/bilawalsidhu/gods-eye-view/archive/refs/heads/main.zip';
const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

const flags = new Set(process.argv.slice(2));
const YES = flags.has('--yes');
const CHECK = flags.has('--check');
const SETUP_ONLY = flags.has('--setup-only');
const SKIP_GEV = flags.has('--no-godsview') || CHECK;
const windows = process.platform === 'win32';
const interactive = Boolean(process.stdin.isTTY) && !YES && !process.env.CI;

function step(text) {
  console.log('\n==> ' + text);
}
function note(text) {
  console.log('    ' + text);
}
function fail(text) {
  console.error('\n[!] ' + text + '\n');
  process.exit(1);
}

function nodeAtLeast(major, minor) {
  const parts = process.versions.node.split('.').map(Number);
  return parts[0] > major || (parts[0] === major && parts[1] >= minor);
}

/**
 * Run a command with its output shown; true when it succeeded. Only npm goes
 * through a shell (on Windows it is npm.cmd, which Node runs only that way);
 * its arguments here never contain spaces. Everything else, such as git with
 * a folder path that may contain spaces, runs directly.
 */
function run(command, args, cwd, extraEnv) {
  const result = spawnSync(command, args, {
    cwd: cwd,
    stdio: 'inherit',
    shell: windows && command === 'npm',
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  return result.status === 0;
}

function available(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: windows && command === 'npm' });
  return result.status === 0;
}

/** KEY=value pairs from a .env file; quotes stripped, comments ignored. */
function readEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

/** Ask a yes/no question. Without a terminal, --yes answers yes and anything else no. */
function ask(question) {
  if (!interactive) return Promise.resolve(YES);
  return new Promise(function (resolve) {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    prompt.question('    ' + question + ' [Y/n] ', function (answer) {
      prompt.close();
      resolve(!/^\s*n/i.test(answer));
    });
  });
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function setUpGodsView(env) {
  if (env.GEV_AUTOSTART === '0') {
    note('GEV_AUTOSTART=0: start GodsView yourself (see README).');
    return;
  }
  const gevUrl = env.GEV_URL || 'http://localhost:4173';
  if (await answers(gevUrl)) {
    note('GodsView is already running at ' + gevUrl + '.');
    return;
  }
  if (!env.GEV_DIR) {
    note('GEV_DIR is not set in .env, so the console will not start GodsView.');
    return;
  }
  const dir = path.resolve(ROOT, env.GEV_DIR);
  const modern = nodeAtLeast(24, 14);

  if (!existsSync(path.join(dir, 'package.json'))) {
    step("GodsView (God's Eye View) is not downloaded yet");
    note('It powers the 3D globe, the CCTV and ALPR layers and the briefs.');
    note('The live map, weather and Waze work without it.');
    if (!(await ask('Download it into ' + dir + ' now?'))) {
      note('Skipped. Run this again any time to download it.');
      return;
    }
    if (!available('git')) {
      note('Git is not installed, so it cannot be downloaded from here. Either install Git');
      note('(https://git-scm.com/downloads) and run this again, or download ' + GEV_ZIP + ',');
      note('unzip it, and rename the folder to ' + dir);
      return;
    }
    if (!run('git', ['clone', '--depth', '1', GEV_REPO, dir], ROOT)) {
      note('The download failed; check your internet connection. The console will start without GodsView.');
      return;
    }
  }

  if (!existsSync(path.join(dir, 'node_modules'))) {
    if (!modern) {
      step('GodsView needs Node.js 24.14 or later; this is ' + process.version);
      note('Install the current LTS from ' + NODE_DOWNLOAD + ' and run this again to set GodsView up.');
      note('The console will start without it.');
      return;
    }
    step("Installing GodsView's packages (first time only, a few minutes)");
    if (!(await ask('Install them now?'))) {
      note('Skipped. Run this again any time to install them.');
      return;
    }
    // GodsView uses Puppeteer's browser only for its own QA scripts.
    if (!run('npm', ['ci', '--no-audit', '--no-fund'], dir, { PUPPETEER_SKIP_DOWNLOAD: '1' })) {
      note('Installing GodsView failed; see the messages above. The console will start without it.');
      return;
    }
  } else if (!modern) {
    note('GodsView needs Node.js 24.14 or later (this is ' + process.version + '), so it may not start.');
  }
  note('GodsView is ready; the console starts it for you.');
}

async function check(port) {
  step('Checking that the console starts');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { OPEN_BROWSER: '0', GEV_AUTOSTART: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', function (chunk) {
    output += chunk;
  });
  child.stderr.on('data', function (chunk) {
    output += chunk;
  });
  const base = 'http://127.0.0.1:' + port;
  let ok = false;
  for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt += 1) {
    await new Promise(function (resolve) {
      setTimeout(resolve, 250);
    });
    if ((await answers(base + '/api/status')) && (await answers(base + '/'))) {
      ok = true;
      break;
    }
  }
  child.kill();
  if (!ok) fail('The console did not start. Its output was:\n' + output);
  note('OK: ' + base + '/ loads.');
}

async function main() {
  if (!nodeAtLeast(20, 12))
    fail(
      'GodsView Command needs Node.js 20.12 or later, and GodsView needs 24.14 or later.\n' +
        '    This computer has ' + process.version + '. Install the current LTS from ' + NODE_DOWNLOAD + ',\n' +
        '    then close this window and start again.',
    );
  process.chdir(ROOT);

  if (!existsSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'))) {
    step('Installing packages (first run only)');
    const install = existsSync(path.join(ROOT, 'package-lock.json')) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    if (!run('npm', install, ROOT)) fail('npm could not install the packages. Check your internet connection and the messages above.');
  }

  if (!existsSync(path.join(ROOT, '.env'))) {
    copyFileSync(path.join(ROOT, '.env.example'), path.join(ROOT, '.env'));
    step('Created .env with the default settings');
  }
  const env = Object.assign(readEnvFile(path.join(ROOT, '.env')), process.env);

  if (!SKIP_GEV) await setUpGodsView(env);

  const port = Number.parseInt(env.PORT || '5050', 10);
  if (SETUP_ONLY) {
    step('Setup finished');
    return;
  }
  if (CHECK) {
    await check(port);
    return;
  }

  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN)
    note('Optional: put your Anthropic API key in .env (ANTHROPIC_API_KEY=...) to use the AI analyst.');
  if (!env.NWS_USER_AGENT || /you@example\.com/.test(env.NWS_USER_AGENT))
    note('Optional: put your email in NWS_USER_AGENT in .env, as the weather service asks.');

  step('Starting GodsView Command');
  await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
}

main().catch(function (error) {
  fail(error && error.stack ? error.stack : String(error));
});
