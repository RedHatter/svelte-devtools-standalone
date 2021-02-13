import * as fs from 'fs'
import svelte from 'rollup-plugin-svelte'
import resolve from 'rollup-plugin-node-resolve'
import css from 'rollup-plugin-css-only'

import format from './scripts/format.js'
import importRawCss from './scripts/importRawCss.js'

export default [{
  input: 'src/index.js',
  output: {
    file: 'dist/standalone.js',
    name: 'SvelteDevTools',
    format: 'iife',
  },
  plugins: [
    format(),
    svelte({
      preprocess: {
        markup: input => {
          const code = input.content
            .replace(/(>|})\s+(?![^]*?<\/(?:script|style)>|[^<]*?>|[^{]*?})/g, '$1')
            .replace(/(?<!<[^>]*?|{[^}]*?)\s+(<|{)(?![^]*<\/(?:script|style)>)/g, '$1')
          return { code }
        },
      },
    }),
    resolve(),
    importRawCss(),
    css({ output: 'styles.css' })
  ]
}, {
  input: 'test/src/index.js',
  output: {
    file: 'test/public/bundle.js',
    name: 'SvelteDevToolsTest',
    format: 'iife'
  },
  plugins: [
    format(),
    svelte({
      compilerOptions: {
        dev: true
      }
    }),
    resolve(),
    css({ output: 'styles.css' })
  ]
}]
