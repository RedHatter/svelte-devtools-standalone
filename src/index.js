import * as hooks from './hook'
import './ui/base.css'
import App from './ui/App.svelte'
// workaround for sveltejs/svelte#5870
import rawStyles from 'virtual-css-import'

const ref = window.open('', null, 'location=off')

while (ref.document.head.firstChild) {
  ref.document.head.removeChild(ref.document.head.firstChild)
}

while (ref.document.body.firstChild) {
  ref.document.body.removeChild(ref.document.body.firstChild)
}

const style = ref.document.createElement('style')
style.innerHTML = rawStyles
ref.document.head.append(style)

new App({
  target: ref.document.body,
  props: {
    hooks,
  },
})
