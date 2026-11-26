/**
 * Asset build for the widget.
 *
 * The whole renderer is one JSX entry point and one stylesheet, so a bundler is
 * all that is needed. esbuild does the job in a few tens of milliseconds and
 * pulls in a single native binary, where a full framework toolchain cost
 * hundreds of megabytes of dependencies and tens of seconds per build for output
 * this small.
 *
 * Output is a flat `dist/` directory that Electron loads over file://:
 *
 *   dist/index.html      the document
 *   dist/renderer.js     the bundle (React + the widget, minified)
 *   dist/renderer.css    the extracted stylesheets
 *   dist/character/      the decoded-at-runtime animation frames, copied as-is
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const watch = process.argv.includes('--watch');

/**
 * Electron 33 ships Chromium 130, so there is no point emitting anything older.
 * Pinning the target also keeps esbuild from adding legacy transpilation for
 * browsers this app can never run in.
 */
const TARGET = 'chrome130';

const options = {
  // Named so the output is `renderer.js` / `renderer.css`, which is what
  // `src/index.html` loads.
  entryPoints: { renderer: path.join(src, 'main.tsx') },
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: TARGET,
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  treeShaking: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  // The widget is only ever loaded from disk, so no absolute URLs and no
  // module scripts - both are awkward or blocked over file://.
  assetNames: '[name]',
  loader: { '.png': 'file' },
  alias: { '@': src },
  define: {
    // Lets the bundle drop its development-only branches, exactly as the
    // previous production build did.
    'process.env.NODE_ENV': '"production"',
  },
};

async function copyStatic() {
  await cp(path.join(root, 'public'), dist, { recursive: true });
  await cp(path.join(src, 'index.html'), path.join(dist, 'index.html'));
}

async function report(result) {
  const [file, meta] = Object.entries(result.metafile.outputs)[0] ?? [];
  if (!file || !meta) return;
  const kib = (meta.bytes / 1024).toFixed(1);
  console.log(`renderer bundle: ${path.basename(file)} ${kib} KiB (minified)`);
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  if (watch) {
    const context = await esbuild.context(options);
    await copyStatic();
    await context.watch();
    console.log('watching src/ for changes...');
    return;
  }

  const result = await esbuild.build(options);
  await copyStatic();
  await report(result);

  // Fail loudly rather than shipping a window that loads nothing.
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  if (!html.includes('./renderer.js')) {
    throw new Error('dist/index.html does not reference renderer.js');
  }
  await writeFile(
    path.join(dist, '.build-ok'),
    `built ${new Date().toISOString()}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
