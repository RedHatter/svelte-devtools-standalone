import { writable, get, derived } from 'svelte/store'

export const visibility = writable({
  component: true,
  element: true,
  block: true,
  iteration: true,
  slot: true,
  text: true,
  anchor: false,
})
export const hoveredNodeId = writable(null)
export const rootNodes = writable([])
export const searchValue = writable('')
export const profileFrame = writable({})

export const selectedNode = writable({})
const _setSelectedNode = selectedNode.set
selectedNode.set = function ({ id }) {
  let node = nodeMap.get(id)
  _setSelectedNode(node)
}

selectedNode.subscribe(node => {
  let invalid = null
  while (node.parent) {
    node = node.parent
    if (node.collapsed) {
      invalid = node
      node.collapsed = false
    }
  }

  if (invalid) invalid.invalidate()
})

function interactableNodes(list) {
  const _visibility = get(visibility)
  return list.filter(
    o => _visibility[o.type] && o.type !== 'text' && o.type !== 'anchor'
  )
}

export function handleKeydown(e) {
  selectedNode.update(node => {
    if (node.invalidate === undefined) return node
    switch (e.key) {
      case 'Enter':
        node.collapsed = !node.collapsed
        node.invalidate()
        return node

      case 'ArrowRight':
        node.collapsed = false
        node.invalidate()
        return node

      case 'ArrowDown': {
        const children = interactableNodes(node.children)

        if (node.collapsed || children.length === 0) {
          var next = node
          var current = node
          do {
            const siblings = interactableNodes(
              current.parent === undefined
                ? get(rootNodes)
                : current.parent.children
            )
            const index = siblings.findIndex(o => o.id === current.id)
            next = siblings[index + 1]

            current = current.parent
          } while (next === undefined && current !== undefined)

          return next ?? node
        } else {
          return children[0]
        }
      }

      case 'ArrowLeft':
        node.collapsed = true
        node.invalidate()
        return node

      case 'ArrowUp': {
        const siblings = interactableNodes(
          node.parent === undefined ? get(rootNodes) : node.parent.children
        )
        const index = siblings.findIndex(o => o.id === node.id)
        return index > 0 ? siblings[index - 1] : node.parent ?? node
      }

      default:
        return node
    }
  })
}

const nodeMap = new Map()

function noop() {}

function insertNode(node, target, anchorId) {
  node.parent = target

  let index = -1
  if (anchorId) index = target.children.findIndex(o => o.id == anchorId)

  if (index != -1) {
    target.children.splice(index, 0, node)
  } else {
    target.children.push(node)
  }

  target.invalidate()
}

function resolveFrame(frame) {
  frame.children.forEach(resolveFrame)

  if (!frame.node) return

  frame.node = nodeMap.get(frame.node) || {
    tagName: 'Unknown',
    type: 'Unknown',
  }
}

function resolveEventBubble(node) {
  if (!node.detail || !node.detail.listeners) return

  for (const listener of node.detail.listeners) {
    if (!listener.handler.includes('bubble($$self, event)')) continue

    listener.handler = () => {
      let target = node
      while ((target = target.parent)) if (target.type == 'component') break

      const listeners = target.detail.listeners
      if (!listeners) return null

      const parentListener = listeners.find(o => o.event == listener.event)
      if (!parentListener) return null

      const handler = parentListener.handler
      if (!handler) return null

      return (
        '// From parent\n' +
        (typeof handler == 'function' ? handler() : handler)
      )
    }
  }
}

export function clear() {
  selectedNode.set({})
  hoveredNodeId.set(null)
  rootNodes.set([])
}

export function addNode(node, target, anchor) {
  node.children = []
  node.collapsed = true
  node.invalidate = noop
  resolveEventBubble(node)

  const targetNode = nodeMap.get(target)
  nodeMap.set(node.id, node)

  if (targetNode) {
    insertNode(node, targetNode, anchor)
    return
  }

  if (node._timeout) return

  node._timeout = setTimeout(() => {
    delete node._timeout
    const targetNode = nodeMap.get(target)
    if (targetNode) insertNode(node, targetNode, anchor)
    else rootNodes.update(o => (o.push(node), o))
  }, 100)
}

export function removeNode({ id }) {
  const node = nodeMap.get(id)
  const index = node.parent.children.findIndex(o => o.id == node.id)
  node.parent.children.splice(index, 1)
  nodeMap.delete(node.id)

  node.parent.invalidate()
}

export function updateNode(newNode) {
  const node = nodeMap.get(newNode.id)
  Object.assign(node, newNode)
  resolveEventBubble(node)

  const selected = get(selectedNode)
  if (selected && selected.id == newNode.id) selectedNode.update(o => o)

  node.invalidate()
}

export function updateProfile(frame) {
  resolveFrame(frame)
  profileFrame.set(frame)
}
