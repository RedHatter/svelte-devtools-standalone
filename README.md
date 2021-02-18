# Svelte DevTools Standalone

**Svelte DevTools is actively maintained. If you have any problems or feature requests feel free to create an issue.**

Svelte Devtools Standalone is the browser agnostic version of the [Svelte DevTools](https://github.com/RedHatter/svelte-devtools) browser extension. It allows you to inspect the [Svelte](https://svelte.dev) state and component hierarchies in a popup window.

**Requires svelte version 3.12.0 or above**

![1.1.0 Screenshot](https://raw.githubusercontent.com/RedHatter/svelte-devtools/master/screenshot.png "1.1.0 Screenshot")

## Usage

Svelte DevTools Standalone must be injected into your project to work properly. There are a few different methods to accomplish this.

### Include script tag

The simplest method is to include a link to the CDN distribution. Add the following script tag to the top of your head.

```
<script src="https://cdn.jsdelivr.net/gh/redhatter/svelte-devtools-standalone@master/dist/standalone.js"></script>
```

The tag *must* be before your application bundle to work properly.

### Import package

Another option is to import the package and bundle it with your application.

1. Install the package
```
npm install git+https://github.com/RedHatter/svelte-devtools-standalone.git
```

2. Include the import at the top of your bundle
```
  import 'svelte-devtools-standalone'
  import App from './App.svelte'

  new App({ target: document.body })
```


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
