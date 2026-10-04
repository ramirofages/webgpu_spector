// Bundles the extension into dist/ (load that folder via chrome://extensions → "Load unpacked").
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

function copyStatic()
{
  fs.mkdirSync(outdir, { recursive: true });
  fs.cpSync('static', outdir, { recursive: true });
}

const copyPlugin = {
  name: 'copy-static',
  setup(build)
  {
    build.onEnd(() => copyStatic());
  }
};

const options = {
  entryPoints: [
    { in: 'src/hook/index.ts', out: 'hook' },
    { in: 'src/content/content.ts', out: 'content' },
    { in: 'src/background/background.ts', out: 'background' },
    { in: 'src/popup/popup.ts', out: 'popup' },
    { in: 'src/result/result.ts', out: 'result' },
    { in: 'src/devbridge/devbridge.ts', out: 'devbridge' }
  ],
  bundle: true,
  outdir,
  format: 'iife',
  target: 'chrome120',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
  plugins: [copyPlugin]
};

if (watch)
{
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
else
{
  fs.rmSync(outdir, { recursive: true, force: true });
  await esbuild.build(options);
}
