// Renders the finished files: the 16:9 MP4, the 1:1 cut for X and a poster PNG. Run: pnpm render [outDir].
// The default folder is out/ here (ignored by git). Makes the audio first if it isn't there yet.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'out'));
mkdirSync(out, { recursive: true });

const run = (args: string[]): void => {
  execFileSync(join(root, 'node_modules', '.bin', 'remotion'), args, { cwd: root, stdio: 'inherit' });
};

if (!existsSync(join(root, 'public', 'audio', 'music.wav'))) execFileSync(process.execPath, [join(root, 'scripts', 'make-audio.ts')], { stdio: 'inherit' });

const video = ['--codec=h264', '--crf=20', '--pixel-format=yuv420p', '--audio-codec=aac', '--audio-bitrate=192k', '--concurrency=8', '--log=error'];
run(['render', 'src/index.ts', 'Launch', join(out, 'serra-launch.mp4'), ...video]);
run(['render', 'src/index.ts', 'LaunchSquare', join(out, 'serra-launch-square.mp4'), ...video]);
// The poster: the end card, once everything on it has landed.
run(['still', 'src/index.ts', 'Launch', join(out, 'serra-launch-poster.png'), '--frame=850', '--log=error']);

for (const file of ['serra-launch.mp4', 'serra-launch-square.mp4', 'serra-launch-poster.png']) {
  console.log(`${file}  ${(statSync(join(out, file)).size / 1e6).toFixed(1)} MB`);
}
