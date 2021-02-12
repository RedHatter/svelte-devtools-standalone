function wait () {
  let cancel = null
  const promise = new Promise((resolve) => cancel = resolve)
  promise.continue = cancel
  return promise
}

export default function importRawCss() {
  const styles = []
  const waited = wait();
  let timer

  return {
    name: 'importRawCss',
    resolveId ( source ) {
      return source === 'virtual-css-import' ? source : null
    },

    load ( id ) {
      if (id === 'virtual-css-import') return 'export default ""'

      return null;
    },

    async transform(code, id) {
      if (id === 'virtual-css-import') {
        await waited
        return `export default \`${styles.join('\n')}\``
      }

      if (!id.endsWith('.css')) {
        return
      }

      styles.push(code)

      if (timer) clearTimeout(timer)
      timer = setTimeout(waited.continue, 2000)
    },
  }
}
