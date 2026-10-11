/**
 * God's Eye View ("GodsView"): start it next to this app or attach to one
 * already running, track its health, and call its tools over the local MCP
 * endpoint it serves at /mcp (stateless JSON-RPC, one message per POST).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const PROBE_TIMEOUT_MS = 2500;
const START_TIMEOUT_MS = 180_000;
const HEALTH_INTERVAL_MS = 10_000;
const LOG_LINES = 120;

export class GevError extends Error {
  constructor(message, { code = 'unavailable', status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

export class GodsView {
  constructor({ url, dir, autostart, frameAncestors = [], fetchImpl = globalThis.fetch, log = console.log }) {
    this.url = url;
    this.dir = dir;
    this.autostart = autostart;
    this.frameAncestors = frameAncestors;
    this.fetch = fetchImpl;
    this.log = log;
    this.state = 'unknown';
    this.lastError = null;
    this.child = null;
    this.logTail = [];
    this.tools = null;
    this.toolsFetchedAt = 0;
    this.nextId = 1;
    this.timer = null;
  }

  status() {
    return {
      state: this.state,
      url: this.url,
      managed: Boolean(this.child),
      pid: this.child?.pid ?? null,
      dir: this.dir,
      canStart: Boolean(this.dir) && !this.child && this.state !== 'online',
      lastError: this.lastError,
      toolCount: this.tools?.length ?? null,
      log: this.logTail.slice(-40),
    };
  }

  async probe() {
    try {
      const response = await this.fetch(`${this.url}/`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Attach to a running instance, or start one when allowed. */
  async init() {
    if (await this.probe()) {
      this.setOnline();
    } else if (this.dir && this.autostart) {
      this.start().catch((error) => this.log(`[gev] ${error.message}`));
    } else {
      this.state = 'offline';
      this.lastError = this.dir
        ? 'Autostart is off. Start it from the app or run `npm run dev` in the GodsView folder.'
        : `Nothing answers at ${this.url}. Set GEV_DIR so this app can start GodsView, or start it yourself.`;
    }
    this.timer = setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS);
    this.timer.unref?.();
  }

  setOnline() {
    if (this.state !== 'online') this.log(`[gev] online at ${this.url}`);
    this.state = 'online';
    this.lastError = null;
  }

  async checkHealth() {
    if (this.state === 'starting') return;
    if (await this.probe()) this.setOnline();
    else if (this.state === 'online') {
      this.state = 'offline';
      this.lastError = `GodsView stopped answering at ${this.url}`;
      this.tools = null;
    }
  }

  pushLog(chunk) {
    for (const line of stripAnsi(String(chunk)).split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logTail.push(line);
      if (this.logTail.length > LOG_LINES) this.logTail.shift();
    }
  }

  /** Run `npm run dev` in GEV_DIR on the port GEV_URL names. */
  async start() {
    if (this.child || this.state === 'starting') return this.status();
    if (await this.probe()) {
      this.setOnline();
      return this.status();
    }
    if (!this.dir) throw new GevError('GEV_DIR is not set, so GodsView cannot be started from here');
    if (!existsSync(path.join(this.dir, 'package.json')))
      throw new GevError(`No GodsView checkout at ${this.dir}`);
    if (!existsSync(path.join(this.dir, 'node_modules'))) {
      this.state = 'offline';
      this.lastError = `Run \`npm ci\` in ${this.dir} first.`;
      throw new GevError(this.lastError);
    }
    const port = new URL(this.url).port || '80';
    const windows = process.platform === 'win32';
    this.state = 'starting';
    this.lastError = null;
    this.log(`[gev] starting God's Eye View in ${this.dir} on port ${port}`);
    const child = spawn(
      windows ? 'npm.cmd' : 'npm',
      ['run', 'dev', '--', '--port', port, '--strictPort'],
      { cwd: this.dir, env: this.childEnv(port), stdio: ['ignore', 'pipe', 'pipe'], shell: windows },
    );
    this.child = child;
    child.stdout.on('data', (chunk) => this.pushLog(chunk));
    child.stderr.on('data', (chunk) => this.pushLog(chunk));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.tools = null;
      this.state = 'offline';
      this.lastError = `GodsView exited (${signal || `code ${code}`})`;
      this.log(`[gev] ${this.lastError}`);
    });
    child.on('error', (error) => {
      this.lastError = error.message;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && this.child === child) {
      if (await this.probe()) {
        this.setOnline();
        return this.status();
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (this.child === child) {
      this.state = 'offline';
      this.lastError = 'GodsView did not come up in time; see its log';
    }
    return this.status();
  }

  /**
   * GodsView's environment: its own port (it reads PORT and HOST, which are
   * this app's), none of this app's secrets, and permission for this
   * console's origins to frame its embed mode (GEV_EMBED_FRAME_ANCESTORS).
   */
  childEnv(port) {
    const env = { ...process.env, PORT: String(port) };
    delete env.HOST;
    for (const key of Object.keys(env))
      if (key.startsWith('ANTHROPIC_') || key.startsWith('WAZE_') || key === 'NWS_USER_AGENT') delete env[key];
    const allowed = new Set(String(env.GEV_EMBED_FRAME_ANCESTORS || '').split(/\s+/).filter(Boolean));
    if (!allowed.has('*')) for (const origin of this.frameAncestors) allowed.add(origin);
    if (allowed.size) env.GEV_EMBED_FRAME_ANCESTORS = [...allowed].join(' ');
    return env;
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else child.kill('SIGTERM');
  }

  async rpc(method, params, { signal } = {}) {
    if (this.state !== 'online' && !(await this.probe()))
      throw new GevError(`GodsView is not running at ${this.url}`);
    this.setOnline();
    let response;
    try {
      response = await this.fetch(`${this.url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      throw new GevError(`Could not reach GodsView: ${error.message}`);
    }
    if (response.status === 403)
      throw new GevError(
        "GodsView refused the MCP request. Its MCP server only answers this machine's loopback address; keep GEV_URL on localhost.",
        { status: 403 },
      );
    if (!response.ok) throw new GevError(`GodsView MCP answered HTTP ${response.status}`, { status: response.status });
    const message = await response.json();
    if (message.error) throw new GevError(message.error.message || 'MCP error', { code: 'rpc' });
    return message.result;
  }

  async listTools({ signal } = {}) {
    if (this.tools && Date.now() - this.toolsFetchedAt < 300_000) return this.tools;
    const result = await this.rpc('tools/list', {}, { signal });
    this.tools = result.tools || [];
    this.toolsFetchedAt = Date.now();
    return this.tools;
  }

  /**
   * Call a tool. Resolves to `{ summary, data, images, isError }`: the
   * summary line, the structured data, and any images the tool returned.
   */
  async callTool(name, args = {}, { signal } = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args }, { signal });
    const content = result.content || [];
    return {
      summary: content.find((item) => item.type === 'text')?.text ?? '',
      data: result.structuredContent ?? null,
      images: content
        .filter((item) => item.type === 'image')
        .map(({ data, mimeType }) => ({ data, mimeType })),
      isError: result.isError === true,
    };
  }

  /** Call a tool and throw GevError when it reports a failure. */
  async query(name, args, options) {
    const result = await this.callTool(name, args, options);
    if (result.isError)
      throw new GevError(result.summary || `${name} failed`, { code: result.data?.error || 'tool' });
    return result;
  }
}
