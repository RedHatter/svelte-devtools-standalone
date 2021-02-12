<script>
  export let grow = 'horizontal'

  let size = 300

  function resize(e) {
    const defaultView = e.target.ownerDocument.defaultView

    function handleResize(e) {
      size =
        grow == 'horizontal'
          ? defaultView.innerWidth - e.x
          : defaultView.innerHeight - e.y
    }

    defaultView.addEventListener('mousemove', handleResize)
    defaultView.addEventListener('mouseup', () =>
      defaultView.removeEventListener('mousemove', handleResize)
    )
  }
</script>

<style>
  div {
    position: relative;
  }

  .resize.horizontal {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 0.417rem /* 5px */;
    border-left: 0.083rem /* 1px */ solid rgb(224, 224, 226);
    cursor: ew-resize;
  }

  .resize.vertical {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 0.417rem /* 5px */;
    border-top: 0.083rem /* 1px */ solid rgb(224, 224, 226);
    cursor: ns-resize;
  }

  .resize:hover {
    border-color: rgb(177, 177, 179);
  }

  :global(.dark) .resize {
    border-color: rgb(60, 60, 61);
  }

  :global(.dark) .resize:hover {
    border-color: rgb(107, 107, 108);
  }
</style>

<div style="{grow == 'horizontal' ? 'width' : 'height'}: {size}px">
  <div class="{grow} resize" on:mousedown={resize} />
  <slot />
</div>
