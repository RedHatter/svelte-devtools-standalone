# Svelte DevTools Standalone

**Svelte devtools is actively maintained. If you have any problems or feature requests feel free to create an issue.**

Svelte Devtools Standalone is the browser agnostic version of the [Svelte DevTools](https://github.com/RedHatter/svelte-devtools) browser extension. It allows you to inspect the [Svelte](https://svelte.dev) state and component hierarchies in a popup window.

**Requires svelte version 3.12.0 or above**

![1.1.0 Screenshot](https://raw.githubusercontent.com/RedHatter/svelte-devtools/master/screenshot.png "1.1.0 Screenshot")

## Enabling dev mode

In order for svelte-devtools to comunicate with your application bundle the svelte compiler must have the `dev` option set to `true`.

### Template
By default the [svelte template](https://github.com/sveltejs/template) will set `dev: true` when running `npm run dev` and `false` otherwise.

### Rollup
Below is a minimalist rollup config with `dev: true` set.
```
// rollup.config.js
import * as fs from 'fs';
import svelte from 'rollup-plugin-svelte';

export default {
  input: 'src/main.js',
  output: {
    file: 'public/bundle.js',
    format: 'iife'
  },
  plugins: [
    svelte({
      compilerOptions: {
        dev: true
      }
    })
  ]
}
```

### Webpack
Below is the relevant snipet from a `webpack.config.js` with `dev: true` set.
```
  ...
  module: {
    rules: [
      ...
      {
        test: /\.(html|svelte)$/,
        exclude: /node_modules/,
        use: {
          loader: 'svelte-loader',
          options: {
            dev: true,
          },
        },
      },
      ...
    ]
  },
  ...
```

## Build from source

Clone this repository and run the package script.
```
git clone https://github.com/RedHatter/svelte-devtools-standalone.git
cd svelte-devtools-standalone
npm install
npm run build
```
