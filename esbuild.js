// esbuild 打包：扩展( node/cjs ) + webview( browser/iife，含 wavesurfer )
const esbuild = require('esbuild')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
}

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview/index.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: !production,
  minify: production,
}

async function main() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig)
    const ctxWv = await esbuild.context(webviewConfig)
    await Promise.all([ctxExt.watch(), ctxWv.watch()])
    console.log('[esbuild] watching...')
  } else {
    await esbuild.build(extensionConfig)
    await esbuild.build(webviewConfig)
    console.log('[esbuild] build done')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
