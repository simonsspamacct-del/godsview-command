/** Open a URL in the default browser, without dependencies. */

import { spawn } from 'node:child_process';

/** Start the platform's opener. Never throws; returns whether it was launched. */
export function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? // Avoids `cmd /c start`, whose quoting mangles URLs with & or ^.
        ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
