import { getNode, addNodeListener, getSvelteVersion } from 'svelte-listener'
import { highlight, pickElement } from './highlight.js'
import { addNode, removeNode, updateNode, updateProfile } from '../ui/store.js'

export { startProfiler, stopProfiler } from 'svelte-listener'

const _eval = eval
export function injectState(id, key, value) {
  let component = getNode(id).detail
  component.$inject_state({ [key]: _eval(value) })
}

export function pickNode() {
  const { value, cancel } = pickElement()
  return {
    value: value.then(o => serializeNode(getNode(o))),
    cancel,
  }
}

export function inspect(id) {
  const node = getNode(id)
  if (!node) return

  console.log(node.detail)
}

export function setSelected(id) {
  const node = getNode(id)
  if (!node) return

  window.$s = node.detail
}

export function setHover(id) {
  const node = getNode(id)
  highlight(node)
}

function clone(value, seen = new Map()) {
  switch (typeof value) {
    case 'function':
      return { __isFunction: true, source: value.toString(), name: value.name }
    case 'symbol':
      return { __isSymbol: true, name: value.toString() }
    case 'object':
      if (value === window || value === null) return null
      if (Array.isArray(value)) return value.map(o => clone(o, seen))
      if (seen.has(value)) return {}

      const o = {}
      seen.set(value, o)

      for (const [key, v] of Object.entries(value)) {
        o[key] = clone(v, seen)
      }

      return o
    default:
      return value
  }
}

function gte(major, minor, patch) {
  const version = (getSvelteVersion() || '0.0.0')
    .split('.')
    .map(n => parseInt(n))
  return (
    version[0] > major ||
    (version[0] == major &&
      (version[1] > minor || (version[1] == minor && version[2] >= patch)))
  )
}

let _shouldUseCapture = null
function shouldUseCapture() {
  return _shouldUseCapture == null
    ? (_shouldUseCapture = gte(3, 19, 2))
    : _shouldUseCapture
}

function serializeNode(node) {
  const serialized = {
    id: node.id,
    type: node.type,
    tagName: node.tagName,
  }
  switch (node.type) {
    case 'component': {
      if (!node.detail.$$) {
        serialized.detail = {}
        break
      }

      const internal = node.detail.$$
      const props = Array.isArray(internal.props)
        ? internal.props // Svelte < 3.13.0 stored props names as an array
        : Object.keys(internal.props)
      let ctx = clone(
        shouldUseCapture() ? node.detail.$capture_state() : internal.ctx
      )
      if (ctx === undefined) ctx = {}

      serialized.detail = {
        attributes: props.flatMap(key => {
          const value = ctx[key]
          delete ctx[key]
          return value === undefined
            ? []
            : { key, value, isBound: key in internal.bound }
        }),
        listeners: Object.entries(
          internal.callbacks
        ).flatMap(([event, value]) =>
          value.map(o => ({ event, handler: o.toString() }))
        ),
        ctx: Object.entries(ctx).map(([key, value]) => ({ key, value })),
      }
      break
    }

    case 'element': {
      const element = node.detail
      serialized.detail = {
        attributes: Array.from(element.attributes).map(attr => ({
          key: attr.name,
          value: attr.value,
        })),
        listeners: element.__listeners
          ? element.__listeners.map(o => ({
              ...o,
              handler: o.handler.toString(),
            }))
          : [],
      }

      break
    }

    case 'text': {
      serialized.detail = {
        nodeValue: node.detail.nodeValue,
      }
      break
    }

    case 'iteration':
    case 'block': {
      const { ctx, source } = node.detail
      serialized.detail = {
        ctx: Object.entries(clone(ctx)).map(([key, value]) => ({
          key,
          value,
        })),
        source: source.substring(source.indexOf('{'), source.indexOf('}') + 1),
      }
    }
  }

  return serialized
}

addNodeListener({
  add(node, anchor) {
    addNode(
      serializeNode(node),
      node.parent ? node.parent.id : null,
      anchor ? anchor.id : null
    )
  },

  remove(node) {
    removeNode(serializeNode(node))
  },

  update(node) {
    updateNode(serializeNode(node))
  },

  profile: updateProfile,
})
