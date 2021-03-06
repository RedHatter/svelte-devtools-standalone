import * as hooks from './hook'
import './ui/base.css'
import SvelteDevToolsUi from './ui/SvelteDevToolsUi.svelte'
// workaround for sveltejs/svelte#5870
import rawStyles from 'virtual-css-import'

const ref = window.open('', null, 'location=off')

if (ref == null) {
  console.error(
    'Unable to open the Svelte DevTools window. Please verify that the page is not blocking pop-ups.'
  )
} else {
  while (ref.document.head.firstChild) {
    ref.document.head.removeChild(ref.document.head.firstChild)
  }

  while (ref.document.body.firstChild) {
    ref.document.body.removeChild(ref.document.body.firstChild)
  }

  const style = ref.document.createElement('style')
  style.innerHTML = rawStyles
  ref.document.head.append(style)

  new SvelteDevToolsUi({
    target: ref.document.body,
    props: {
      hooks,
    },
  })
}
