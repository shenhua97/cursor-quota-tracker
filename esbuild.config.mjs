import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

const copyWasmPlugin = {
  name: 'copy-wasm',
  setup(build) {
    build.onEnd(() => {
      if (!existsSync('dist')) {
        mkdirSync('dist', { recursive: true });
      }
      const src = 'node_modules/sql.js/dist/sql-wasm.wasm';
      if (existsSync(src)) {
        cpSync(src, 'dist/sql-wasm.wasm');
        console.log('Copied sql-wasm.wasm to dist/');
      } else {
        console.warn('Warning: sql-wasm.wasm not found at', src);
      }
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  minify: false,
  plugins: [copyWasmPlugin],
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete');
}
