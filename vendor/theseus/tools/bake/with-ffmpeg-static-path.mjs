import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static');
const ffmpegDirectory = path.dirname(ffmpegPath);
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('Usage: node tools/bake/with-ffmpeg-static-path.mjs <command> [...args]');
  process.exit(1);
}

const env = {
  ...process.env,
  PATH: `${ffmpegDirectory}${path.delimiter}${process.env.PATH || ''}`,
};

const child = spawn(command, args, {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
