<script context="module">
  import { getContext as _getContext, setContext as _setContext } from 'svelte'
  // Use object literal to avoid conflicts. A Symbol would be better but is
  // unsupported by IE
  const key = {}
  export const getContext = _getContext.bind(undefined, key)
  export const setContext = _setContext.bind(undefined, key)
</script>

<script>
  import {
    hoveredNodeId,
    rootNodes,
    selectedNode,
    handleKeydown,
  } from './store.js'
  import Button from './toolbar/Button.svelte'
  import Toolbar from './toolbar/Toolbar.svelte'
  import Search from './toolbar/Search.svelte'
  import PickerButton from './toolbar/PickerButton.svelte'
  import VisibilityButton from './toolbar/VisibilityButton.svelte'
  import ComponentView from './panel/ComponentView.svelte'
  import Profiler from './profiler/Profiler.svelte'
  import Breadcrumbs from './Breadcrumbs.svelte'
  import ErrorMessage from './ErrorMessage.svelte'
  import Node from './nodes/Node.svelte'

  export let hooks
  setContext(hooks)

  let dom
  $: {
    if (dom) {
      const defaultView = dom.ownerDocument.defaultView
      defaultView.addEventListener(
        'keydown',
        e => e.target !== defaultView && handleKeydown(e)
      )
    }
  }

  let profilerEnabled = false
  $: profilerEnabled ? hooks.startProfiler() : hooks.stopProfiler()
  $: hooks.setSelected($selectedNode.id)
  $: hooks.setHover($hoveredNodeId)
</script>

<style>
  div {
    display: flex;
    overflow: hidden;
    flex: 1 1 0;
    flex-direction: column;
  }

  ul {
    overflow: auto;
    flex-grow: 1;
    padding-top: 0.583rem; /* 8px */
  }
</style>

<span bind:this={dom} />

{#if profilerEnabled}
  <div>
    <Profiler on:close={() => (profilerEnabled = false)} />
  </div>
{:else if $rootNodes.length}
  <div class="node-tree">
    <Toolbar>
      <Button on:click={() => (profilerEnabled = true)}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
          <path d="M0,4.8H3.4V16H0ZM6.4,0H9.6V16H6.4Zm6.4,9H16V16h-3.2z" />
        </svg>
      </Button>
      <PickerButton />
      <VisibilityButton />
      <Search />
    </Toolbar>
    <ul on:mouseleave={() => ($hoveredNodeId = null)}>
      {#each $rootNodes as node (node.id)}
        <Node {node} />
      {/each}
    </ul>
    <Breadcrumbs />
  </div>
  <ComponentView />
{:else}
  <ErrorMessage />
{/if}
