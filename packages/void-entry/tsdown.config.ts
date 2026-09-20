import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const PLUGIN_ID: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  // 宿主提供的运行时模块：绝不能被 bundle 进去。
  // `@deepseek-ai/dsh-client-ui-primitives` 在运行时由宿主的冻结模块表提供（前端 bundle
  // 里按这个名字注册），磁盘上不存在，打包器解析不了——必须外部化，让它以
  // `require("@deepseek-ai/dsh-client-ui-primitives")` 留在产物里，由 __ModuleLoader__
  // 的 require 在浏览器里兑现。类型见 src/client/primitives.d.ts。
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
