(function () {
  'use strict';

  const listenerList = [];
  function addNodeListener(listener) {
    listenerList.push(listener);
  }

  function add(node, anchorNode) {
    for (const listener of listenerList) listener.add(node, anchorNode);
  }

  function update(node) {
    if (!node) return

    for (const listener of listenerList) listener.update(node);
  }

  function remove(node) {
    for (const listener of listenerList) listener.remove(node);
  }

  function profile(frame) {
    for (const listener of listenerList) listener.profile(frame);
  }

  let topFrame = {};
  let currentFrame = topFrame;
  let profilerEnabled = false;

  function startProfiler() {
    topFrame = {
      type: 'top',
      start: performance.now(),
      children: [],
    };
    currentFrame = topFrame;
    profilerEnabled = true;
  }

  function stopProfiler() {
    topFrame.end = performance.now(),
    profilerEnabled = false;
  }

  function updateProfile(node, type, fn, ...args) {
    if (!profilerEnabled) {
      fn(...args);
      return
    }

    const parentFrame = currentFrame;
    currentFrame = {
      type,
      node: node.id,
      start: performance.now(),
      children: [],
    };
    parentFrame.children.push(currentFrame);
    fn(...args);
    currentFrame.end = performance.now();
    currentFrame.duration = currentFrame.end - currentFrame.start;
    currentFrame = parentFrame;

    if (currentFrame.type == 'top')
      topFrame.duration = topFrame.children[topFrame.children.length - 1].end - topFrame.children[0].start;

    profile(topFrame);
  }

  const nodeMap = new Map();
  let _id = 0;
  let currentBlock;

  function getNode(id) {
    return nodeMap.get(id)
  }

  let svelteVersion = null;
  function getSvelteVersion() {
    return svelteVersion
  }

  function addNode(node, target, anchor) {
    nodeMap.set(node.id, node);
    nodeMap.set(node.detail, node);

    let targetNode = nodeMap.get(target);
    if (!targetNode || targetNode.parentBlock != node.parentBlock) {
      targetNode = node.parentBlock;
    }

    node.parent = targetNode;

    const anchorNode = nodeMap.get(anchor);

    if (targetNode) {
      let index = -1;
      if (anchorNode) index = targetNode.children.indexOf(anchorNode);

      if (index != -1) {
        targetNode.children.splice(index, 0, node);
      } else {
        targetNode.children.push(node);
      }
    }

    add(node, anchorNode);
  }

  function removeNode(node) {
    if (!node) return

    nodeMap.delete(node.id);
    nodeMap.delete(node.detail);

    const index = node.parent.children.indexOf(node);
    node.parent.children.splice(index, 1);
    node.parent = null;

    remove(node);
  }

  function updateElement(element) {
    const node = nodeMap.get(element);
    if (!node) return

    if (node.type == 'anchor') node.type = 'text';

    update(node);
  }

  function insert(element, target, anchor) {
    const node = {
      id: _id++,
      type:
        element.nodeType == 1
          ? 'element'
          : element.nodeValue && element.nodeValue != ' '
          ? 'text'
          : 'anchor',
      detail: element,
      tagName: element.nodeName.toLowerCase(),
      parentBlock: currentBlock,
      children: []
    };
    addNode(node, target, anchor);

    for (const child of element.childNodes) {
      if (!nodeMap.has(child)) insert(child, element);
    }
  }

  function svelteRegisterComponent (e) {
    const { component, tagName } = e.detail;

    const node = nodeMap.get(component.$$.fragment);
    if (node) {
      nodeMap.delete(component.$$.fragment);

      node.detail = component;
      node.tagName = tagName;

      update(node);
    } else {
      nodeMap.set(component.$$.fragment, {
        type: 'component',
        detail: component,
        tagName
      });
    }
  }

  // Ugly hack b/c promises are resolved/rejected outside of normal render flow
  let lastPromiseParent = null;
  function svelteRegisterBlock (e) {
    const { type, id, block, ...detail } = e.detail;
    const tagName = type == 'pending' ? 'await' : type;
    const nodeId = _id++;

    if (block.m) {
      const mountFn = block.m;
      block.m = (target, anchor) => {
        const parentBlock = currentBlock;
        let node = {
          id: nodeId,
          type: 'block',
          detail,
          tagName,
          parentBlock,
          children: []
        };

        switch (type) {
          case 'then':
          case 'catch':
            if (!node.parentBlock) node.parentBlock = lastPromiseParent;
            break

          case 'slot':
            node.type = 'slot';
            break

          case 'component':
            const componentNode = nodeMap.get(block);
            if (componentNode) {
              nodeMap.delete(block);
              Object.assign(node, componentNode);
            } else {
              Object.assign(node, {
                type: 'component',
                tagName: 'Unknown',
                detail: {}
              });
              nodeMap.set(block, node);
            }

            Promise.resolve().then(
              () =>
                node.detail.$$ &&
                Object.keys(node.detail.$$.bound).length &&
                update(node)
            );
            break
        }

        if (type == 'each') {
          let group = nodeMap.get(parentBlock.id + id);
          if (!group) {
            group = {
              id: _id++,
              type: 'block',
              detail: {
                ctx: {},
                source: detail.source
              },
              tagName: 'each',
              parentBlock,
              children: []
            };
            nodeMap.set(parentBlock.id + id, group);
            addNode(group, target, anchor);
          }
          node.parentBlock = group;
          node.type = 'iteration';
          addNode(node, group, anchor);
        } else {
          addNode(node, target, anchor);
        }

        currentBlock = node;
        updateProfile(node, 'mount', mountFn, target, anchor);
        currentBlock = parentBlock;
      };
    }

    if (block.p) {
      const patchFn = block.p;
      block.p = (changed, ctx) => {
        const parentBlock = currentBlock;
        currentBlock = nodeMap.get(nodeId);

        update(currentBlock);

        updateProfile(currentBlock, 'patch', patchFn, changed, ctx);

        currentBlock = parentBlock;
      };
    }

    if (block.d) {
      const detachFn = block.d;
      block.d = detaching => {
        const node = nodeMap.get(nodeId);

        if (node) {
          if (node.tagName == 'await') lastPromiseParent = node.parentBlock;

          removeNode(node);
        }

        updateProfile(node, 'detach', detachFn, detaching);
      };
    }
  }

  function svelteDOMInsert (e) {
    const { node: element, target, anchor } = e.detail;

    insert(element, target, anchor);
  }

  function svelteDOMRemove (e) {
    const node = nodeMap.get(e.detail.node);
    if (!node) return

    removeNode(node);
  }

  function svelteDOMAddEventListener (e) {
    const { node, ...detail } = e.detail;

    if (!node.__listeners) node.__listeners = [];

    node.__listeners.push(detail);
  }

  function svelteDOMRemoveEventListener (e) {
    const { node, event, handler, modifiers } = e.detail;

    if (!node.__listeners) return

    const index = node.__listeners.findIndex(
      o => o.event == event && o.handler == handler && o.modifiers == modifiers
    );

    if (index == -1) return

    node.__listeners.splice(index, 1);
  }

  function svelteUpdateNode (e) {
    updateElement(e.detail.node);
  }

  function setup (root) {
    root.addEventListener('SvelteRegisterBlock', e => svelteVersion = e.detail.version, { once: true });

    root.addEventListener('SvelteRegisterComponent', svelteRegisterComponent);
    root.addEventListener('SvelteRegisterBlock', svelteRegisterBlock);
    root.addEventListener('SvelteDOMInsert', svelteDOMInsert);
    root.addEventListener('SvelteDOMRemove', svelteDOMRemove);
    root.addEventListener('SvelteDOMAddEventListener', svelteDOMAddEventListener);
    root.addEventListener('SvelteDOMRemoveEventListener', svelteDOMRemoveEventListener);
    root.addEventListener('SvelteDOMSetData', svelteUpdateNode);
    root.addEventListener('SvelteDOMSetProperty', svelteUpdateNode);
    root.addEventListener('SvelteDOMSetAttribute', svelteUpdateNode);
    root.addEventListener('SvelteDOMRemoveAttribute', svelteUpdateNode);
  }

  setup(window.document);
  for (let i = 0; i < window.frames.length; i++) {
    const frame = window.frames[i];
    const root = frame.document;
    setup(root);
    const timer = setInterval(() => {
      if (root == frame.document) return
      clearTimeout(timer);
      setup(frame.document);
    }, 0);
    root.addEventListener('readystatechange', e => clearTimeout(timer), { once: true });
  }

  const dom = {
    area: document.createElement('div'),
    x: document.createElement('div'),
    y: document.createElement('div'),
  };

  Object.assign(dom.area.style, {
    position: 'fixed',
    backgroundColor: 'rgba(0, 136, 204, 0.2)',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });

  Object.assign(dom.x.style, {
    position: 'fixed',
    borderStyle: 'dashed',
    borderColor: 'rgb(0, 136, 204)',
    borderWidth: '1px 0',
    zIndex: '2147483647',
    left: '0',
    width: '100vw',
    pointerEvents: 'none',
  });

  Object.assign(dom.y.style, {
    position: 'fixed',
    borderStyle: 'dashed',
    borderColor: 'rgb(0, 136, 204)',
    borderWidth: '0 1px',
    zIndex: '2147483647',
    top: '0',
    height: '100vh',
    pointerEvents: 'none',
  });

  function getOffset(element) {
    const styles = getComputedStyle(element);
    const margin = {
      top: Math.max(parseInt(styles.marginTop), 0),
      right: Math.max(parseInt(styles.marginRight), 0),
      bottom: Math.max(parseInt(styles.marginBottom), 0),
      left: Math.max(parseInt(styles.marginLeft), 0),
    };

    const rect = {
      width: element.offsetWidth + margin.right + margin.left,
      height: element.offsetHeight + margin.top + margin.bottom,
      top: element.offsetTop - margin.top,
      left: element.offsetLeft - margin.left,
    };

    let parent = element;
    while (
      (parent =
        parent.offsetParent || parent.ownerDocument.defaultView.frameElement)
    ) {
      rect.top += parent.offsetTop;
      rect.left += parent.offsetLeft;
    }

    parent = element;
    while (
      (parent =
        parent.parentElement || parent.ownerDocument.defaultView.frameElement)
    ) {
      rect.top -= parent.scrollTop;
      rect.left -= parent.scrollLeft;
    }

    rect.right = rect.left + rect.width;
    rect.bottom = rect.top + rect.height;

    return rect
  }

  function getBoundingRect(node) {
    if (node.type == 'element') return getOffset(node.detail)

    const union = {
      top: Infinity,
      left: Infinity,
      bottom: -Infinity,
      right: -Infinity,
    };

    for (const child of node.children) {
      const rect = getBoundingRect(child);
      if (rect.top < union.top) union.top = rect.top;
      if (rect.left < union.left) union.left = rect.left;
      if (rect.bottom > union.bottom) union.bottom = rect.bottom;
      if (rect.right > union.right) union.right = rect.right;
    }

    union.width = union.right - union.left;
    union.height = union.bottom - union.top;

    return union
  }

  function highlight(node) {
    if (!node) {
      dom.area.remove();
      dom.x.remove();
      dom.y.remove();
      return
    }

    const box = getBoundingRect(node);
    Object.assign(dom.area.style, {
      top: box.top + 'px',
      left: box.left + 'px',
      width: box.width + 'px',
      height: box.height + 'px',
    });
    document.body.append(dom.area);

    Object.assign(dom.x.style, {
      top: box.top + 'px',
      height: box.height - 2 + 'px',
    });
    document.body.append(dom.x);

    Object.assign(dom.y.style, {
      left: box.left + 'px',
      width: box.width - 2 + 'px',
    });
    document.body.append(dom.y);
  }

  let target = null;
  function handleMousemove(e) {
    target = e.target;
    highlight({ type: 'element', detail: target });
  }

  function cancelPicker() {
    document.removeEventListener('mousemove', handleMousemove, true);
    highlight(null);
  }

  function pickElement() {
    document.addEventListener('mousemove', handleMousemove, true);
    return {
      value: new Promise(resolve =>
        document.addEventListener(
          'click',
          () => {
            cancelPicker();
            resolve(target);
          },
          { capture: true, once: true }
        )
      ),
      cancel: cancelPicker,
    }
  }

  function noop() { }
  function assign(tar, src) {
      // @ts-ignore
      for (const k in src)
          tar[k] = src[k];
      return tar;
  }
  function run(fn) {
      return fn();
  }
  function blank_object() {
      return Object.create(null);
  }
  function run_all(fns) {
      fns.forEach(run);
  }
  function is_function(thing) {
      return typeof thing === 'function';
  }
  function safe_not_equal(a, b) {
      return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
  }
  function is_empty(obj) {
      return Object.keys(obj).length === 0;
  }
  function subscribe(store, ...callbacks) {
      if (store == null) {
          return noop;
      }
      const unsub = store.subscribe(...callbacks);
      return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
  }
  function get_store_value(store) {
      let value;
      subscribe(store, _ => value = _)();
      return value;
  }
  function component_subscribe(component, store, callback) {
      component.$$.on_destroy.push(subscribe(store, callback));
  }
  function create_slot(definition, ctx, $$scope, fn) {
      if (definition) {
          const slot_ctx = get_slot_context(definition, ctx, $$scope, fn);
          return definition[0](slot_ctx);
      }
  }
  function get_slot_context(definition, ctx, $$scope, fn) {
      return definition[1] && fn
          ? assign($$scope.ctx.slice(), definition[1](fn(ctx)))
          : $$scope.ctx;
  }
  function get_slot_changes(definition, $$scope, dirty, fn) {
      if (definition[2] && fn) {
          const lets = definition[2](fn(dirty));
          if ($$scope.dirty === undefined) {
              return lets;
          }
          if (typeof lets === 'object') {
              const merged = [];
              const len = Math.max($$scope.dirty.length, lets.length);
              for (let i = 0; i < len; i += 1) {
                  merged[i] = $$scope.dirty[i] | lets[i];
              }
              return merged;
          }
          return $$scope.dirty | lets;
      }
      return $$scope.dirty;
  }
  function update_slot(slot, slot_definition, ctx, $$scope, dirty, get_slot_changes_fn, get_slot_context_fn) {
      const slot_changes = get_slot_changes(slot_definition, $$scope, dirty, get_slot_changes_fn);
      if (slot_changes) {
          const slot_context = get_slot_context(slot_definition, ctx, $$scope, get_slot_context_fn);
          slot.p(slot_context, slot_changes);
      }
  }
  function null_to_empty(value) {
      return value == null ? '' : value;
  }
  function set_store_value(store, ret, value = ret) {
      store.set(value);
      return ret;
  }

  function append(target, node) {
      target.appendChild(node);
  }
  function insert$1(target, node, anchor) {
      target.insertBefore(node, anchor || null);
  }
  function detach(node) {
      node.parentNode.removeChild(node);
  }
  function destroy_each(iterations, detaching) {
      for (let i = 0; i < iterations.length; i += 1) {
          if (iterations[i])
              iterations[i].d(detaching);
      }
  }
  function element(name) {
      return document.createElement(name);
  }
  function svg_element(name) {
      return document.createElementNS('http://www.w3.org/2000/svg', name);
  }
  function text(data) {
      return document.createTextNode(data);
  }
  function empty() {
      return text('');
  }
  function listen(node, event, handler, options) {
      node.addEventListener(event, handler, options);
      return () => node.removeEventListener(event, handler, options);
  }
  function prevent_default(fn) {
      return function (event) {
          event.preventDefault();
          // @ts-ignore
          return fn.call(this, event);
      };
  }
  function stop_propagation(fn) {
      return function (event) {
          event.stopPropagation();
          // @ts-ignore
          return fn.call(this, event);
      };
  }
  function attr(node, attribute, value) {
      if (value == null)
          node.removeAttribute(attribute);
      else if (node.getAttribute(attribute) !== value)
          node.setAttribute(attribute, value);
  }
  function set_attributes(node, attributes) {
      // @ts-ignore
      const descriptors = Object.getOwnPropertyDescriptors(node.__proto__);
      for (const key in attributes) {
          if (attributes[key] == null) {
              node.removeAttribute(key);
          }
          else if (key === 'style') {
              node.style.cssText = attributes[key];
          }
          else if (key === '__value') {
              node.value = node[key] = attributes[key];
          }
          else if (descriptors[key] && descriptors[key].set) {
              node[key] = attributes[key];
          }
          else {
              attr(node, key, attributes[key]);
          }
      }
  }
  function children(element) {
      return Array.from(element.childNodes);
  }
  function set_data(text, data) {
      data = '' + data;
      if (text.wholeText !== data)
          text.data = data;
  }
  function set_input_value(input, value) {
      input.value = value == null ? '' : value;
  }
  function set_style(node, key, value, important) {
      node.style.setProperty(key, value, important ? 'important' : '');
  }
  function toggle_class(element, name, toggle) {
      element.classList[toggle ? 'add' : 'remove'](name);
  }
  function custom_event(type, detail) {
      const e = document.createEvent('CustomEvent');
      e.initCustomEvent(type, false, false, detail);
      return e;
  }

  let current_component;
  function set_current_component(component) {
      current_component = component;
  }
  function get_current_component() {
      if (!current_component)
          throw new Error('Function called outside component initialization');
      return current_component;
  }
  function createEventDispatcher() {
      const component = get_current_component();
      return (type, detail) => {
          const callbacks = component.$$.callbacks[type];
          if (callbacks) {
              // TODO are there situations where events could be dispatched
              // in a server (non-DOM) environment?
              const event = custom_event(type, detail);
              callbacks.slice().forEach(fn => {
                  fn.call(component, event);
              });
          }
      };
  }
  function setContext(key, context) {
      get_current_component().$$.context.set(key, context);
  }
  function getContext(key) {
      return get_current_component().$$.context.get(key);
  }
  // TODO figure out if we still want to support
  // shorthand events, or if we want to implement
  // a real bubbling mechanism
  function bubble(component, event) {
      const callbacks = component.$$.callbacks[event.type];
      if (callbacks) {
          callbacks.slice().forEach(fn => fn(event));
      }
  }

  const dirty_components = [];
  const binding_callbacks = [];
  const render_callbacks = [];
  const flush_callbacks = [];
  const resolved_promise = Promise.resolve();
  let update_scheduled = false;
  function schedule_update() {
      if (!update_scheduled) {
          update_scheduled = true;
          resolved_promise.then(flush);
      }
  }
  function tick() {
      schedule_update();
      return resolved_promise;
  }
  function add_render_callback(fn) {
      render_callbacks.push(fn);
  }
  function add_flush_callback(fn) {
      flush_callbacks.push(fn);
  }
  let flushing = false;
  const seen_callbacks = new Set();
  function flush() {
      if (flushing)
          return;
      flushing = true;
      do {
          // first, call beforeUpdate functions
          // and update components
          for (let i = 0; i < dirty_components.length; i += 1) {
              const component = dirty_components[i];
              set_current_component(component);
              update$1(component.$$);
          }
          set_current_component(null);
          dirty_components.length = 0;
          while (binding_callbacks.length)
              binding_callbacks.pop()();
          // then, once components are updated, call
          // afterUpdate functions. This may cause
          // subsequent updates...
          for (let i = 0; i < render_callbacks.length; i += 1) {
              const callback = render_callbacks[i];
              if (!seen_callbacks.has(callback)) {
                  // ...so guard against infinite loops
                  seen_callbacks.add(callback);
                  callback();
              }
          }
          render_callbacks.length = 0;
      } while (dirty_components.length);
      while (flush_callbacks.length) {
          flush_callbacks.pop()();
      }
      update_scheduled = false;
      flushing = false;
      seen_callbacks.clear();
  }
  function update$1($$) {
      if ($$.fragment !== null) {
          $$.update();
          run_all($$.before_update);
          const dirty = $$.dirty;
          $$.dirty = [-1];
          $$.fragment && $$.fragment.p($$.ctx, dirty);
          $$.after_update.forEach(add_render_callback);
      }
  }
  const outroing = new Set();
  let outros;
  function group_outros() {
      outros = {
          r: 0,
          c: [],
          p: outros // parent group
      };
  }
  function check_outros() {
      if (!outros.r) {
          run_all(outros.c);
      }
      outros = outros.p;
  }
  function transition_in(block, local) {
      if (block && block.i) {
          outroing.delete(block);
          block.i(local);
      }
  }
  function transition_out(block, local, detach, callback) {
      if (block && block.o) {
          if (outroing.has(block))
              return;
          outroing.add(block);
          outros.c.push(() => {
              outroing.delete(block);
              if (callback) {
                  if (detach)
                      block.d(1);
                  callback();
              }
          });
          block.o(local);
      }
  }
  function outro_and_destroy_block(block, lookup) {
      transition_out(block, 1, 1, () => {
          lookup.delete(block.key);
      });
  }
  function update_keyed_each(old_blocks, dirty, get_key, dynamic, ctx, list, lookup, node, destroy, create_each_block, next, get_context) {
      let o = old_blocks.length;
      let n = list.length;
      let i = o;
      const old_indexes = {};
      while (i--)
          old_indexes[old_blocks[i].key] = i;
      const new_blocks = [];
      const new_lookup = new Map();
      const deltas = new Map();
      i = n;
      while (i--) {
          const child_ctx = get_context(ctx, list, i);
          const key = get_key(child_ctx);
          let block = lookup.get(key);
          if (!block) {
              block = create_each_block(key, child_ctx);
              block.c();
          }
          else if (dynamic) {
              block.p(child_ctx, dirty);
          }
          new_lookup.set(key, new_blocks[i] = block);
          if (key in old_indexes)
              deltas.set(key, Math.abs(i - old_indexes[key]));
      }
      const will_move = new Set();
      const did_move = new Set();
      function insert(block) {
          transition_in(block, 1);
          block.m(node, next);
          lookup.set(block.key, block);
          next = block.first;
          n--;
      }
      while (o && n) {
          const new_block = new_blocks[n - 1];
          const old_block = old_blocks[o - 1];
          const new_key = new_block.key;
          const old_key = old_block.key;
          if (new_block === old_block) {
              // do nothing
              next = new_block.first;
              o--;
              n--;
          }
          else if (!new_lookup.has(old_key)) {
              // remove old block
              destroy(old_block, lookup);
              o--;
          }
          else if (!lookup.has(new_key) || will_move.has(new_key)) {
              insert(new_block);
          }
          else if (did_move.has(old_key)) {
              o--;
          }
          else if (deltas.get(new_key) > deltas.get(old_key)) {
              did_move.add(new_key);
              insert(new_block);
          }
          else {
              will_move.add(old_key);
              o--;
          }
      }
      while (o--) {
          const old_block = old_blocks[o];
          if (!new_lookup.has(old_block.key))
              destroy(old_block, lookup);
      }
      while (n)
          insert(new_blocks[n - 1]);
      return new_blocks;
  }

  function get_spread_update(levels, updates) {
      const update = {};
      const to_null_out = {};
      const accounted_for = { $$scope: 1 };
      let i = levels.length;
      while (i--) {
          const o = levels[i];
          const n = updates[i];
          if (n) {
              for (const key in o) {
                  if (!(key in n))
                      to_null_out[key] = 1;
              }
              for (const key in n) {
                  if (!accounted_for[key]) {
                      update[key] = n[key];
                      accounted_for[key] = 1;
                  }
              }
              levels[i] = n;
          }
          else {
              for (const key in o) {
                  accounted_for[key] = 1;
              }
          }
      }
      for (const key in to_null_out) {
          if (!(key in update))
              update[key] = undefined;
      }
      return update;
  }
  function get_spread_object(spread_props) {
      return typeof spread_props === 'object' && spread_props !== null ? spread_props : {};
  }

  function bind(component, name, callback) {
      const index = component.$$.props[name];
      if (index !== undefined) {
          component.$$.bound[index] = callback;
          callback(component.$$.ctx[index]);
      }
  }
  function create_component(block) {
      block && block.c();
  }
  function mount_component(component, target, anchor) {
      const { fragment, on_mount, on_destroy, after_update } = component.$$;
      fragment && fragment.m(target, anchor);
      // onMount happens before the initial afterUpdate
      add_render_callback(() => {
          const new_on_destroy = on_mount.map(run).filter(is_function);
          if (on_destroy) {
              on_destroy.push(...new_on_destroy);
          }
          else {
              // Edge case - component was destroyed immediately,
              // most likely as a result of a binding initialising
              run_all(new_on_destroy);
          }
          component.$$.on_mount = [];
      });
      after_update.forEach(add_render_callback);
  }
  function destroy_component(component, detaching) {
      const $$ = component.$$;
      if ($$.fragment !== null) {
          run_all($$.on_destroy);
          $$.fragment && $$.fragment.d(detaching);
          // TODO null out other refs, including component.$$ (but need to
          // preserve final state?)
          $$.on_destroy = $$.fragment = null;
          $$.ctx = [];
      }
  }
  function make_dirty(component, i) {
      if (component.$$.dirty[0] === -1) {
          dirty_components.push(component);
          schedule_update();
          component.$$.dirty.fill(0);
      }
      component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
  }
  function init(component, options, instance, create_fragment, not_equal, props, dirty = [-1]) {
      const parent_component = current_component;
      set_current_component(component);
      const $$ = component.$$ = {
          fragment: null,
          ctx: null,
          // state
          props,
          update: noop,
          not_equal,
          bound: blank_object(),
          // lifecycle
          on_mount: [],
          on_destroy: [],
          before_update: [],
          after_update: [],
          context: new Map(parent_component ? parent_component.$$.context : []),
          // everything else
          callbacks: blank_object(),
          dirty,
          skip_bound: false
      };
      let ready = false;
      $$.ctx = instance
          ? instance(component, options.props || {}, (i, ret, ...rest) => {
              const value = rest.length ? rest[0] : ret;
              if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                  if (!$$.skip_bound && $$.bound[i])
                      $$.bound[i](value);
                  if (ready)
                      make_dirty(component, i);
              }
              return ret;
          })
          : [];
      $$.update();
      ready = true;
      run_all($$.before_update);
      // `false` as a special case of no DOM component
      $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
      if (options.target) {
          if (options.hydrate) {
              const nodes = children(options.target);
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              $$.fragment && $$.fragment.l(nodes);
              nodes.forEach(detach);
          }
          else {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              $$.fragment && $$.fragment.c();
          }
          if (options.intro)
              transition_in(component.$$.fragment);
          mount_component(component, options.target, options.anchor);
          flush();
      }
      set_current_component(parent_component);
  }
  /**
   * Base class for Svelte components. Used when dev=false.
   */
  class SvelteComponent {
      $destroy() {
          destroy_component(this, 1);
          this.$destroy = noop;
      }
      $on(type, callback) {
          const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
          callbacks.push(callback);
          return () => {
              const index = callbacks.indexOf(callback);
              if (index !== -1)
                  callbacks.splice(index, 1);
          };
      }
      $set($$props) {
          if (this.$$set && !is_empty($$props)) {
              this.$$.skip_bound = true;
              this.$$set($$props);
              this.$$.skip_bound = false;
          }
      }
  }

  const subscriber_queue = [];
  /**
   * Create a `Writable` store that allows both updating and reading by subscription.
   * @param {*=}value initial value
   * @param {StartStopNotifier=}start start and stop notifications for subscriptions
   */
  function writable(value, start = noop) {
      let stop;
      const subscribers = [];
      function set(new_value) {
          if (safe_not_equal(value, new_value)) {
              value = new_value;
              if (stop) { // store is ready
                  const run_queue = !subscriber_queue.length;
                  for (let i = 0; i < subscribers.length; i += 1) {
                      const s = subscribers[i];
                      s[1]();
                      subscriber_queue.push(s, value);
                  }
                  if (run_queue) {
                      for (let i = 0; i < subscriber_queue.length; i += 2) {
                          subscriber_queue[i][0](subscriber_queue[i + 1]);
                      }
                      subscriber_queue.length = 0;
                  }
              }
          }
      }
      function update(fn) {
          set(fn(value));
      }
      function subscribe(run, invalidate = noop) {
          const subscriber = [run, invalidate];
          subscribers.push(subscriber);
          if (subscribers.length === 1) {
              stop = start(set) || noop;
          }
          run(value);
          return () => {
              const index = subscribers.indexOf(subscriber);
              if (index !== -1) {
                  subscribers.splice(index, 1);
              }
              if (subscribers.length === 0) {
                  stop();
                  stop = null;
              }
          };
      }
      return { set, update, subscribe };
  }

  const visibility = writable({
    component: true,
    element: true,
    block: true,
    iteration: true,
    slot: true,
    text: true,
    anchor: false,
  });
  const hoveredNodeId = writable(null);
  const rootNodes = writable([]);
  const searchValue = writable('');
  const profileFrame = writable({});

  const selectedNode = writable({});
  const _setSelectedNode = selectedNode.set;
  selectedNode.set = function ({ id }) {
    let node = nodeMap$1.get(id);
    _setSelectedNode(node);
  };

  selectedNode.subscribe(node => {
    let invalid = null;
    while (node.parent) {
      node = node.parent;
      if (node.collapsed) {
        invalid = node;
        node.collapsed = false;
      }
    }

    if (invalid) invalid.invalidate();
  });

  function interactableNodes(list) {
    const _visibility = get_store_value(visibility);
    return list.filter(
      o => _visibility[o.type] && o.type !== 'text' && o.type !== 'anchor'
    )
  }

  function handleKeydown(e) {
    selectedNode.update(node => {
      if (node.invalidate === undefined) return node
      switch (e.key) {
        case 'Enter':
          node.collapsed = !node.collapsed;
          node.invalidate();
          return node

        case 'ArrowRight':
          node.collapsed = false;
          node.invalidate();
          return node

        case 'ArrowDown': {
          const children = interactableNodes(node.children);

          if (node.collapsed || children.length === 0) {
            var next = node;
            var current = node;
            do {
              const siblings = interactableNodes(
                current.parent === undefined
                  ? get_store_value(rootNodes)
                  : current.parent.children
              );
              const index = siblings.findIndex(o => o.id === current.id);
              next = siblings[index + 1];

              current = current.parent;
            } while (next === undefined && current !== undefined)

            return next ?? node
          } else {
            return children[0]
          }
        }

        case 'ArrowLeft':
          node.collapsed = true;
          node.invalidate();
          return node

        case 'ArrowUp': {
          const siblings = interactableNodes(
            node.parent === undefined ? get_store_value(rootNodes) : node.parent.children
          );
          const index = siblings.findIndex(o => o.id === node.id);
          return index > 0 ? siblings[index - 1] : node.parent ?? node
        }

        default:
          return node
      }
    });
  }

  const nodeMap$1 = new Map();

  function noop$1() {}

  function insertNode(node, target, anchorId) {
    node.parent = target;

    let index = -1;
    if (anchorId) index = target.children.findIndex(o => o.id == anchorId);

    if (index != -1) {
      target.children.splice(index, 0, node);
    } else {
      target.children.push(node);
    }

    target.invalidate();
  }

  function resolveFrame(frame) {
    frame.children.forEach(resolveFrame);

    if (!frame.node) return

    frame.node = nodeMap$1.get(frame.node) || {
      tagName: 'Unknown',
      type: 'Unknown',
    };
  }

  function resolveEventBubble(node) {
    if (!node.detail || !node.detail.listeners) return

    for (const listener of node.detail.listeners) {
      if (!listener.handler.includes('bubble($$self, event)')) continue

      listener.handler = () => {
        let target = node;
        while ((target = target.parent)) if (target.type == 'component') break

        const listeners = target.detail.listeners;
        if (!listeners) return null

        const parentListener = listeners.find(o => o.event == listener.event);
        if (!parentListener) return null

        const handler = parentListener.handler;
        if (!handler) return null

        return (
          '// From parent\n' +
          (typeof handler == 'function' ? handler() : handler)
        )
      };
    }
  }

  function addNode$1(node, target, anchor) {
    node.children = [];
    node.collapsed = true;
    node.invalidate = noop$1;
    resolveEventBubble(node);

    const targetNode = nodeMap$1.get(target);
    nodeMap$1.set(node.id, node);

    if (targetNode) {
      insertNode(node, targetNode, anchor);
      return
    }

    if (node._timeout) return

    node._timeout = setTimeout(() => {
      delete node._timeout;
      const targetNode = nodeMap$1.get(target);
      if (targetNode) insertNode(node, targetNode, anchor);
      else rootNodes.update(o => (o.push(node), o));
    }, 100);
  }

  function removeNode$1({ id }) {
    const node = nodeMap$1.get(id);
    const index = node.parent.children.findIndex(o => o.id == node.id);
    node.parent.children.splice(index, 1);
    nodeMap$1.delete(node.id);

    node.parent.invalidate();
  }

  function updateNode(newNode) {
    const node = nodeMap$1.get(newNode.id);
    Object.assign(node, newNode);
    resolveEventBubble(node);

    const selected = get_store_value(selectedNode);
    if (selected && selected.id == newNode.id) selectedNode.update(o => o);

    node.invalidate();
  }

  function updateProfile$1(frame) {
    resolveFrame(frame);
    profileFrame.set(frame);
  }

  const _eval = eval;
  function injectState(id, key, value) {
    let component = getNode(id).detail;
    component.$inject_state({ [key]: _eval(value) });
  }

  function pickNode() {
    const { value, cancel } = pickElement();
    return {
      value: value.then(o => serializeNode(getNode(o))),
      cancel,
    }
  }

  function inspect(id) {
    const node = getNode(id);
    if (!node) return

    console.log(node.detail);
  }

  function setSelected(id) {
    const node = getNode(id);
    if (!node) return

    window.$s = node.detail;
  }

  function setHover(id) {
    const node = getNode(id);
    highlight(node);
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

        const o = {};
        seen.set(value, o);

        for (const [key, v] of Object.entries(value)) {
          o[key] = clone(v, seen);
        }

        return o
      default:
        return value
    }
  }

  function gte(major, minor, patch) {
    const version = (getSvelteVersion() || '0.0.0')
      .split('.')
      .map(n => parseInt(n));
    return (
      version[0] > major ||
      (version[0] == major &&
        (version[1] > minor || (version[1] == minor && version[2] >= patch)))
    )
  }

  let _shouldUseCapture = null;
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
    };
    switch (node.type) {
      case 'component': {
        if (!node.detail.$$) {
          serialized.detail = {};
          break
        }

        const internal = node.detail.$$;
        const props = Array.isArray(internal.props)
          ? internal.props // Svelte < 3.13.0 stored props names as an array
          : Object.keys(internal.props);
        let ctx = clone(
          shouldUseCapture() ? node.detail.$capture_state() : internal.ctx
        );
        if (ctx === undefined) ctx = {};

        serialized.detail = {
          attributes: props.flatMap(key => {
            const value = ctx[key];
            delete ctx[key];
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
        };
        break
      }

      case 'element': {
        const element = node.detail;
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
        };

        break
      }

      case 'text': {
        serialized.detail = {
          nodeValue: node.detail.nodeValue,
        };
        break
      }

      case 'iteration':
      case 'block': {
        const { ctx, source } = node.detail;
        serialized.detail = {
          ctx: Object.entries(clone(ctx)).map(([key, value]) => ({
            key,
            value,
          })),
          source: source.substring(source.indexOf('{'), source.indexOf('}') + 1),
        };
      }
    }

    return serialized
  }

  addNodeListener({
    add(node, anchor) {
      addNode$1(
        serializeNode(node),
        node.parent ? node.parent.id : null,
        anchor ? anchor.id : null
      );
    },

    remove(node) {
      removeNode$1(serializeNode(node));
    },

    update(node) {
      updateNode(serializeNode(node));
    },

    profile: updateProfile$1,
  });

  var hooks = /*#__PURE__*/Object.freeze({
    __proto__: null,
    injectState: injectState,
    pickNode: pickNode,
    inspect: inspect,
    setSelected: setSelected,
    setHover: setHover,
    startProfiler: startProfiler,
    stopProfiler: stopProfiler
  });

  /* src/ui/toolbar/Button.svelte generated by Svelte v3.32.3 */

  function create_fragment(ctx) {
  	let button;
  	let current;
  	let mounted;
  	let dispose;
  	const default_slot_template = /*#slots*/ ctx[4].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[3], null);

  	return {
  		c() {
  			button = element("button");
  			if (default_slot) default_slot.c();
  			button.disabled = /*disabled*/ ctx[0];
  			attr(button, "type", /*type*/ ctx[2]);
  			attr(button, "class", "svelte-1jb7vvd");
  			toggle_class(button, "active", /*active*/ ctx[1]);
  		},
  		m(target, anchor) {
  			insert$1(target, button, anchor);

  			if (default_slot) {
  				default_slot.m(button, null);
  			}

  			current = true;

  			if (!mounted) {
  				dispose = listen(button, "click", /*click_handler*/ ctx[5]);
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 8) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[3], dirty, null, null);
  				}
  			}

  			if (!current || dirty & /*disabled*/ 1) {
  				button.disabled = /*disabled*/ ctx[0];
  			}

  			if (!current || dirty & /*type*/ 4) {
  				attr(button, "type", /*type*/ ctx[2]);
  			}

  			if (dirty & /*active*/ 2) {
  				toggle_class(button, "active", /*active*/ ctx[1]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(button);
  			if (default_slot) default_slot.d(detaching);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function instance($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;
  	let { disabled } = $$props;
  	let { active } = $$props;
  	let { type = "button" } = $$props;

  	function click_handler(event) {
  		bubble($$self, event);
  	}

  	$$self.$$set = $$props => {
  		if ("disabled" in $$props) $$invalidate(0, disabled = $$props.disabled);
  		if ("active" in $$props) $$invalidate(1, active = $$props.active);
  		if ("type" in $$props) $$invalidate(2, type = $$props.type);
  		if ("$$scope" in $$props) $$invalidate(3, $$scope = $$props.$$scope);
  	};

  	return [disabled, active, type, $$scope, slots, click_handler];
  }

  class Button extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance, create_fragment, safe_not_equal, { disabled: 0, active: 1, type: 2 });
  	}
  }

  /* src/ui/toolbar/Toolbar.svelte generated by Svelte v3.32.3 */

  function create_fragment$1(ctx) {
  	let div;
  	let current;
  	const default_slot_template = /*#slots*/ ctx[1].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[0], null);

  	return {
  		c() {
  			div = element("div");
  			if (default_slot) default_slot.c();
  			attr(div, "class", "svelte-o66q11");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);

  			if (default_slot) {
  				default_slot.m(div, null);
  			}

  			current = true;
  		},
  		p(ctx, [dirty]) {
  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 1) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[0], dirty, null, null);
  				}
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			if (default_slot) default_slot.d(detaching);
  		}
  	};
  }

  function instance$1($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;

  	$$self.$$set = $$props => {
  		if ("$$scope" in $$props) $$invalidate(0, $$scope = $$props.$$scope);
  	};

  	return [$$scope, slots];
  }

  class Toolbar extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$1, create_fragment$1, safe_not_equal, {});
  	}
  }

  /* src/ui/toolbar/Search.svelte generated by Svelte v3.32.3 */

  function create_if_block(ctx) {
  	let t0_value = /*resultsPosition*/ ctx[2] + 1 + "";
  	let t0;
  	let t1;
  	let t2_value = /*results*/ ctx[1].length + "";
  	let t2;
  	let t3;

  	return {
  		c() {
  			t0 = text(t0_value);
  			t1 = text(" of ");
  			t2 = text(t2_value);
  			t3 = text(" ");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, t2, anchor);
  			insert$1(target, t3, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*resultsPosition*/ 4 && t0_value !== (t0_value = /*resultsPosition*/ ctx[2] + 1 + "")) set_data(t0, t0_value);
  			if (dirty & /*results*/ 2 && t2_value !== (t2_value = /*results*/ ctx[1].length + "")) set_data(t2, t2_value);
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(t2);
  			if (detaching) detach(t3);
  		}
  	};
  }

  // (96:156) <Button type="submit" disabled={!results.length}>
  function create_default_slot_1(ctx) {
  	let div;

  	return {
  		c() {
  			div = element("div");
  			attr(div, "class", "next svelte-24wsvu");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  		}
  	};
  }

  // (96:234) <Button on:click={prev} disabled={!results.length}>
  function create_default_slot(ctx) {
  	let div;

  	return {
  		c() {
  			div = element("div");
  			attr(div, "class", "prev svelte-24wsvu");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  		}
  	};
  }

  function create_fragment$2(ctx) {
  	let form;
  	let div;
  	let svg;
  	let path0;
  	let path1;
  	let input;
  	let if_block_anchor;
  	let button0;
  	let button1;
  	let current;
  	let mounted;
  	let dispose;
  	let if_block = /*resultsPosition*/ ctx[2] > -1 && create_if_block(ctx);

  	button0 = new Button({
  			props: {
  				type: "submit",
  				disabled: !/*results*/ ctx[1].length,
  				$$slots: { default: [create_default_slot_1] },
  				$$scope: { ctx }
  			}
  		});

  	button1 = new Button({
  			props: {
  				disabled: !/*results*/ ctx[1].length,
  				$$slots: { default: [create_default_slot] },
  				$$scope: { ctx }
  			}
  		});

  	button1.$on("click", /*prev*/ ctx[4]);

  	return {
  		c() {
  			form = element("form");
  			div = element("div");
  			svg = svg_element("svg");
  			path0 = svg_element("path");
  			path1 = svg_element("path");
  			input = element("input");
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  			create_component(button0.$$.fragment);
  			create_component(button1.$$.fragment);
  			attr(div, "class", "separator svelte-24wsvu");
  			attr(path0, "fill", "rgba(135, 135, 137, 0.9)");
  			attr(path0, "d", "M15.707 14.293l-5-5-1.414 1.414 5 5a1 1 0 0 0 1.414-1.414z");
  			attr(path1, "fill", "rgba(135, 135, 137, 0.9)");
  			attr(path1, "fill-rule", "evenodd");
  			attr(path1, "d", "M6 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2A6 6 0 1 0 6 0a6 6 0 0 0 0 12z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  			attr(svg, "class", "svelte-24wsvu");
  			attr(input, "placeholder", "Search");
  			attr(input, "class", "svelte-24wsvu");
  			attr(form, "class", "svelte-24wsvu");
  		},
  		m(target, anchor) {
  			insert$1(target, form, anchor);
  			append(form, div);
  			append(form, svg);
  			append(svg, path0);
  			append(svg, path1);
  			append(form, input);
  			set_input_value(input, /*$searchValue*/ ctx[0]);
  			if (if_block) if_block.m(form, null);
  			append(form, if_block_anchor);
  			mount_component(button0, form, null);
  			mount_component(button1, form, null);
  			current = true;

  			if (!mounted) {
  				dispose = [
  					listen(input, "input", /*input_input_handler*/ ctx[5]),
  					listen(form, "submit", prevent_default(/*next*/ ctx[3]))
  				];

  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			if (dirty & /*$searchValue*/ 1 && input.value !== /*$searchValue*/ ctx[0]) {
  				set_input_value(input, /*$searchValue*/ ctx[0]);
  			}

  			if (/*resultsPosition*/ ctx[2] > -1) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block(ctx);
  					if_block.c();
  					if_block.m(form, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}

  			const button0_changes = {};
  			if (dirty & /*results*/ 2) button0_changes.disabled = !/*results*/ ctx[1].length;

  			if (dirty & /*$$scope*/ 256) {
  				button0_changes.$$scope = { dirty, ctx };
  			}

  			button0.$set(button0_changes);
  			const button1_changes = {};
  			if (dirty & /*results*/ 2) button1_changes.disabled = !/*results*/ ctx[1].length;

  			if (dirty & /*$$scope*/ 256) {
  				button1_changes.$$scope = { dirty, ctx };
  			}

  			button1.$set(button1_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button0.$$.fragment, local);
  			transition_in(button1.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button0.$$.fragment, local);
  			transition_out(button1.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(form);
  			if (if_block) if_block.d();
  			destroy_component(button0);
  			destroy_component(button1);
  			mounted = false;
  			run_all(dispose);
  		}
  	};
  }

  function instance$2($$self, $$props, $$invalidate) {
  	let $rootNodes;
  	let $searchValue;
  	component_subscribe($$self, rootNodes, $$value => $$invalidate(6, $rootNodes = $$value));
  	component_subscribe($$self, searchValue, $$value => $$invalidate(0, $searchValue = $$value));

  	function next() {
  		if (resultsPosition >= results.length - 1) $$invalidate(2, resultsPosition = -1);
  		selectedNode.set(results[$$invalidate(2, ++resultsPosition)]);
  	}

  	function prev() {
  		if (resultsPosition <= 0) $$invalidate(2, resultsPosition = results.length);
  		selectedNode.set(results[$$invalidate(2, --resultsPosition)]);
  	}

  	function search(nodeList = $rootNodes) {
  		for (const node of nodeList) {
  			if (node.tagName.includes($searchValue) || node.detail && JSON.stringify(node.detail).includes($searchValue)) results.push(node);
  			search(node.children);
  		}
  	}

  	let results;
  	let resultsPosition;

  	function input_input_handler() {
  		$searchValue = this.value;
  		searchValue.set($searchValue);
  	}

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*$searchValue*/ 1) {
  			{
  				$$invalidate(1, results = []);
  				$$invalidate(2, resultsPosition = -1);
  				if ($searchValue.length > 1) search();
  			}
  		}
  	};

  	return [$searchValue, results, resultsPosition, next, prev, input_input_handler];
  }

  class Search extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$2, create_fragment$2, safe_not_equal, {});
  	}
  }

  /* src/ui/toolbar/PickerButton.svelte generated by Svelte v3.32.3 */

  function create_default_slot$1(ctx) {
  	let svg;
  	let path0;
  	let path1;

  	return {
  		c() {
  			svg = svg_element("svg");
  			path0 = svg_element("path");
  			path1 = svg_element("path");
  			attr(path0, "d", "M3 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.6a1 1 0 1 1 0 2H3a3 3 0 0\n      1-3-3V4a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2.6a1 1 0 1 1-2 0V4a1 1 0 0\n      0-1-1H3z");
  			attr(path1, "d", "M12.87 14.6c.3.36.85.4 1.2.1.36-.31.4-.86.1-1.22l-1.82-2.13 2.42-1a.3.3\n      0 0 0 .01-.56L7.43 6.43a.3.3 0 0 0-.42.35l2.13 7.89a.3.3 0 0 0\n      .55.07l1.35-2.28 1.83 2.14z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path0);
  			append(svg, path1);
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  		}
  	};
  }

  function create_fragment$3(ctx) {
  	let button;
  	let current;

  	button = new Button({
  			props: {
  				active: /*picker*/ ctx[0] !== false,
  				$$slots: { default: [create_default_slot$1] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click*/ ctx[1]);

  	return {
  		c() {
  			create_component(button.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(button, target, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			const button_changes = {};
  			if (dirty & /*picker*/ 1) button_changes.active = /*picker*/ ctx[0] !== false;

  			if (dirty & /*$$scope*/ 16) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(button, detaching);
  		}
  	};
  }

  function instance$3($$self, $$props, $$invalidate) {
  	let $selectedNode;
  	component_subscribe($$self, selectedNode, $$value => $$invalidate(2, $selectedNode = $$value));
  	const { pickNode } = getContext$1();
  	let picker = false;

  	async function click() {
  		if (picker === false) {
  			$$invalidate(0, picker = pickNode());
  			set_store_value(selectedNode, $selectedNode = await picker.value, $selectedNode);
  			$$invalidate(0, picker = false);
  			const node = $selectedNode;
  			setTimeout(() => node.dom && node.dom.scrollIntoView({ block: "center" }), 120);
  		} else {
  			picker.cancel();
  			$$invalidate(0, picker = false);
  		}
  	}

  	return [picker, click];
  }

  class PickerButton extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$3, create_fragment$3, safe_not_equal, {});
  	}
  }

  /* src/ui/toolbar/VisibilityButton.svelte generated by Svelte v3.32.3 */

  function create_if_block$1(ctx) {
  	let div;
  	let ul;
  	let span;
  	let li0;
  	let li1;
  	let li2;
  	let li3;
  	let li4;
  	let li5;
  	let mounted;
  	let dispose;

  	return {
  		c() {
  			div = element("div");
  			ul = element("ul");
  			span = element("span");
  			li0 = element("li");
  			li0.textContent = "Components";
  			li1 = element("li");
  			li1.textContent = "Elements";
  			li2 = element("li");
  			li2.textContent = "Blocks";
  			li3 = element("li");
  			li3.textContent = "Slots";
  			li4 = element("li");
  			li4.textContent = "Anchors";
  			li5 = element("li");
  			li5.textContent = "Text";
  			attr(div, "class", "svelte-1yox9nf");
  			attr(span, "class", "svelte-1yox9nf");
  			attr(li0, "class", "svelte-1yox9nf");
  			toggle_class(li0, "checked", /*$visibility*/ ctx[1].component);
  			attr(li1, "class", "svelte-1yox9nf");
  			toggle_class(li1, "checked", /*$visibility*/ ctx[1].element);
  			attr(li2, "class", "svelte-1yox9nf");
  			toggle_class(li2, "checked", /*$visibility*/ ctx[1].block);
  			attr(li3, "class", "svelte-1yox9nf");
  			toggle_class(li3, "checked", /*$visibility*/ ctx[1].slot);
  			attr(li4, "class", "svelte-1yox9nf");
  			toggle_class(li4, "checked", /*$visibility*/ ctx[1].anchor);
  			attr(li5, "class", "svelte-1yox9nf");
  			toggle_class(li5, "checked", /*$visibility*/ ctx[1].text);
  			attr(ul, "class", "svelte-1yox9nf");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			insert$1(target, ul, anchor);
  			append(ul, span);
  			append(ul, li0);
  			append(ul, li1);
  			append(ul, li2);
  			append(ul, li3);
  			append(ul, li4);
  			append(ul, li5);

  			if (!mounted) {
  				dispose = [
  					listen(div, "click", stop_propagation(/*click_handler*/ ctx[2])),
  					listen(li0, "click", /*click_handler_1*/ ctx[3]),
  					listen(li1, "click", /*click_handler_2*/ ctx[4]),
  					listen(li2, "click", /*click_handler_3*/ ctx[5]),
  					listen(li3, "click", /*click_handler_4*/ ctx[6]),
  					listen(li4, "click", /*click_handler_5*/ ctx[7]),
  					listen(li5, "click", /*click_handler_6*/ ctx[8])
  				];

  				mounted = true;
  			}
  		},
  		p(ctx, dirty) {
  			if (dirty & /*$visibility*/ 2) {
  				toggle_class(li0, "checked", /*$visibility*/ ctx[1].component);
  			}

  			if (dirty & /*$visibility*/ 2) {
  				toggle_class(li1, "checked", /*$visibility*/ ctx[1].element);
  			}

  			if (dirty & /*$visibility*/ 2) {
  				toggle_class(li2, "checked", /*$visibility*/ ctx[1].block);
  			}

  			if (dirty & /*$visibility*/ 2) {
  				toggle_class(li3, "checked", /*$visibility*/ ctx[1].slot);
  			}

  			if (dirty & /*$visibility*/ 2) {
  				toggle_class(li4, "checked", /*$visibility*/ ctx[1].anchor);
  			}

  			if (dirty & /*$visibility*/ 2) {
  				toggle_class(li5, "checked", /*$visibility*/ ctx[1].text);
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			if (detaching) detach(ul);
  			mounted = false;
  			run_all(dispose);
  		}
  	};
  }

  // (90:11) <Button on:click={() => (isOpen = true)}>
  function create_default_slot$2(ctx) {
  	let svg;
  	let path;
  	let if_block_anchor;
  	let if_block = /*isOpen*/ ctx[0] && create_if_block$1(ctx);

  	return {
  		c() {
  			svg = svg_element("svg");
  			path = svg_element("path");
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  			attr(path, "d", "M8 2C4.36364 2 1.25818 4.28067 0 7.5 1.25818 10.71933 4.36364 13 8\n      13s6.74182-2.28067 8-5.5C14.74182 4.28067 11.63636 2 8 2zm0\n      9.16667c-2.00727 0-3.63636-1.64267-3.63636-3.66667S5.99273 3.83333 8\n      3.83333 11.63636 5.476 11.63636 7.5 10.00727 11.16667 8 11.16667zM8\n      5.3c-1.20727 0-2.18182.98267-2.18182 2.2S6.79273 9.7 8 9.7s2.18182-.98267\n      2.18182-2.2S9.20727 5.3 8 5.3z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path);
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  		},
  		p(ctx, dirty) {
  			if (/*isOpen*/ ctx[0]) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block$1(ctx);
  					if_block.c();
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function create_fragment$4(ctx) {
  	let button;
  	let current;

  	button = new Button({
  			props: {
  				$$slots: { default: [create_default_slot$2] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click_handler_7*/ ctx[9]);

  	return {
  		c() {
  			create_component(button.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(button, target, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			const button_changes = {};

  			if (dirty & /*$$scope, $visibility, isOpen*/ 1027) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(button, detaching);
  		}
  	};
  }

  function instance$4($$self, $$props, $$invalidate) {
  	let $visibility;
  	component_subscribe($$self, visibility, $$value => $$invalidate(1, $visibility = $$value));
  	let isOpen = false;
  	const click_handler = () => $$invalidate(0, isOpen = false);
  	const click_handler_1 = () => set_store_value(visibility, $visibility.component = !$visibility.component, $visibility);
  	const click_handler_2 = () => set_store_value(visibility, $visibility.element = !$visibility.element, $visibility);
  	const click_handler_3 = () => set_store_value(visibility, $visibility.block = !$visibility.block, $visibility);
  	const click_handler_4 = () => set_store_value(visibility, $visibility.slot = !$visibility.slot, $visibility);
  	const click_handler_5 = () => set_store_value(visibility, $visibility.anchor = !$visibility.anchor, $visibility);
  	const click_handler_6 = () => set_store_value(visibility, $visibility.text = !$visibility.text, $visibility);
  	const click_handler_7 = () => $$invalidate(0, isOpen = true);

  	return [
  		isOpen,
  		$visibility,
  		click_handler,
  		click_handler_1,
  		click_handler_2,
  		click_handler_3,
  		click_handler_4,
  		click_handler_5,
  		click_handler_6,
  		click_handler_7
  	];
  }

  class VisibilityButton extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$4, create_fragment$4, safe_not_equal, {});
  	}
  }

  /* src/ui/panel/Panel.svelte generated by Svelte v3.32.3 */

  function create_fragment$5(ctx) {
  	let div1;
  	let div0;
  	let div0_class_value;
  	let div1_style_value;
  	let current;
  	let mounted;
  	let dispose;
  	const default_slot_template = /*#slots*/ ctx[4].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[3], null);

  	return {
  		c() {
  			div1 = element("div");
  			div0 = element("div");
  			if (default_slot) default_slot.c();
  			attr(div0, "class", div0_class_value = "" + (/*grow*/ ctx[0] + " resize" + " svelte-131jtav"));
  			attr(div1, "style", div1_style_value = "" + ((/*grow*/ ctx[0] == "horizontal" ? "width" : "height") + ": " + /*size*/ ctx[1] + "px"));
  			attr(div1, "class", "svelte-131jtav");
  		},
  		m(target, anchor) {
  			insert$1(target, div1, anchor);
  			append(div1, div0);

  			if (default_slot) {
  				default_slot.m(div1, null);
  			}

  			current = true;

  			if (!mounted) {
  				dispose = listen(div0, "mousedown", /*resize*/ ctx[2]);
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			if (!current || dirty & /*grow*/ 1 && div0_class_value !== (div0_class_value = "" + (/*grow*/ ctx[0] + " resize" + " svelte-131jtav"))) {
  				attr(div0, "class", div0_class_value);
  			}

  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 8) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[3], dirty, null, null);
  				}
  			}

  			if (!current || dirty & /*grow, size*/ 3 && div1_style_value !== (div1_style_value = "" + ((/*grow*/ ctx[0] == "horizontal" ? "width" : "height") + ": " + /*size*/ ctx[1] + "px"))) {
  				attr(div1, "style", div1_style_value);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div1);
  			if (default_slot) default_slot.d(detaching);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function instance$5($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;
  	let { grow = "horizontal" } = $$props;
  	let size = 300;

  	function resize(e) {
  		const defaultView = e.target.ownerDocument.defaultView;

  		function handleResize(e) {
  			$$invalidate(1, size = grow == "horizontal"
  			? defaultView.innerWidth - e.x
  			: defaultView.innerHeight - e.y);
  		}

  		defaultView.addEventListener("mousemove", handleResize);
  		defaultView.addEventListener("mouseup", () => defaultView.removeEventListener("mousemove", handleResize));
  	}

  	$$self.$$set = $$props => {
  		if ("grow" in $$props) $$invalidate(0, grow = $$props.grow);
  		if ("$$scope" in $$props) $$invalidate(3, $$scope = $$props.$$scope);
  	};

  	return [grow, size, resize, $$scope, slots];
  }

  class Panel extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$5, create_fragment$5, safe_not_equal, { grow: 0 });
  	}
  }

  /* src/ui/nodes/Collapse.svelte generated by Svelte v3.32.3 */

  function create_fragment$6(ctx) {
  	let span;
  	let span_class_value;
  	let mounted;
  	let dispose;

  	return {
  		c() {
  			span = element("span");
  			attr(span, "class", span_class_value = "" + (null_to_empty(/*className*/ ctx[2]) + " svelte-y3ayvn"));
  			toggle_class(span, "selected", /*selected*/ ctx[1]);
  			toggle_class(span, "collapsed", /*collapsed*/ ctx[0]);
  		},
  		m(target, anchor) {
  			insert$1(target, span, anchor);

  			if (!mounted) {
  				dispose = listen(span, "click", /*click_handler*/ ctx[3]);
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			if (dirty & /*className*/ 4 && span_class_value !== (span_class_value = "" + (null_to_empty(/*className*/ ctx[2]) + " svelte-y3ayvn"))) {
  				attr(span, "class", span_class_value);
  			}

  			if (dirty & /*className, selected*/ 6) {
  				toggle_class(span, "selected", /*selected*/ ctx[1]);
  			}

  			if (dirty & /*className, collapsed*/ 5) {
  				toggle_class(span, "collapsed", /*collapsed*/ ctx[0]);
  			}
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(span);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function instance$6($$self, $$props, $$invalidate) {
  	let { selected = false } = $$props;
  	let { collapsed } = $$props;
  	let { class: className } = $$props;
  	const click_handler = () => $$invalidate(0, collapsed = !collapsed);

  	$$self.$$set = $$props => {
  		if ("selected" in $$props) $$invalidate(1, selected = $$props.selected);
  		if ("collapsed" in $$props) $$invalidate(0, collapsed = $$props.collapsed);
  		if ("class" in $$props) $$invalidate(2, className = $$props.class);
  	};

  	return [collapsed, selected, className, click_handler];
  }

  class Collapse extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$6, create_fragment$6, safe_not_equal, { selected: 1, collapsed: 0, class: 2 });
  	}
  }

  /* src/ui/panel/Editable.svelte generated by Svelte v3.32.3 */

  function create_else_block(ctx) {
  	let span;
  	let t_value = JSON.stringify(/*value*/ ctx[0]) + "";
  	let t;
  	let span_class_value;
  	let mounted;
  	let dispose;

  	return {
  		c() {
  			span = element("span");
  			t = text(t_value);
  			attr(span, "class", span_class_value = "" + (null_to_empty(/*className*/ ctx[2]) + " svelte-1e74dxt"));
  			toggle_class(span, "readOnly", /*readOnly*/ ctx[1]);
  		},
  		m(target, anchor) {
  			insert$1(target, span, anchor);
  			append(span, t);

  			if (!mounted) {
  				dispose = listen(span, "click", /*click_handler*/ ctx[8]);
  				mounted = true;
  			}
  		},
  		p(ctx, dirty) {
  			if (dirty & /*value*/ 1 && t_value !== (t_value = JSON.stringify(/*value*/ ctx[0]) + "")) set_data(t, t_value);

  			if (dirty & /*className*/ 4 && span_class_value !== (span_class_value = "" + (null_to_empty(/*className*/ ctx[2]) + " svelte-1e74dxt"))) {
  				attr(span, "class", span_class_value);
  			}

  			if (dirty & /*className, readOnly*/ 6) {
  				toggle_class(span, "readOnly", /*readOnly*/ ctx[1]);
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(span);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  // (34:11) {#if isEditing}
  function create_if_block$2(ctx) {
  	let input_1;
  	let input_1_value_value;
  	let mounted;
  	let dispose;

  	return {
  		c() {
  			input_1 = element("input");
  			input_1.value = input_1_value_value = JSON.stringify(/*value*/ ctx[0]);
  			attr(input_1, "class", "svelte-1e74dxt");
  		},
  		m(target, anchor) {
  			insert$1(target, input_1, anchor);
  			/*input_1_binding*/ ctx[6](input_1);

  			if (!mounted) {
  				dispose = [
  					listen(input_1, "keydown", /*keydown_handler*/ ctx[7]),
  					listen(input_1, "blur", /*commit*/ ctx[5])
  				];

  				mounted = true;
  			}
  		},
  		p(ctx, dirty) {
  			if (dirty & /*value*/ 1 && input_1_value_value !== (input_1_value_value = JSON.stringify(/*value*/ ctx[0])) && input_1.value !== input_1_value_value) {
  				input_1.value = input_1_value_value;
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(input_1);
  			/*input_1_binding*/ ctx[6](null);
  			mounted = false;
  			run_all(dispose);
  		}
  	};
  }

  function create_fragment$7(ctx) {
  	let if_block_anchor;

  	function select_block_type(ctx, dirty) {
  		if (/*isEditing*/ ctx[4]) return create_if_block$2;
  		return create_else_block;
  	}

  	let current_block_type = select_block_type(ctx);
  	let if_block = current_block_type(ctx);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  		},
  		p(ctx, [dirty]) {
  			if (current_block_type === (current_block_type = select_block_type(ctx)) && if_block) {
  				if_block.p(ctx, dirty);
  			} else {
  				if_block.d(1);
  				if_block = current_block_type(ctx);

  				if (if_block) {
  					if_block.c();
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			}
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function instance$7($$self, $$props, $$invalidate) {
  	let { value } = $$props;
  	let { readOnly } = $$props;
  	let { class: className } = $$props;
  	const dispatch = createEventDispatcher();

  	function commit(e) {
  		$$invalidate(4, isEditing = false);
  		dispatch("change", e.target.value);
  	}

  	let isEditing = false;
  	let input;

  	function input_1_binding($$value) {
  		binding_callbacks[$$value ? "unshift" : "push"](() => {
  			input = $$value;
  			$$invalidate(3, input);
  		});
  	}

  	const keydown_handler = e => e.key == "Enter" && commit(e);
  	const click_handler = () => $$invalidate(4, isEditing = !readOnly);

  	$$self.$$set = $$props => {
  		if ("value" in $$props) $$invalidate(0, value = $$props.value);
  		if ("readOnly" in $$props) $$invalidate(1, readOnly = $$props.readOnly);
  		if ("class" in $$props) $$invalidate(2, className = $$props.class);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*input*/ 8) {
  			if (input) input.select();
  		}
  	};

  	return [
  		value,
  		readOnly,
  		className,
  		input,
  		isEditing,
  		commit,
  		input_1_binding,
  		keydown_handler,
  		click_handler
  	];
  }

  class Editable extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$7, create_fragment$7, safe_not_equal, { value: 0, readOnly: 1, class: 2 });
  	}
  }

  /* src/ui/panel/CollapsableValue.svelte generated by Svelte v3.32.3 */

  function get_each_context_1(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[3] = list[i][0];
  	child_ctx[13] = list[i][1];
  	return child_ctx;
  }

  function get_each_context(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[13] = list[i];
  	child_ctx[3] = i;
  	return child_ctx;
  }

  // (98:118) 
  function create_if_block_7(ctx) {
  	let show_if;
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let current;
  	const if_block_creators = [create_if_block_8, create_if_block_10, create_if_block_11, create_else_block_1];
  	const if_blocks = [];

  	function select_block_type_2(ctx, dirty) {
  		if (/*value*/ ctx[2].__isFunction) return 0;
  		if (/*value*/ ctx[2].__isSymbol) return 1;
  		if (dirty & /*value*/ 4) show_if = !!Object.keys(/*value*/ ctx[2]).length;
  		if (show_if) return 2;
  		return 3;
  	}

  	current_block_type_index = select_block_type_2(ctx, -1);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type_2(ctx, dirty);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  // (92:368) 
  function create_if_block_4(ctx) {
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let current;
  	const if_block_creators = [create_if_block_5, create_else_block$1];
  	const if_blocks = [];

  	function select_block_type_1(ctx, dirty) {
  		if (/*value*/ ctx[2].length) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type_1(ctx);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type_1(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  // (92:269) 
  function create_if_block_3(ctx) {
  	let t0;
  	let t1;
  	let editable;
  	let current;

  	editable = new Editable({
  			props: {
  				class: "number",
  				readOnly: /*readOnly*/ ctx[1],
  				value: /*value*/ ctx[2]
  			}
  		});

  	editable.$on("change", /*change_handler_2*/ ctx[9]);

  	return {
  		c() {
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			create_component(editable.$$.fragment);
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			mount_component(editable, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (!current || dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  			const editable_changes = {};
  			if (dirty & /*readOnly*/ 2) editable_changes.readOnly = /*readOnly*/ ctx[1];
  			if (dirty & /*value*/ 4) editable_changes.value = /*value*/ ctx[2];
  			editable.$set(editable_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(editable.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(editable.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			destroy_component(editable, detaching);
  		}
  	};
  }

  // (92:155) 
  function create_if_block_2(ctx) {
  	let t0;
  	let t1;
  	let editable;
  	let current;

  	editable = new Editable({
  			props: {
  				class: "null",
  				readOnly: /*readOnly*/ ctx[1],
  				value: /*value*/ ctx[2]
  			}
  		});

  	editable.$on("change", /*change_handler_1*/ ctx[8]);

  	return {
  		c() {
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			create_component(editable.$$.fragment);
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			mount_component(editable, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (!current || dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  			const editable_changes = {};
  			if (dirty & /*readOnly*/ 2) editable_changes.readOnly = /*readOnly*/ ctx[1];
  			if (dirty & /*value*/ 4) editable_changes.value = /*value*/ ctx[2];
  			editable.$set(editable_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(editable.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(editable.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			destroy_component(editable, detaching);
  		}
  	};
  }

  // (92:1) {#if type == 'string'}
  function create_if_block_1(ctx) {
  	let t0;
  	let t1;
  	let editable;
  	let current;

  	editable = new Editable({
  			props: {
  				class: "string",
  				readOnly: /*readOnly*/ ctx[1],
  				value: /*value*/ ctx[2]
  			}
  		});

  	editable.$on("change", /*change_handler*/ ctx[7]);

  	return {
  		c() {
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			create_component(editable.$$.fragment);
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			mount_component(editable, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (!current || dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  			const editable_changes = {};
  			if (dirty & /*readOnly*/ 2) editable_changes.readOnly = /*readOnly*/ ctx[1];
  			if (dirty & /*value*/ 4) editable_changes.value = /*value*/ ctx[2];
  			editable.$set(editable_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(editable.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(editable.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			destroy_component(editable, detaching);
  		}
  	};
  }

  // (104:31) {:else}
  function create_else_block_1(ctx) {
  	let t0;
  	let t1;
  	let span;

  	return {
  		c() {
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			span = element("span");
  			span.textContent = "Object { }";
  			attr(span, "class", "object svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, span, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(span);
  		}
  	};
  }

  // (98:440) 
  function create_if_block_11(ctx) {
  	let collapse;
  	let t0;
  	let t1;
  	let span;
  	let if_block_anchor;
  	let current;

  	collapse = new Collapse({
  			props: {
  				class: "collapse",
  				collapsed: /*collapsed*/ ctx[4]
  			}
  		});

  	let if_block = !/*collapsed*/ ctx[4] && create_if_block_12(ctx);

  	return {
  		c() {
  			create_component(collapse.$$.fragment);
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			span = element("span");
  			span.textContent = "Object {…}";
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  			attr(span, "class", "object svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			mount_component(collapse, target, anchor);
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, span, anchor);
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const collapse_changes = {};
  			if (dirty & /*collapsed*/ 16) collapse_changes.collapsed = /*collapsed*/ ctx[4];
  			collapse.$set(collapse_changes);
  			if (!current || dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);

  			if (!/*collapsed*/ ctx[4]) {
  				if (if_block) {
  					if_block.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 16) {
  						transition_in(if_block, 1);
  					}
  				} else {
  					if_block = create_if_block_12(ctx);
  					if_block.c();
  					transition_in(if_block, 1);
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				group_outros();

  				transition_out(if_block, 1, 1, () => {
  					if_block = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapse.$$.fragment, local);
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapse.$$.fragment, local);
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(collapse, detaching);
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(span);
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  // (98:338) 
  function create_if_block_10(ctx) {
  	let t0;
  	let t1;
  	let span;
  	let t2_value = (/*value*/ ctx[2].name || "Symbol()") + "";
  	let t2;

  	return {
  		c() {
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			span = element("span");
  			t2 = text(t2_value);
  			attr(span, "class", "symbol svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, span, anchor);
  			append(span, t2);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  			if (dirty & /*value*/ 4 && t2_value !== (t2_value = (/*value*/ ctx[2].name || "Symbol()") + "")) set_data(t2, t2_value);
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(span);
  		}
  	};
  }

  // (98:118) {#if value.__isFunction}
  function create_if_block_8(ctx) {
  	let collapse;
  	let t0;
  	let t1;
  	let span;
  	let t2;
  	let t3_value = (/*value*/ ctx[2].name || "") + "";
  	let t3;
  	let t4;
  	let if_block_anchor;
  	let current;

  	collapse = new Collapse({
  			props: {
  				class: "collapse",
  				collapsed: /*collapsed*/ ctx[4]
  			}
  		});

  	let if_block = !/*collapsed*/ ctx[4] && create_if_block_9(ctx);

  	return {
  		c() {
  			create_component(collapse.$$.fragment);
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			span = element("span");
  			t2 = text("function ");
  			t3 = text(t3_value);
  			t4 = text(" ()");
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  			attr(span, "class", "function svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			mount_component(collapse, target, anchor);
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, span, anchor);
  			append(span, t2);
  			append(span, t3);
  			append(span, t4);
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const collapse_changes = {};
  			if (dirty & /*collapsed*/ 16) collapse_changes.collapsed = /*collapsed*/ ctx[4];
  			collapse.$set(collapse_changes);
  			if (!current || dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  			if ((!current || dirty & /*value*/ 4) && t3_value !== (t3_value = (/*value*/ ctx[2].name || "") + "")) set_data(t3, t3_value);

  			if (!/*collapsed*/ ctx[4]) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block_9(ctx);
  					if_block.c();
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapse.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapse.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(collapse, detaching);
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(span);
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  // (98:552) {#if !collapsed}
  function create_if_block_12(ctx) {
  	let ul;
  	let each_blocks = [];
  	let each_1_lookup = new Map();
  	let current;
  	let each_value_1 = Object.entries(/*value*/ ctx[2]);
  	const get_key = ctx => /*key*/ ctx[3];

  	for (let i = 0; i < each_value_1.length; i += 1) {
  		let child_ctx = get_each_context_1(ctx, each_value_1, i);
  		let key = get_key(child_ctx);
  		each_1_lookup.set(key, each_blocks[i] = create_each_block_1(key, child_ctx));
  	}

  	return {
  		c() {
  			ul = element("ul");

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			attr(ul, "class", "svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			insert$1(target, ul, anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			current = true;
  		},
  		p(ctx, dirty) {
  			if (dirty & /*readOnly, Object, value, dispatch, stringify*/ 70) {
  				each_value_1 = Object.entries(/*value*/ ctx[2]);
  				group_outros();
  				each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value_1, each_1_lookup, ul, outro_and_destroy_block, create_each_block_1, null, get_each_context_1);
  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value_1.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(ul);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].d();
  			}
  		}
  	};
  }

  // (98:572) {#each Object.entries(value) as [key, v] (key)}
  function create_each_block_1(key_2, ctx) {
  	let first;
  	let collapsablevalue;
  	let current;

  	function change_handler_4(...args) {
  		return /*change_handler_4*/ ctx[11](/*key*/ ctx[3], ...args);
  	}

  	collapsablevalue = new CollapsableValue({
  			props: {
  				readOnly: /*readOnly*/ ctx[1],
  				key: /*key*/ ctx[3],
  				value: /*v*/ ctx[13]
  			}
  		});

  	collapsablevalue.$on("change", change_handler_4);

  	return {
  		key: key_2,
  		first: null,
  		c() {
  			first = empty();
  			create_component(collapsablevalue.$$.fragment);
  			this.first = first;
  		},
  		m(target, anchor) {
  			insert$1(target, first, anchor);
  			mount_component(collapsablevalue, target, anchor);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			const collapsablevalue_changes = {};
  			if (dirty & /*readOnly*/ 2) collapsablevalue_changes.readOnly = /*readOnly*/ ctx[1];
  			if (dirty & /*value*/ 4) collapsablevalue_changes.key = /*key*/ ctx[3];
  			if (dirty & /*value*/ 4) collapsablevalue_changes.value = /*v*/ ctx[13];
  			collapsablevalue.$set(collapsablevalue_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapsablevalue.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapsablevalue.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(first);
  			destroy_component(collapsablevalue, detaching);
  		}
  	};
  }

  // (98:265) {#if !collapsed}
  function create_if_block_9(ctx) {
  	let pre;
  	let t_value = /*value*/ ctx[2].source + "";
  	let t;

  	return {
  		c() {
  			pre = element("pre");
  			t = text(t_value);
  		},
  		m(target, anchor) {
  			insert$1(target, pre, anchor);
  			append(pre, t);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*value*/ 4 && t_value !== (t_value = /*value*/ ctx[2].source + "")) set_data(t, t_value);
  		},
  		d(detaching) {
  			if (detaching) detach(pre);
  		}
  	};
  }

  // (98:31) {:else}
  function create_else_block$1(ctx) {
  	let t0;
  	let t1;
  	let span;

  	return {
  		c() {
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			span = element("span");
  			span.textContent = "Array []";
  			attr(span, "class", "object svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, span, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(span);
  		}
  	};
  }

  // (92:368) {#if value.length}
  function create_if_block_5(ctx) {
  	let collapse;
  	let t0;
  	let t1;
  	let span;
  	let t2;
  	let t3_value = /*value*/ ctx[2].length + "";
  	let t3;
  	let t4;
  	let if_block_anchor;
  	let current;

  	collapse = new Collapse({
  			props: {
  				class: "collapse",
  				collapsed: /*collapsed*/ ctx[4]
  			}
  		});

  	let if_block = !/*collapsed*/ ctx[4] && create_if_block_6(ctx);

  	return {
  		c() {
  			create_component(collapse.$$.fragment);
  			t0 = text(/*key*/ ctx[3]);
  			t1 = text(": ");
  			span = element("span");
  			t2 = text("Array [");
  			t3 = text(t3_value);
  			t4 = text("]");
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  			attr(span, "class", "object svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			mount_component(collapse, target, anchor);
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  			insert$1(target, span, anchor);
  			append(span, t2);
  			append(span, t3);
  			append(span, t4);
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const collapse_changes = {};
  			if (dirty & /*collapsed*/ 16) collapse_changes.collapsed = /*collapsed*/ ctx[4];
  			collapse.$set(collapse_changes);
  			if (!current || dirty & /*key*/ 8) set_data(t0, /*key*/ ctx[3]);
  			if ((!current || dirty & /*value*/ 4) && t3_value !== (t3_value = /*value*/ ctx[2].length + "")) set_data(t3, t3_value);

  			if (!/*collapsed*/ ctx[4]) {
  				if (if_block) {
  					if_block.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 16) {
  						transition_in(if_block, 1);
  					}
  				} else {
  					if_block = create_if_block_6(ctx);
  					if_block.c();
  					transition_in(if_block, 1);
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				group_outros();

  				transition_out(if_block, 1, 1, () => {
  					if_block = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapse.$$.fragment, local);
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapse.$$.fragment, local);
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(collapse, detaching);
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  			if (detaching) detach(span);
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  // (92:489) {#if !collapsed}
  function create_if_block_6(ctx) {
  	let ul;
  	let current;
  	let each_value = /*value*/ ctx[2];
  	let each_blocks = [];

  	for (let i = 0; i < each_value.length; i += 1) {
  		each_blocks[i] = create_each_block(get_each_context(ctx, each_value, i));
  	}

  	const out = i => transition_out(each_blocks[i], 1, 1, () => {
  		each_blocks[i] = null;
  	});

  	return {
  		c() {
  			ul = element("ul");

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			attr(ul, "class", "svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			insert$1(target, ul, anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			current = true;
  		},
  		p(ctx, dirty) {
  			if (dirty & /*readOnly, value, dispatch, stringify*/ 70) {
  				each_value = /*value*/ ctx[2];
  				let i;

  				for (i = 0; i < each_value.length; i += 1) {
  					const child_ctx = get_each_context(ctx, each_value, i);

  					if (each_blocks[i]) {
  						each_blocks[i].p(child_ctx, dirty);
  						transition_in(each_blocks[i], 1);
  					} else {
  						each_blocks[i] = create_each_block(child_ctx);
  						each_blocks[i].c();
  						transition_in(each_blocks[i], 1);
  						each_blocks[i].m(ul, null);
  					}
  				}

  				group_outros();

  				for (i = each_value.length; i < each_blocks.length; i += 1) {
  					out(i);
  				}

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			each_blocks = each_blocks.filter(Boolean);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(ul);
  			destroy_each(each_blocks, detaching);
  		}
  	};
  }

  // (92:509) {#each value as v, key}
  function create_each_block(ctx) {
  	let collapsablevalue;
  	let current;

  	function change_handler_3(...args) {
  		return /*change_handler_3*/ ctx[10](/*key*/ ctx[3], ...args);
  	}

  	collapsablevalue = new CollapsableValue({
  			props: {
  				readOnly: /*readOnly*/ ctx[1],
  				key: /*key*/ ctx[3],
  				value: /*v*/ ctx[13]
  			}
  		});

  	collapsablevalue.$on("change", change_handler_3);

  	return {
  		c() {
  			create_component(collapsablevalue.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(collapsablevalue, target, anchor);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			const collapsablevalue_changes = {};
  			if (dirty & /*readOnly*/ 2) collapsablevalue_changes.readOnly = /*readOnly*/ ctx[1];
  			if (dirty & /*value*/ 4) collapsablevalue_changes.value = /*v*/ ctx[13];
  			collapsablevalue.$set(collapsablevalue_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapsablevalue.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapsablevalue.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(collapsablevalue, detaching);
  		}
  	};
  }

  // (104:112) {#if errorMessage}
  function create_if_block$3(ctx) {
  	let span;

  	return {
  		c() {
  			span = element("span");
  			span.textContent = "!";
  			attr(span, "class", "error svelte-19h4tbk");
  		},
  		m(target, anchor) {
  			insert$1(target, span, anchor);
  		},
  		d(detaching) {
  			if (detaching) detach(span);
  		}
  	};
  }

  function create_fragment$8(ctx) {
  	let li;
  	let show_if;
  	let current_block_type_index;
  	let if_block0;
  	let if_block0_anchor;
  	let current;
  	let mounted;
  	let dispose;

  	const if_block_creators = [
  		create_if_block_1,
  		create_if_block_2,
  		create_if_block_3,
  		create_if_block_4,
  		create_if_block_7
  	];

  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*type*/ ctx[5] == "string") return 0;
  		if (/*value*/ ctx[2] == null || /*value*/ ctx[2] == undefined || /*value*/ ctx[2] != /*value*/ ctx[2]) return 1;
  		if (/*type*/ ctx[5] == "number" || /*type*/ ctx[5] == "boolean") return 2;
  		if (dirty & /*value*/ 4) show_if = !!Array.isArray(/*value*/ ctx[2]);
  		if (show_if) return 3;
  		if (/*type*/ ctx[5] == "object") return 4;
  		return -1;
  	}

  	if (~(current_block_type_index = select_block_type(ctx, -1))) {
  		if_block0 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  	}

  	let if_block1 = /*errorMessage*/ ctx[0] && create_if_block$3();
  	let li_levels = [{ "data-tooltip": /*errorMessage*/ ctx[0] }];
  	let li_data = {};

  	for (let i = 0; i < li_levels.length; i += 1) {
  		li_data = assign(li_data, li_levels[i]);
  	}

  	return {
  		c() {
  			li = element("li");
  			if (if_block0) if_block0.c();
  			if_block0_anchor = empty();
  			if (if_block1) if_block1.c();
  			set_attributes(li, li_data);
  			toggle_class(li, "svelte-19h4tbk", true);
  		},
  		m(target, anchor) {
  			insert$1(target, li, anchor);

  			if (~current_block_type_index) {
  				if_blocks[current_block_type_index].m(li, null);
  			}

  			append(li, if_block0_anchor);
  			if (if_block1) if_block1.m(li, null);
  			current = true;

  			if (!mounted) {
  				dispose = listen(li, "click", stop_propagation(/*click_handler*/ ctx[12]));
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx, dirty);

  			if (current_block_type_index === previous_block_index) {
  				if (~current_block_type_index) {
  					if_blocks[current_block_type_index].p(ctx, dirty);
  				}
  			} else {
  				if (if_block0) {
  					group_outros();

  					transition_out(if_blocks[previous_block_index], 1, 1, () => {
  						if_blocks[previous_block_index] = null;
  					});

  					check_outros();
  				}

  				if (~current_block_type_index) {
  					if_block0 = if_blocks[current_block_type_index];

  					if (!if_block0) {
  						if_block0 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  						if_block0.c();
  					} else {
  						if_block0.p(ctx, dirty);
  					}

  					transition_in(if_block0, 1);
  					if_block0.m(li, if_block0_anchor);
  				} else {
  					if_block0 = null;
  				}
  			}

  			if (/*errorMessage*/ ctx[0]) {
  				if (if_block1) ; else {
  					if_block1 = create_if_block$3();
  					if_block1.c();
  					if_block1.m(li, null);
  				}
  			} else if (if_block1) {
  				if_block1.d(1);
  				if_block1 = null;
  			}

  			set_attributes(li, li_data = get_spread_update(li_levels, [dirty & /*errorMessage*/ 1 && { "data-tooltip": /*errorMessage*/ ctx[0] }]));
  			toggle_class(li, "svelte-19h4tbk", true);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block0);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block0);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(li);

  			if (~current_block_type_index) {
  				if_blocks[current_block_type_index].d();
  			}

  			if (if_block1) if_block1.d();
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function stringify(value, k, v) {
  	if (Array.isArray(value)) return `[${value.map((value, i) => i == k ? v : stringify(value)).join(",")}]`;
  	if (value === null) return "null";
  	if (value === undefined) return "undefined";

  	switch (typeof value) {
  		case "string":
  			return `"${value}"`;
  		case "number":
  			return value.toString();
  		case "object":
  			return `{${Object.entries(value).map(([key, value]) => `"${key}":${key == k ? v : stringify(value)}`).join(",")}}`;
  	}
  }

  function instance$8($$self, $$props, $$invalidate) {
  	let type;
  	let { errorMessage } = $$props;
  	let { readOnly } = $$props;
  	let { value } = $$props;
  	let { key } = $$props;
  	const dispatch = createEventDispatcher();
  	let collapsed = true;

  	function change_handler(event) {
  		bubble($$self, event);
  	}

  	function change_handler_1(event) {
  		bubble($$self, event);
  	}

  	function change_handler_2(event) {
  		bubble($$self, event);
  	}

  	const change_handler_3 = (key, e) => dispatch("change", stringify(value, key, e.detail));
  	const change_handler_4 = (key, e) => dispatch("change", stringify(value, key, e.detail));
  	const click_handler = () => $$invalidate(4, collapsed = !collapsed);

  	$$self.$$set = $$props => {
  		if ("errorMessage" in $$props) $$invalidate(0, errorMessage = $$props.errorMessage);
  		if ("readOnly" in $$props) $$invalidate(1, readOnly = $$props.readOnly);
  		if ("value" in $$props) $$invalidate(2, value = $$props.value);
  		if ("key" in $$props) $$invalidate(3, key = $$props.key);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*value*/ 4) {
  			$$invalidate(5, type = typeof value);
  		}
  	};

  	return [
  		errorMessage,
  		readOnly,
  		value,
  		key,
  		collapsed,
  		type,
  		dispatch,
  		change_handler,
  		change_handler_1,
  		change_handler_2,
  		change_handler_3,
  		change_handler_4,
  		click_handler
  	];
  }

  class CollapsableValue extends SvelteComponent {
  	constructor(options) {
  		super();

  		init(this, options, instance$8, create_fragment$8, safe_not_equal, {
  			errorMessage: 0,
  			readOnly: 1,
  			value: 2,
  			key: 3
  		});
  	}
  }

  /* src/ui/panel/PropertyList.svelte generated by Svelte v3.32.3 */

  function get_each_context$1(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[8] = list[i].key;
  	child_ctx[9] = list[i].value;
  	return child_ctx;
  }

  // (51:20) {:else}
  function create_else_block$2(ctx) {
  	let div;

  	return {
  		c() {
  			div = element("div");
  			div.textContent = "None";
  			attr(div, "class", "empty svelte-kz400h");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  		},
  		p: noop,
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(div);
  		}
  	};
  }

  // (45:28) {#if entries.length}
  function create_if_block$4(ctx) {
  	let ul;
  	let each_blocks = [];
  	let each_1_lookup = new Map();
  	let current;
  	let each_value = /*entries*/ ctx[1];
  	const get_key = ctx => /*key*/ ctx[8];

  	for (let i = 0; i < each_value.length; i += 1) {
  		let child_ctx = get_each_context$1(ctx, each_value, i);
  		let key = get_key(child_ctx);
  		each_1_lookup.set(key, each_blocks[i] = create_each_block$1(key, child_ctx));
  	}

  	return {
  		c() {
  			ul = element("ul");

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			attr(ul, "class", "svelte-kz400h");
  		},
  		m(target, anchor) {
  			insert$1(target, ul, anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			current = true;
  		},
  		p(ctx, dirty) {
  			if (dirty & /*errorMessages, entries, readOnly, change*/ 30) {
  				each_value = /*entries*/ ctx[1];
  				group_outros();
  				each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value, each_1_lookup, ul, outro_and_destroy_block, create_each_block$1, null, get_each_context$1);
  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(ul);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].d();
  			}
  		}
  	};
  }

  // (45:52) {#each entries as { key, value }
  function create_each_block$1(key_1, ctx) {
  	let first;
  	let collapsablevalue;
  	let current;

  	function change_handler(...args) {
  		return /*change_handler*/ ctx[6](/*key*/ ctx[8], ...args);
  	}

  	collapsablevalue = new CollapsableValue({
  			props: {
  				errorMessage: /*errorMessages*/ ctx[3][/*key*/ ctx[8]],
  				readOnly: /*readOnly*/ ctx[2],
  				key: /*key*/ ctx[8],
  				value: /*value*/ ctx[9]
  			}
  		});

  	collapsablevalue.$on("change", change_handler);

  	return {
  		key: key_1,
  		first: null,
  		c() {
  			first = empty();
  			create_component(collapsablevalue.$$.fragment);
  			this.first = first;
  		},
  		m(target, anchor) {
  			insert$1(target, first, anchor);
  			mount_component(collapsablevalue, target, anchor);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			const collapsablevalue_changes = {};
  			if (dirty & /*errorMessages, entries*/ 10) collapsablevalue_changes.errorMessage = /*errorMessages*/ ctx[3][/*key*/ ctx[8]];
  			if (dirty & /*readOnly*/ 4) collapsablevalue_changes.readOnly = /*readOnly*/ ctx[2];
  			if (dirty & /*entries*/ 2) collapsablevalue_changes.key = /*key*/ ctx[8];
  			if (dirty & /*entries*/ 2) collapsablevalue_changes.value = /*value*/ ctx[9];
  			collapsablevalue.$set(collapsablevalue_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapsablevalue.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapsablevalue.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(first);
  			destroy_component(collapsablevalue, detaching);
  		}
  	};
  }

  function create_fragment$9(ctx) {
  	let h1;
  	let t;
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let current;
  	const if_block_creators = [create_if_block$4, create_else_block$2];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*entries*/ ctx[1].length) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type(ctx);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	return {
  		c() {
  			h1 = element("h1");
  			t = text(/*header*/ ctx[0]);
  			if_block.c();
  			if_block_anchor = empty();
  			attr(h1, "class", "svelte-kz400h");
  		},
  		m(target, anchor) {
  			insert$1(target, h1, anchor);
  			append(h1, t);
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			if (!current || dirty & /*header*/ 1) set_data(t, /*header*/ ctx[0]);
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(h1);
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function instance$9($$self, $$props, $$invalidate) {
  	const { injectState } = getContext$1();
  	let { header } = $$props;
  	let { entries = [] } = $$props;
  	let { id } = $$props;
  	let { readOnly = false } = $$props;
  	let errorMessages = {};

  	function change(key, value) {
  		try {
  			injectState(id, key, value);
  		} catch(error) {
  			$$invalidate(
  				3,
  				errorMessages[key] = error && error.isException
  				? error.value.substring(0, error.value.indexOf("\n"))
  				: error.message,
  				errorMessages
  			);
  		}
  	}

  	const change_handler = (key, e) => change(key, e.detail);

  	$$self.$$set = $$props => {
  		if ("header" in $$props) $$invalidate(0, header = $$props.header);
  		if ("entries" in $$props) $$invalidate(1, entries = $$props.entries);
  		if ("id" in $$props) $$invalidate(5, id = $$props.id);
  		if ("readOnly" in $$props) $$invalidate(2, readOnly = $$props.readOnly);
  	};

  	return [header, entries, readOnly, errorMessages, change, id, change_handler];
  }

  class PropertyList extends SvelteComponent {
  	constructor(options) {
  		super();

  		init(this, options, instance$9, create_fragment$9, safe_not_equal, {
  			header: 0,
  			entries: 1,
  			id: 5,
  			readOnly: 2
  		});
  	}
  }

  /* src/ui/panel/ComponentView.svelte generated by Svelte v3.32.3 */

  function create_default_slot_2(ctx) {
  	let svg;
  	let path;

  	return {
  		c() {
  			svg = svg_element("svg");
  			path = svg_element("path");
  			attr(path, "d", "M4.5 4a.5.5 0 0 0-.5.5v7c0 .28.22.5.5.5h7a.5.5 0 0 0\n            .5-.5v-7a.5.5 0 0 0-.5-.5h-7zM2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0\n            0 1 14 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7M.5\n            7.5a.5.5 0 0 0 0 1H2v-1H.5zM14 7.5h1.5a.5.5 0 0 1 0 1H14v-1zM8 0c.28\n            0 .5.22.5.5V2h-1V.5c0-.28.22-.5.5-.5zM8.5 14v1.5a.5.5 0 0 1-1\n            0V14h1z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path);
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  		}
  	};
  }

  // (33:36) <Toolbar>
  function create_default_slot_1$1(ctx) {
  	let div;
  	let button;
  	let current;

  	button = new Button({
  			props: {
  				disabled: /*$selectedNode*/ ctx[0].id === undefined,
  				$$slots: { default: [create_default_slot_2] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click_handler*/ ctx[2]);

  	return {
  		c() {
  			div = element("div");
  			create_component(button.$$.fragment);
  			attr(div, "class", "spacer svelte-1l8s776");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(button, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const button_changes = {};
  			if (dirty & /*$selectedNode*/ 1) button_changes.disabled = /*$selectedNode*/ ctx[0].id === undefined;

  			if (dirty & /*$$scope*/ 8) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(button, detaching);
  		}
  	};
  }

  // (56:52) 
  function create_if_block_2$1(ctx) {
  	let propertylist;
  	let current;

  	propertylist = new PropertyList({
  			props: {
  				readOnly: true,
  				id: /*$selectedNode*/ ctx[0].id,
  				header: "Attributes",
  				entries: /*$selectedNode*/ ctx[0].detail.attributes
  			}
  		});

  	return {
  		c() {
  			create_component(propertylist.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(propertylist, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const propertylist_changes = {};
  			if (dirty & /*$selectedNode*/ 1) propertylist_changes.id = /*$selectedNode*/ ctx[0].id;
  			if (dirty & /*$selectedNode*/ 1) propertylist_changes.entries = /*$selectedNode*/ ctx[0].detail.attributes;
  			propertylist.$set(propertylist_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(propertylist.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(propertylist.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(propertylist, detaching);
  		}
  	};
  }

  // (51:87) 
  function create_if_block_1$1(ctx) {
  	let propertylist;
  	let current;

  	propertylist = new PropertyList({
  			props: {
  				readOnly: true,
  				id: /*$selectedNode*/ ctx[0].id,
  				header: "State",
  				entries: /*$selectedNode*/ ctx[0].detail.ctx
  			}
  		});

  	return {
  		c() {
  			create_component(propertylist.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(propertylist, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const propertylist_changes = {};
  			if (dirty & /*$selectedNode*/ 1) propertylist_changes.id = /*$selectedNode*/ ctx[0].id;
  			if (dirty & /*$selectedNode*/ 1) propertylist_changes.entries = /*$selectedNode*/ ctx[0].detail.ctx;
  			propertylist.$set(propertylist_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(propertylist.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(propertylist.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(propertylist, detaching);
  		}
  	};
  }

  // (43:58) {#if $selectedNode.type == 'component'}
  function create_if_block$5(ctx) {
  	let propertylist0;
  	let propertylist1;
  	let current;

  	propertylist0 = new PropertyList({
  			props: {
  				id: /*$selectedNode*/ ctx[0].id,
  				header: "Props",
  				entries: /*$selectedNode*/ ctx[0].detail.attributes
  			}
  		});

  	propertylist1 = new PropertyList({
  			props: {
  				id: /*$selectedNode*/ ctx[0].id,
  				header: "State",
  				entries: /*$selectedNode*/ ctx[0].detail.ctx
  			}
  		});

  	return {
  		c() {
  			create_component(propertylist0.$$.fragment);
  			create_component(propertylist1.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(propertylist0, target, anchor);
  			mount_component(propertylist1, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const propertylist0_changes = {};
  			if (dirty & /*$selectedNode*/ 1) propertylist0_changes.id = /*$selectedNode*/ ctx[0].id;
  			if (dirty & /*$selectedNode*/ 1) propertylist0_changes.entries = /*$selectedNode*/ ctx[0].detail.attributes;
  			propertylist0.$set(propertylist0_changes);
  			const propertylist1_changes = {};
  			if (dirty & /*$selectedNode*/ 1) propertylist1_changes.id = /*$selectedNode*/ ctx[0].id;
  			if (dirty & /*$selectedNode*/ 1) propertylist1_changes.entries = /*$selectedNode*/ ctx[0].detail.ctx;
  			propertylist1.$set(propertylist1_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(propertylist0.$$.fragment, local);
  			transition_in(propertylist1.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(propertylist0.$$.fragment, local);
  			transition_out(propertylist1.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(propertylist0, detaching);
  			destroy_component(propertylist1, detaching);
  		}
  	};
  }

  // (33:11) <Panel>
  function create_default_slot$3(ctx) {
  	let div1;
  	let toolbar;
  	let div0;
  	let current_block_type_index;
  	let if_block;
  	let current;

  	toolbar = new Toolbar({
  			props: {
  				$$slots: { default: [create_default_slot_1$1] },
  				$$scope: { ctx }
  			}
  		});

  	const if_block_creators = [create_if_block$5, create_if_block_1$1, create_if_block_2$1];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*$selectedNode*/ ctx[0].type == "component") return 0;
  		if (/*$selectedNode*/ ctx[0].type == "block" || /*$selectedNode*/ ctx[0].type == "iteration") return 1;
  		if (/*$selectedNode*/ ctx[0].type == "element") return 2;
  		return -1;
  	}

  	if (~(current_block_type_index = select_block_type(ctx))) {
  		if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  	}

  	return {
  		c() {
  			div1 = element("div");
  			create_component(toolbar.$$.fragment);
  			div0 = element("div");
  			if (if_block) if_block.c();
  			attr(div0, "class", "content svelte-1l8s776");
  			attr(div1, "class", "root svelte-1l8s776");
  		},
  		m(target, anchor) {
  			insert$1(target, div1, anchor);
  			mount_component(toolbar, div1, null);
  			append(div1, div0);

  			if (~current_block_type_index) {
  				if_blocks[current_block_type_index].m(div0, null);
  			}

  			current = true;
  		},
  		p(ctx, dirty) {
  			const toolbar_changes = {};

  			if (dirty & /*$$scope, $selectedNode*/ 9) {
  				toolbar_changes.$$scope = { dirty, ctx };
  			}

  			toolbar.$set(toolbar_changes);
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if (~current_block_type_index) {
  					if_blocks[current_block_type_index].p(ctx, dirty);
  				}
  			} else {
  				if (if_block) {
  					group_outros();

  					transition_out(if_blocks[previous_block_index], 1, 1, () => {
  						if_blocks[previous_block_index] = null;
  					});

  					check_outros();
  				}

  				if (~current_block_type_index) {
  					if_block = if_blocks[current_block_type_index];

  					if (!if_block) {
  						if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  						if_block.c();
  					} else {
  						if_block.p(ctx, dirty);
  					}

  					transition_in(if_block, 1);
  					if_block.m(div0, null);
  				} else {
  					if_block = null;
  				}
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(toolbar.$$.fragment, local);
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(toolbar.$$.fragment, local);
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div1);
  			destroy_component(toolbar);

  			if (~current_block_type_index) {
  				if_blocks[current_block_type_index].d();
  			}
  		}
  	};
  }

  function create_fragment$a(ctx) {
  	let panel;
  	let current;

  	panel = new Panel({
  			props: {
  				$$slots: { default: [create_default_slot$3] },
  				$$scope: { ctx }
  			}
  		});

  	return {
  		c() {
  			create_component(panel.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(panel, target, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			const panel_changes = {};

  			if (dirty & /*$$scope, $selectedNode*/ 9) {
  				panel_changes.$$scope = { dirty, ctx };
  			}

  			panel.$set(panel_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(panel.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(panel.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(panel, detaching);
  		}
  	};
  }

  function instance$a($$self, $$props, $$invalidate) {
  	let $selectedNode;
  	component_subscribe($$self, selectedNode, $$value => $$invalidate(0, $selectedNode = $$value));
  	const { inspect } = getContext$1();
  	const click_handler = () => inspect($selectedNode.id);
  	return [$selectedNode, inspect, click_handler];
  }

  class ComponentView extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$a, create_fragment$a, safe_not_equal, {});
  	}
  }

  /* src/ui/profiler/Operation.svelte generated by Svelte v3.32.3 */

  function create_fragment$b(ctx) {
  	let div;
  	let t0;
  	let span;
  	let t1_value = /*frame*/ ctx[0].node.tagName + "";
  	let t1;
  	let div_class_value;
  	let mounted;
  	let dispose;

  	return {
  		c() {
  			div = element("div");
  			t0 = text("‌");
  			span = element("span");
  			t1 = text(t1_value);
  			attr(div, "class", div_class_value = "" + (null_to_empty(/*frame*/ ctx[0].type) + " svelte-11jbbiy"));
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			append(div, t0);
  			append(div, span);
  			append(span, t1);

  			if (!mounted) {
  				dispose = listen(div, "click", /*click_handler*/ ctx[2]);
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			if (dirty & /*frame*/ 1 && t1_value !== (t1_value = /*frame*/ ctx[0].node.tagName + "")) set_data(t1, t1_value);

  			if (dirty & /*frame*/ 1 && div_class_value !== (div_class_value = "" + (null_to_empty(/*frame*/ ctx[0].type) + " svelte-11jbbiy"))) {
  				attr(div, "class", div_class_value);
  			}
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(div);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function instance$b($$self, $$props, $$invalidate) {
  	const dispatch = createEventDispatcher();
  	let { frame } = $$props;
  	const click_handler = () => dispatch("click", frame);

  	$$self.$$set = $$props => {
  		if ("frame" in $$props) $$invalidate(0, frame = $$props.frame);
  	};

  	return [frame, dispatch, click_handler];
  }

  class Operation extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$b, create_fragment$b, safe_not_equal, { frame: 0 });
  	}
  }

  /* src/ui/profiler/Frame.svelte generated by Svelte v3.32.3 */

  function get_each_context$2(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[4] = list[i];
  	child_ctx[6] = i;
  	return child_ctx;
  }

  // (16:11) {#if children}
  function create_if_block$6(ctx) {
  	let ul;
  	let current;
  	let each_value = /*children*/ ctx[0];
  	let each_blocks = [];

  	for (let i = 0; i < each_value.length; i += 1) {
  		each_blocks[i] = create_each_block$2(get_each_context$2(ctx, each_value, i));
  	}

  	const out = i => transition_out(each_blocks[i], 1, 1, () => {
  		each_blocks[i] = null;
  	});

  	return {
  		c() {
  			ul = element("ul");

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			attr(ul, "class", "svelte-1xgh790");
  		},
  		m(target, anchor) {
  			insert$1(target, ul, anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			current = true;
  		},
  		p(ctx, dirty) {
  			if (dirty & /*children, duration*/ 3) {
  				each_value = /*children*/ ctx[0];
  				let i;

  				for (i = 0; i < each_value.length; i += 1) {
  					const child_ctx = get_each_context$2(ctx, each_value, i);

  					if (each_blocks[i]) {
  						each_blocks[i].p(child_ctx, dirty);
  						transition_in(each_blocks[i], 1);
  					} else {
  						each_blocks[i] = create_each_block$2(child_ctx);
  						each_blocks[i].c();
  						transition_in(each_blocks[i], 1);
  						each_blocks[i].m(ul, null);
  					}
  				}

  				group_outros();

  				for (i = each_value.length; i < each_blocks.length; i += 1) {
  					out(i);
  				}

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			each_blocks = each_blocks.filter(Boolean);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(ul);
  			destroy_each(each_blocks, detaching);
  		}
  	};
  }

  // (16:29) {#each children as child, i}
  function create_each_block$2(ctx) {
  	let li;
  	let operation;
  	let frame;
  	let current;
  	operation = new Operation({ props: { frame: /*child*/ ctx[4] } });
  	operation.$on("click", /*click_handler*/ ctx[2]);
  	const frame_spread_levels = [/*child*/ ctx[4]];
  	let frame_props = {};

  	for (let i = 0; i < frame_spread_levels.length; i += 1) {
  		frame_props = assign(frame_props, frame_spread_levels[i]);
  	}

  	frame = new Frame({ props: frame_props });
  	frame.$on("click", /*click_handler_1*/ ctx[3]);

  	return {
  		c() {
  			li = element("li");
  			create_component(operation.$$.fragment);
  			create_component(frame.$$.fragment);
  			set_style(li, "width", /*child*/ ctx[4].duration / /*duration*/ ctx[1] * 100 + "%");
  			attr(li, "class", "svelte-1xgh790");
  		},
  		m(target, anchor) {
  			insert$1(target, li, anchor);
  			mount_component(operation, li, null);
  			mount_component(frame, li, null);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const operation_changes = {};
  			if (dirty & /*children*/ 1) operation_changes.frame = /*child*/ ctx[4];
  			operation.$set(operation_changes);

  			const frame_changes = (dirty & /*children*/ 1)
  			? get_spread_update(frame_spread_levels, [get_spread_object(/*child*/ ctx[4])])
  			: {};

  			frame.$set(frame_changes);

  			if (!current || dirty & /*children, duration*/ 3) {
  				set_style(li, "width", /*child*/ ctx[4].duration / /*duration*/ ctx[1] * 100 + "%");
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(operation.$$.fragment, local);
  			transition_in(frame.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(operation.$$.fragment, local);
  			transition_out(frame.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(li);
  			destroy_component(operation);
  			destroy_component(frame);
  		}
  	};
  }

  function create_fragment$c(ctx) {
  	let if_block_anchor;
  	let current;
  	let if_block = /*children*/ ctx[0] && create_if_block$6(ctx);

  	return {
  		c() {
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			if (/*children*/ ctx[0]) {
  				if (if_block) {
  					if_block.p(ctx, dirty);

  					if (dirty & /*children*/ 1) {
  						transition_in(if_block, 1);
  					}
  				} else {
  					if_block = create_if_block$6(ctx);
  					if_block.c();
  					transition_in(if_block, 1);
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				group_outros();

  				transition_out(if_block, 1, 1, () => {
  					if_block = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function instance$c($$self, $$props, $$invalidate) {
  	let { children } = $$props;
  	let { duration } = $$props;

  	function click_handler(event) {
  		bubble($$self, event);
  	}

  	function click_handler_1(event) {
  		bubble($$self, event);
  	}

  	$$self.$$set = $$props => {
  		if ("children" in $$props) $$invalidate(0, children = $$props.children);
  		if ("duration" in $$props) $$invalidate(1, duration = $$props.duration);
  	};

  	return [children, duration, click_handler, click_handler_1];
  }

  class Frame extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$c, create_fragment$c, safe_not_equal, { children: 0, duration: 1 });
  	}
  }

  /* src/ui/profiler/Profiler.svelte generated by Svelte v3.32.3 */

  function create_else_block_1$1(ctx) {
  	let button;
  	let current;

  	button = new Button({
  			props: {
  				$$slots: { default: [create_default_slot_4] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click_handler_1*/ ctx[8]);

  	return {
  		c() {
  			create_component(button.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(button, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const button_changes = {};

  			if (dirty & /*$$scope*/ 1024) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(button, detaching);
  		}
  	};
  }

  // (53:20) {#if top}
  function create_if_block_2$2(ctx) {
  	let button;
  	let current;

  	button = new Button({
  			props: {
  				$$slots: { default: [create_default_slot_3] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click_handler*/ ctx[7]);

  	return {
  		c() {
  			create_component(button.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(button, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const button_changes = {};

  			if (dirty & /*$$scope*/ 1024) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(button, detaching);
  		}
  	};
  }

  // (53:201) <Button on:click={() => dispatch('close')}>
  function create_default_slot_4(ctx) {
  	let svg;
  	let path;

  	return {
  		c() {
  			svg = svg_element("svg");
  			path = svg_element("path");
  			attr(path, "d", "M12.7,1.4 11.3,0l-8,8 8,8 1.4,-1.4L6,8Z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path);
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  		}
  	};
  }

  // (53:29) <Button on:click={() => (top = null)}>
  function create_default_slot_3(ctx) {
  	let svg;
  	let path;

  	return {
  		c() {
  			svg = svg_element("svg");
  			path = svg_element("path");
  			attr(path, "d", "M12.7,1.4 11.3,0l-8,8 8,8 1.4,-1.4L6,8Z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path);
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  		}
  	};
  }

  // (53:376) <Button     on:click={() => {       $profileFrame = {}       top = null       selected = null     }}   >
  function create_default_slot_2$1(ctx) {
  	let svg;
  	let path;

  	return {
  		c() {
  			svg = svg_element("svg");
  			path = svg_element("path");
  			attr(path, "d", "m2.7,14.2 c 0,1 0.8,1.8 1.8,1.8h7c1,0 1.8,-0.8\n        1.8,-1.8V3.6H2.7ZM14.2,0.9H11L10.2,0H5.8L4.9,0.9H1.8V2.7h12.5z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path);
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  		}
  	};
  }

  // (53:11) <Toolbar>
  function create_default_slot_1$2(ctx) {
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let button;
  	let current;
  	const if_block_creators = [create_if_block_2$2, create_else_block_1$1];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*top*/ ctx[0]) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type(ctx);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	button = new Button({
  			props: {
  				$$slots: { default: [create_default_slot_2$1] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click_handler_2*/ ctx[9]);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  			create_component(button.$$.fragment);
  		},
  		m(target, anchor) {
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			mount_component(button, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}

  			const button_changes = {};

  			if (dirty & /*$$scope*/ 1024) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			transition_in(button.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			transition_out(button.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  			destroy_component(button, detaching);
  		}
  	};
  }

  // (62:127) {:else}
  function create_else_block$3(ctx) {
  	let p;

  	return {
  		c() {
  			p = element("p");
  			p.textContent = "Nothing to display. Perform an action to generate frames.";
  			attr(p, "class", "svelte-1e93on8");
  		},
  		m(target, anchor) {
  			insert$1(target, p, anchor);
  		},
  		p: noop,
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(p);
  		}
  	};
  }

  // (62:52) {#if children.length}
  function create_if_block_1$2(ctx) {
  	let frame;
  	let current;

  	frame = new Frame({
  			props: {
  				children: /*children*/ ctx[1],
  				duration: /*duration*/ ctx[4]
  			}
  		});

  	frame.$on("click", /*handleClick*/ ctx[6]);

  	return {
  		c() {
  			create_component(frame.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(frame, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const frame_changes = {};
  			if (dirty & /*children*/ 2) frame_changes.children = /*children*/ ctx[1];
  			if (dirty & /*duration*/ 16) frame_changes.duration = /*duration*/ ctx[4];
  			frame.$set(frame_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(frame.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(frame.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(frame, detaching);
  		}
  	};
  }

  // (62:209) {#if selected}
  function create_if_block$7(ctx) {
  	let panel;
  	let current;

  	panel = new Panel({
  			props: {
  				grow: "vertical",
  				$$slots: { default: [create_default_slot$4] },
  				$$scope: { ctx }
  			}
  		});

  	return {
  		c() {
  			create_component(panel.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(panel, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const panel_changes = {};

  			if (dirty & /*$$scope, selected*/ 1032) {
  				panel_changes.$$scope = { dirty, ctx };
  			}

  			panel.$set(panel_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(panel.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(panel.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(panel, detaching);
  		}
  	};
  }

  // (62:223) <Panel grow="vertical">
  function create_default_slot$4(ctx) {
  	let div6;
  	let div0;
  	let span0;
  	let t1_value = /*selected*/ ctx[3].node.tagName + "";
  	let t1;
  	let t2;
  	let t3_value = /*selected*/ ctx[3].node.id + "";
  	let t3;
  	let t4;
  	let div1;
  	let span1;
  	let t6_value = round(/*selected*/ ctx[3].start) + "";
  	let t6;
  	let t7;
  	let div2;
  	let span2;
  	let t9_value = /*selected*/ ctx[3].type + "";
  	let t9;
  	let div3;
  	let span3;
  	let t11_value = /*selected*/ ctx[3].node.type + "";
  	let t11;
  	let div4;
  	let span4;
  	let t13_value = round(/*selected*/ ctx[3].end) + "";
  	let t13;
  	let t14;
  	let div5;
  	let span5;
  	let t16_value = round(/*selected*/ ctx[3].children.reduce(func, /*selected*/ ctx[3].duration)) + "";
  	let t16;
  	let t17;
  	let t18_value = round(/*selected*/ ctx[3].duration) + "";
  	let t18;
  	let t19;

  	return {
  		c() {
  			div6 = element("div");
  			div0 = element("div");
  			span0 = element("span");
  			span0.textContent = "Tag name";
  			t1 = text(t1_value);
  			t2 = text(" (#");
  			t3 = text(t3_value);
  			t4 = text(")");
  			div1 = element("div");
  			span1 = element("span");
  			span1.textContent = "Start";
  			t6 = text(t6_value);
  			t7 = text("ms");
  			div2 = element("div");
  			span2 = element("span");
  			span2.textContent = "Operation";
  			t9 = text(t9_value);
  			div3 = element("div");
  			span3 = element("span");
  			span3.textContent = "Block type";
  			t11 = text(t11_value);
  			div4 = element("div");
  			span4 = element("span");
  			span4.textContent = "End";
  			t13 = text(t13_value);
  			t14 = text("ms");
  			div5 = element("div");
  			span5 = element("span");
  			span5.textContent = "Duration";
  			t16 = text(t16_value);
  			t17 = text("ms of ");
  			t18 = text(t18_value);
  			t19 = text("ms");
  			attr(span0, "class", "svelte-1e93on8");
  			attr(div0, "class", "svelte-1e93on8");
  			attr(span1, "class", "svelte-1e93on8");
  			attr(div1, "class", "svelte-1e93on8");
  			attr(span2, "class", "svelte-1e93on8");
  			attr(div2, "class", "svelte-1e93on8");
  			attr(span3, "class", "svelte-1e93on8");
  			attr(div3, "class", "svelte-1e93on8");
  			attr(span4, "class", "svelte-1e93on8");
  			attr(div4, "class", "svelte-1e93on8");
  			attr(span5, "class", "svelte-1e93on8");
  			attr(div5, "class", "svelte-1e93on8");
  			attr(div6, "class", "panel svelte-1e93on8");
  		},
  		m(target, anchor) {
  			insert$1(target, div6, anchor);
  			append(div6, div0);
  			append(div0, span0);
  			append(div0, t1);
  			append(div0, t2);
  			append(div0, t3);
  			append(div0, t4);
  			append(div6, div1);
  			append(div1, span1);
  			append(div1, t6);
  			append(div1, t7);
  			append(div6, div2);
  			append(div2, span2);
  			append(div2, t9);
  			append(div6, div3);
  			append(div3, span3);
  			append(div3, t11);
  			append(div6, div4);
  			append(div4, span4);
  			append(div4, t13);
  			append(div4, t14);
  			append(div6, div5);
  			append(div5, span5);
  			append(div5, t16);
  			append(div5, t17);
  			append(div5, t18);
  			append(div5, t19);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*selected*/ 8 && t1_value !== (t1_value = /*selected*/ ctx[3].node.tagName + "")) set_data(t1, t1_value);
  			if (dirty & /*selected*/ 8 && t3_value !== (t3_value = /*selected*/ ctx[3].node.id + "")) set_data(t3, t3_value);
  			if (dirty & /*selected*/ 8 && t6_value !== (t6_value = round(/*selected*/ ctx[3].start) + "")) set_data(t6, t6_value);
  			if (dirty & /*selected*/ 8 && t9_value !== (t9_value = /*selected*/ ctx[3].type + "")) set_data(t9, t9_value);
  			if (dirty & /*selected*/ 8 && t11_value !== (t11_value = /*selected*/ ctx[3].node.type + "")) set_data(t11, t11_value);
  			if (dirty & /*selected*/ 8 && t13_value !== (t13_value = round(/*selected*/ ctx[3].end) + "")) set_data(t13, t13_value);
  			if (dirty & /*selected*/ 8 && t16_value !== (t16_value = round(/*selected*/ ctx[3].children.reduce(func, /*selected*/ ctx[3].duration)) + "")) set_data(t16, t16_value);
  			if (dirty & /*selected*/ 8 && t18_value !== (t18_value = round(/*selected*/ ctx[3].duration) + "")) set_data(t18, t18_value);
  		},
  		d(detaching) {
  			if (detaching) detach(div6);
  		}
  	};
  }

  function create_fragment$d(ctx) {
  	let toolbar;
  	let div;
  	let current_block_type_index;
  	let if_block0;
  	let if_block1_anchor;
  	let current;

  	toolbar = new Toolbar({
  			props: {
  				$$slots: { default: [create_default_slot_1$2] },
  				$$scope: { ctx }
  			}
  		});

  	const if_block_creators = [create_if_block_1$2, create_else_block$3];
  	const if_blocks = [];

  	function select_block_type_1(ctx, dirty) {
  		if (/*children*/ ctx[1].length) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type_1(ctx);
  	if_block0 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  	let if_block1 = /*selected*/ ctx[3] && create_if_block$7(ctx);

  	return {
  		c() {
  			create_component(toolbar.$$.fragment);
  			div = element("div");
  			if_block0.c();
  			if (if_block1) if_block1.c();
  			if_block1_anchor = empty();
  			attr(div, "class", "frame svelte-1e93on8");
  		},
  		m(target, anchor) {
  			mount_component(toolbar, target, anchor);
  			insert$1(target, div, anchor);
  			if_blocks[current_block_type_index].m(div, null);
  			if (if_block1) if_block1.m(target, anchor);
  			insert$1(target, if_block1_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			const toolbar_changes = {};

  			if (dirty & /*$$scope, $profileFrame, top, selected*/ 1037) {
  				toolbar_changes.$$scope = { dirty, ctx };
  			}

  			toolbar.$set(toolbar_changes);
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type_1(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block0 = if_blocks[current_block_type_index];

  				if (!if_block0) {
  					if_block0 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block0.c();
  				} else {
  					if_block0.p(ctx, dirty);
  				}

  				transition_in(if_block0, 1);
  				if_block0.m(div, null);
  			}

  			if (/*selected*/ ctx[3]) {
  				if (if_block1) {
  					if_block1.p(ctx, dirty);

  					if (dirty & /*selected*/ 8) {
  						transition_in(if_block1, 1);
  					}
  				} else {
  					if_block1 = create_if_block$7(ctx);
  					if_block1.c();
  					transition_in(if_block1, 1);
  					if_block1.m(if_block1_anchor.parentNode, if_block1_anchor);
  				}
  			} else if (if_block1) {
  				group_outros();

  				transition_out(if_block1, 1, 1, () => {
  					if_block1 = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(toolbar.$$.fragment, local);
  			transition_in(if_block0);
  			transition_in(if_block1);
  			current = true;
  		},
  		o(local) {
  			transition_out(toolbar.$$.fragment, local);
  			transition_out(if_block0);
  			transition_out(if_block1);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(toolbar, detaching);
  			if (detaching) detach(div);
  			if_blocks[current_block_type_index].d();
  			if (if_block1) if_block1.d(detaching);
  			if (detaching) detach(if_block1_anchor);
  		}
  	};
  }

  function round(n) {
  	return Math.round(n * 100) / 100;
  }

  const func = (acc, o) => acc - o.duration;

  function instance$d($$self, $$props, $$invalidate) {
  	let children;
  	let duration;
  	let $profileFrame;
  	component_subscribe($$self, profileFrame, $$value => $$invalidate(2, $profileFrame = $$value));
  	const dispatch = createEventDispatcher();
  	let selected;
  	let top;

  	function handleClick(e) {
  		if (selected == e.detail) $$invalidate(0, top = e.detail); else $$invalidate(3, selected = e.detail);
  	}

  	const click_handler = () => $$invalidate(0, top = null);
  	const click_handler_1 = () => dispatch("close");

  	const click_handler_2 = () => {
  		set_store_value(profileFrame, $profileFrame = {}, $profileFrame);
  		$$invalidate(0, top = null);
  		$$invalidate(3, selected = null);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*top, $profileFrame*/ 5) {
  			$$invalidate(1, children = top ? [top] : $profileFrame.children || []);
  		}

  		if ($$self.$$.dirty & /*children*/ 2) {
  			$$invalidate(4, duration = children.reduce((acc, o) => acc + o.duration, 0));
  		}
  	};

  	return [
  		top,
  		children,
  		$profileFrame,
  		selected,
  		duration,
  		dispatch,
  		handleClick,
  		click_handler,
  		click_handler_1,
  		click_handler_2
  	];
  }

  class Profiler extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$d, create_fragment$d, safe_not_equal, {});
  	}
  }

  /* src/ui/Breadcrumbs.svelte generated by Svelte v3.32.3 */

  function get_each_context$3(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[10] = list[i];
  	return child_ctx;
  }

  // (92:11) {#if breadcrumbList.length > 1}
  function create_if_block$8(ctx) {
  	let ul;
  	let if_block_anchor;
  	let if_block = /*shorttend*/ ctx[3] && create_if_block_2$3();
  	let each_value = /*breadcrumbList*/ ctx[2];
  	let each_blocks = [];

  	for (let i = 0; i < each_value.length; i += 1) {
  		each_blocks[i] = create_each_block$3(get_each_context$3(ctx, each_value, i));
  	}

  	return {
  		c() {
  			ul = element("ul");
  			if (if_block) if_block.c();
  			if_block_anchor = empty();

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			attr(ul, "class", "svelte-1frls2x");
  		},
  		m(target, anchor) {
  			insert$1(target, ul, anchor);
  			if (if_block) if_block.m(ul, null);
  			append(ul, if_block_anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			/*ul_binding*/ ctx[8](ul);
  		},
  		p(ctx, dirty) {
  			if (/*shorttend*/ ctx[3]) {
  				if (if_block) ; else {
  					if_block = create_if_block_2$3();
  					if_block.c();
  					if_block.m(ul, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}

  			if (dirty & /*breadcrumbList, $selectedNode, $hoveredNodeId, $visibility*/ 53) {
  				each_value = /*breadcrumbList*/ ctx[2];
  				let i;

  				for (i = 0; i < each_value.length; i += 1) {
  					const child_ctx = get_each_context$3(ctx, each_value, i);

  					if (each_blocks[i]) {
  						each_blocks[i].p(child_ctx, dirty);
  					} else {
  						each_blocks[i] = create_each_block$3(child_ctx);
  						each_blocks[i].c();
  						each_blocks[i].m(ul, null);
  					}
  				}

  				for (; i < each_blocks.length; i += 1) {
  					each_blocks[i].d(1);
  				}

  				each_blocks.length = each_value.length;
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(ul);
  			if (if_block) if_block.d();
  			destroy_each(each_blocks, detaching);
  			/*ul_binding*/ ctx[8](null);
  		}
  	};
  }

  // (92:63) {#if shorttend}
  function create_if_block_2$3(ctx) {
  	let li;

  	return {
  		c() {
  			li = element("li");
  			li.innerHTML = `…<div class="svelte-1frls2x"></div>`;
  			attr(li, "class", "svelte-1frls2x");
  		},
  		m(target, anchor) {
  			insert$1(target, li, anchor);
  		},
  		d(detaching) {
  			if (detaching) detach(li);
  		}
  	};
  }

  // (92:137) {#if $visibility[node.type]}
  function create_if_block_1$3(ctx) {
  	let li;
  	let t_value = /*node*/ ctx[10].tagName + "";
  	let t;
  	let div;
  	let mounted;
  	let dispose;

  	function click_handler() {
  		return /*click_handler*/ ctx[6](/*node*/ ctx[10]);
  	}

  	function mouseover_handler() {
  		return /*mouseover_handler*/ ctx[7](/*node*/ ctx[10]);
  	}

  	return {
  		c() {
  			li = element("li");
  			t = text(t_value);
  			div = element("div");
  			attr(div, "class", "svelte-1frls2x");
  			attr(li, "class", "svelte-1frls2x");
  			toggle_class(li, "selected", /*node*/ ctx[10].id == /*$selectedNode*/ ctx[0].id);
  		},
  		m(target, anchor) {
  			insert$1(target, li, anchor);
  			append(li, t);
  			append(li, div);

  			if (!mounted) {
  				dispose = [
  					listen(li, "click", click_handler),
  					listen(li, "mouseover", mouseover_handler)
  				];

  				mounted = true;
  			}
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			if (dirty & /*breadcrumbList*/ 4 && t_value !== (t_value = /*node*/ ctx[10].tagName + "")) set_data(t, t_value);

  			if (dirty & /*breadcrumbList, $selectedNode*/ 5) {
  				toggle_class(li, "selected", /*node*/ ctx[10].id == /*$selectedNode*/ ctx[0].id);
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(li);
  			mounted = false;
  			run_all(dispose);
  		}
  	};
  }

  // (92:107) {#each breadcrumbList as node}
  function create_each_block$3(ctx) {
  	let if_block_anchor;
  	let if_block = /*$visibility*/ ctx[4][/*node*/ ctx[10].type] && create_if_block_1$3(ctx);

  	return {
  		c() {
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  		},
  		p(ctx, dirty) {
  			if (/*$visibility*/ ctx[4][/*node*/ ctx[10].type]) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block_1$3(ctx);
  					if_block.c();
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}
  		},
  		d(detaching) {
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function create_fragment$e(ctx) {
  	let if_block_anchor;
  	let if_block = /*breadcrumbList*/ ctx[2].length > 1 && create_if_block$8(ctx);

  	return {
  		c() {
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  		},
  		p(ctx, [dirty]) {
  			if (/*breadcrumbList*/ ctx[2].length > 1) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block$8(ctx);
  					if_block.c();
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function instance$e($$self, $$props, $$invalidate) {
  	let $selectedNode;
  	let $visibility;
  	let $hoveredNodeId;
  	component_subscribe($$self, selectedNode, $$value => $$invalidate(0, $selectedNode = $$value));
  	component_subscribe($$self, visibility, $$value => $$invalidate(4, $visibility = $$value));
  	component_subscribe($$self, hoveredNodeId, $$value => $$invalidate(5, $hoveredNodeId = $$value));
  	let root;
  	let breadcrumbList = [];
  	let shorttend;

  	async function setSelectedBreadcrumb(node) {
  		if (breadcrumbList.find(o => o.id == node.id)) return;
  		$$invalidate(2, breadcrumbList = []);

  		while (node && node.tagName) {
  			breadcrumbList.unshift(node);
  			node = node.parent;
  		}

  		$$invalidate(3, shorttend = false);
  		await tick();

  		while (root && root.scrollWidth > root.clientWidth) {
  			breadcrumbList.shift();
  			$$invalidate(3, shorttend = true);
  			$$invalidate(2, breadcrumbList);
  			await tick();
  		}
  	}

  	const click_handler = node => set_store_value(selectedNode, $selectedNode = node, $selectedNode);
  	const mouseover_handler = node => set_store_value(hoveredNodeId, $hoveredNodeId = node.id, $hoveredNodeId);

  	function ul_binding($$value) {
  		binding_callbacks[$$value ? "unshift" : "push"](() => {
  			root = $$value;
  			$$invalidate(1, root);
  		});
  	}

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*$selectedNode*/ 1) {
  			setSelectedBreadcrumb($selectedNode);
  		}
  	};

  	return [
  		$selectedNode,
  		root,
  		breadcrumbList,
  		shorttend,
  		$visibility,
  		$hoveredNodeId,
  		click_handler,
  		mouseover_handler,
  		ul_binding
  	];
  }

  class Breadcrumbs extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$e, create_fragment$e, safe_not_equal, {});
  	}
  }

  /* src/ui/ErrorMessage.svelte generated by Svelte v3.32.3 */

  function create_fragment$f(ctx) {
  	let div;

  	return {
  		c() {
  			div = element("div");
  			div.innerHTML = `<h1 class="svelte-voryue">Svelte not detected.</h1><p>Did you...</p><ul class="svelte-voryue"><li class="svelte-voryue">Use Svelte version 3.12.0 or above?</li><li class="svelte-voryue">Build with dev mode enabled?</li></ul>`;
  			attr(div, "class", "root svelte-voryue");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  		},
  		p: noop,
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(div);
  		}
  	};
  }

  class ErrorMessage extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, null, create_fragment$f, safe_not_equal, {});
  	}
  }

  /* src/ui/nodes/SearchTerm.svelte generated by Svelte v3.32.3 */

  function create_else_block$4(ctx) {
  	let t0;
  	let span;
  	let t1;
  	let t2;

  	return {
  		c() {
  			t0 = text(/*pre*/ ctx[3]);
  			span = element("span");
  			t1 = text(/*highlight*/ ctx[4]);
  			t2 = text(/*post*/ ctx[5]);
  			attr(span, "class", "svelte-q8dzkt");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, span, anchor);
  			append(span, t1);
  			insert$1(target, t2, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*pre*/ 8) set_data(t0, /*pre*/ ctx[3]);
  			if (dirty & /*highlight*/ 16) set_data(t1, /*highlight*/ ctx[4]);
  			if (dirty & /*post*/ 32) set_data(t2, /*post*/ ctx[5]);
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(span);
  			if (detaching) detach(t2);
  		}
  	};
  }

  // (16:11) {#if i == -1 || $searchValue.length < 2}
  function create_if_block$9(ctx) {
  	let t;

  	return {
  		c() {
  			t = text(/*text*/ ctx[0]);
  		},
  		m(target, anchor) {
  			insert$1(target, t, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*text*/ 1) set_data(t, /*text*/ ctx[0]);
  		},
  		d(detaching) {
  			if (detaching) detach(t);
  		}
  	};
  }

  function create_fragment$g(ctx) {
  	let if_block_anchor;

  	function select_block_type(ctx, dirty) {
  		if (/*i*/ ctx[1] == -1 || /*$searchValue*/ ctx[2].length < 2) return create_if_block$9;
  		return create_else_block$4;
  	}

  	let current_block_type = select_block_type(ctx);
  	let if_block = current_block_type(ctx);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if_block.m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  		},
  		p(ctx, [dirty]) {
  			if (current_block_type === (current_block_type = select_block_type(ctx)) && if_block) {
  				if_block.p(ctx, dirty);
  			} else {
  				if_block.d(1);
  				if_block = current_block_type(ctx);

  				if (if_block) {
  					if_block.c();
  					if_block.m(if_block_anchor.parentNode, if_block_anchor);
  				}
  			}
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if_block.d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function instance$f($$self, $$props, $$invalidate) {
  	let i;
  	let pre;
  	let highlight;
  	let post;
  	let $searchValue;
  	component_subscribe($$self, searchValue, $$value => $$invalidate(2, $searchValue = $$value));
  	let { text } = $$props;

  	$$self.$$set = $$props => {
  		if ("text" in $$props) $$invalidate(0, text = $$props.text);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*text, $searchValue*/ 5) {
  			$$invalidate(1, i = text ? text.indexOf($searchValue) : -1);
  		}

  		if ($$self.$$.dirty & /*text, i*/ 3) {
  			$$invalidate(3, pre = text ? text.substring(0, i) : "");
  		}

  		if ($$self.$$.dirty & /*text, i, $searchValue*/ 7) {
  			$$invalidate(4, highlight = text ? text.substring(i, i + $searchValue.length) : "");
  		}

  		if ($$self.$$.dirty & /*text, i, $searchValue*/ 7) {
  			$$invalidate(5, post = text ? text.substring(i + $searchValue.length) : "");
  		}
  	};

  	return [text, i, $searchValue, pre, highlight, post];
  }

  class SearchTerm extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$f, create_fragment$g, safe_not_equal, { text: 0 });
  	}
  }

  /* src/ui/nodes/ElementAttributes.svelte generated by Svelte v3.32.3 */

  function get_each_context$4(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[2] = list[i].event;
  	child_ctx[3] = list[i].handler;
  	child_ctx[4] = list[i].modifiers;
  	return child_ctx;
  }

  function get_each_context_1$1(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[7] = list[i].key;
  	child_ctx[8] = list[i].value;
  	child_ctx[9] = list[i].isBound;
  	child_ctx[10] = list[i].flash;
  	return child_ctx;
  }

  // (30:117) {#if isBound}
  function create_if_block_1$4(ctx) {
  	let t;

  	return {
  		c() {
  			t = text("bind:");
  		},
  		m(target, anchor) {
  			insert$1(target, t, anchor);
  		},
  		d(detaching) {
  			if (detaching) detach(t);
  		}
  	};
  }

  // (30:11) {#each attributes as { key, value, isBound, flash }
  function create_each_block_1$1(key_1, ctx) {
  	let t0;
  	let span2;
  	let span0;
  	let if_block_anchor;
  	let searchterm0;
  	let t1;
  	let span1;
  	let searchterm1;
  	let current;
  	let if_block = /*isBound*/ ctx[9] && create_if_block_1$4();
  	searchterm0 = new SearchTerm({ props: { text: /*key*/ ctx[7] } });
  	searchterm1 = new SearchTerm({ props: { text: /*value*/ ctx[8] } });

  	return {
  		key: key_1,
  		first: null,
  		c() {
  			t0 = text(" ");
  			span2 = element("span");
  			span0 = element("span");
  			if (if_block) if_block.c();
  			if_block_anchor = empty();
  			create_component(searchterm0.$$.fragment);
  			t1 = text("=");
  			span1 = element("span");
  			create_component(searchterm1.$$.fragment);
  			attr(span0, "class", "attr-name svelte-1eqzefe");
  			attr(span1, "class", "attr-value svelte-1eqzefe");
  			toggle_class(span2, "flash", /*flash*/ ctx[10]);
  			this.first = t0;
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, span2, anchor);
  			append(span2, span0);
  			if (if_block) if_block.m(span0, null);
  			append(span0, if_block_anchor);
  			mount_component(searchterm0, span0, null);
  			append(span2, t1);
  			append(span2, span1);
  			mount_component(searchterm1, span1, null);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;

  			if (/*isBound*/ ctx[9]) {
  				if (if_block) ; else {
  					if_block = create_if_block_1$4();
  					if_block.c();
  					if_block.m(span0, if_block_anchor);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}

  			const searchterm0_changes = {};
  			if (dirty & /*attributes*/ 1) searchterm0_changes.text = /*key*/ ctx[7];
  			searchterm0.$set(searchterm0_changes);
  			const searchterm1_changes = {};
  			if (dirty & /*attributes*/ 1) searchterm1_changes.text = /*value*/ ctx[8];
  			searchterm1.$set(searchterm1_changes);

  			if (dirty & /*attributes*/ 1) {
  				toggle_class(span2, "flash", /*flash*/ ctx[10]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm0.$$.fragment, local);
  			transition_in(searchterm1.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm0.$$.fragment, local);
  			transition_out(searchterm1.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(span2);
  			if (if_block) if_block.d();
  			destroy_component(searchterm0);
  			destroy_component(searchterm1);
  		}
  	};
  }

  // (33:33) {#if modifiers && modifiers.length}
  function create_if_block$a(ctx) {
  	let t0;
  	let t1_value = /*modifiers*/ ctx[4].join("|") + "";
  	let t1;

  	return {
  		c() {
  			t0 = text("|");
  			t1 = text(t1_value);
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, t1, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*listeners*/ 2 && t1_value !== (t1_value = /*modifiers*/ ctx[4].join("|") + "")) set_data(t1, t1_value);
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(t1);
  		}
  	};
  }

  // (30:246) {#each listeners as { event, handler, modifiers }}
  function create_each_block$4(ctx) {
  	let t0;
  	let span;
  	let t1;
  	let searchterm;
  	let span_data_tooltip_value;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*event*/ ctx[2] } });
  	let if_block = /*modifiers*/ ctx[4] && /*modifiers*/ ctx[4].length && create_if_block$a(ctx);

  	return {
  		c() {
  			t0 = text(" ");
  			span = element("span");
  			t1 = text("on:");
  			create_component(searchterm.$$.fragment);
  			if (if_block) if_block.c();
  			attr(span, "class", "attr-name svelte-1eqzefe");

  			attr(span, "data-tooltip", span_data_tooltip_value = typeof /*handler*/ ctx[3] == "function"
  			? /*handler*/ ctx[3]()
  			: /*handler*/ ctx[3]);
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, span, anchor);
  			append(span, t1);
  			mount_component(searchterm, span, null);
  			if (if_block) if_block.m(span, null);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const searchterm_changes = {};
  			if (dirty & /*listeners*/ 2) searchterm_changes.text = /*event*/ ctx[2];
  			searchterm.$set(searchterm_changes);

  			if (/*modifiers*/ ctx[4] && /*modifiers*/ ctx[4].length) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block$a(ctx);
  					if_block.c();
  					if_block.m(span, null);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}

  			if (!current || dirty & /*listeners*/ 2 && span_data_tooltip_value !== (span_data_tooltip_value = typeof /*handler*/ ctx[3] == "function"
  			? /*handler*/ ctx[3]()
  			: /*handler*/ ctx[3])) {
  				attr(span, "data-tooltip", span_data_tooltip_value);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(span);
  			destroy_component(searchterm);
  			if (if_block) if_block.d();
  		}
  	};
  }

  function create_fragment$h(ctx) {
  	let each_blocks_1 = [];
  	let each0_lookup = new Map();
  	let each0_anchor;
  	let each1_anchor;
  	let current;
  	let each_value_1 = /*attributes*/ ctx[0];
  	const get_key = ctx => /*key*/ ctx[7];

  	for (let i = 0; i < each_value_1.length; i += 1) {
  		let child_ctx = get_each_context_1$1(ctx, each_value_1, i);
  		let key = get_key(child_ctx);
  		each0_lookup.set(key, each_blocks_1[i] = create_each_block_1$1(key, child_ctx));
  	}

  	let each_value = /*listeners*/ ctx[1];
  	let each_blocks = [];

  	for (let i = 0; i < each_value.length; i += 1) {
  		each_blocks[i] = create_each_block$4(get_each_context$4(ctx, each_value, i));
  	}

  	const out = i => transition_out(each_blocks[i], 1, 1, () => {
  		each_blocks[i] = null;
  	});

  	return {
  		c() {
  			for (let i = 0; i < each_blocks_1.length; i += 1) {
  				each_blocks_1[i].c();
  			}

  			each0_anchor = empty();

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			each1_anchor = empty();
  		},
  		m(target, anchor) {
  			for (let i = 0; i < each_blocks_1.length; i += 1) {
  				each_blocks_1[i].m(target, anchor);
  			}

  			insert$1(target, each0_anchor, anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(target, anchor);
  			}

  			insert$1(target, each1_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			if (dirty & /*attributes*/ 1) {
  				each_value_1 = /*attributes*/ ctx[0];
  				group_outros();
  				each_blocks_1 = update_keyed_each(each_blocks_1, dirty, get_key, 1, ctx, each_value_1, each0_lookup, each0_anchor.parentNode, outro_and_destroy_block, create_each_block_1$1, each0_anchor, get_each_context_1$1);
  				check_outros();
  			}

  			if (dirty & /*listeners*/ 2) {
  				each_value = /*listeners*/ ctx[1];
  				let i;

  				for (i = 0; i < each_value.length; i += 1) {
  					const child_ctx = get_each_context$4(ctx, each_value, i);

  					if (each_blocks[i]) {
  						each_blocks[i].p(child_ctx, dirty);
  						transition_in(each_blocks[i], 1);
  					} else {
  						each_blocks[i] = create_each_block$4(child_ctx);
  						each_blocks[i].c();
  						transition_in(each_blocks[i], 1);
  						each_blocks[i].m(each1_anchor.parentNode, each1_anchor);
  					}
  				}

  				group_outros();

  				for (i = each_value.length; i < each_blocks.length; i += 1) {
  					out(i);
  				}

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value_1.length; i += 1) {
  				transition_in(each_blocks_1[i]);
  			}

  			for (let i = 0; i < each_value.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			for (let i = 0; i < each_blocks_1.length; i += 1) {
  				transition_out(each_blocks_1[i]);
  			}

  			each_blocks = each_blocks.filter(Boolean);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			for (let i = 0; i < each_blocks_1.length; i += 1) {
  				each_blocks_1[i].d(detaching);
  			}

  			if (detaching) detach(each0_anchor);
  			destroy_each(each_blocks, detaching);
  			if (detaching) detach(each1_anchor);
  		}
  	};
  }

  function instance$g($$self, $$props, $$invalidate) {
  	let { attributes } = $$props;
  	let { listeners } = $$props;

  	$$self.$$set = $$props => {
  		if ("attributes" in $$props) $$invalidate(0, attributes = $$props.attributes);
  		if ("listeners" in $$props) $$invalidate(1, listeners = $$props.listeners);
  	};

  	return [attributes, listeners];
  }

  class ElementAttributes extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$g, create_fragment$h, safe_not_equal, { attributes: 0, listeners: 1 });
  	}
  }

  /* src/ui/nodes/Element.svelte generated by Svelte v3.32.3 */

  function create_else_block$5(ctx) {
  	let div;
  	let t0;
  	let span;
  	let searchterm;
  	let elementattributes;
  	let t1;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[5] } });

  	elementattributes = new ElementAttributes({
  			props: {
  				attributes: /*_attributes*/ ctx[7],
  				listeners: /*listeners*/ ctx[6]
  			}
  		});

  	return {
  		c() {
  			div = element("div");
  			t0 = text("<");
  			span = element("span");
  			create_component(searchterm.$$.fragment);
  			create_component(elementattributes.$$.fragment);
  			t1 = text(" />");
  			attr(span, "class", "tag-name svelte-1hhhsbv");
  			attr(div, "style", /*style*/ ctx[1]);
  			attr(div, "class", "svelte-1hhhsbv");
  			toggle_class(div, "hover", /*hover*/ ctx[3]);
  			toggle_class(div, "selected", /*selected*/ ctx[4]);
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			append(div, t0);
  			append(div, span);
  			mount_component(searchterm, span, null);
  			mount_component(elementattributes, div, null);
  			append(div, t1);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 32) searchterm_changes.text = /*tagName*/ ctx[5];
  			searchterm.$set(searchterm_changes);
  			const elementattributes_changes = {};
  			if (dirty & /*_attributes*/ 128) elementattributes_changes.attributes = /*_attributes*/ ctx[7];
  			if (dirty & /*listeners*/ 64) elementattributes_changes.listeners = /*listeners*/ ctx[6];
  			elementattributes.$set(elementattributes_changes);

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 8) {
  				toggle_class(div, "hover", /*hover*/ ctx[3]);
  			}

  			if (dirty & /*selected*/ 16) {
  				toggle_class(div, "selected", /*selected*/ ctx[4]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			transition_in(elementattributes.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			transition_out(elementattributes.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(searchterm);
  			destroy_component(elementattributes);
  		}
  	};
  }

  // (63:11) {#if hasChildren}
  function create_if_block$b(ctx) {
  	let div;
  	let collapse;
  	let updating_collapsed;
  	let t0;
  	let span;
  	let searchterm;
  	let elementattributes;
  	let t1;
  	let if_block1_anchor;
  	let current;
  	let mounted;
  	let dispose;

  	function collapse_collapsed_binding(value) {
  		/*collapse_collapsed_binding*/ ctx[12](value);
  	}

  	let collapse_props = { selected: /*selected*/ ctx[4] };

  	if (/*collapsed*/ ctx[0] !== void 0) {
  		collapse_props.collapsed = /*collapsed*/ ctx[0];
  	}

  	collapse = new Collapse({ props: collapse_props });
  	binding_callbacks.push(() => bind(collapse, "collapsed", collapse_collapsed_binding));
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[5] } });

  	elementattributes = new ElementAttributes({
  			props: {
  				attributes: /*_attributes*/ ctx[7],
  				listeners: /*listeners*/ ctx[6]
  			}
  		});

  	let if_block0 = /*collapsed*/ ctx[0] && create_if_block_2$4(ctx);
  	let if_block1 = !/*collapsed*/ ctx[0] && create_if_block_1$5(ctx);

  	return {
  		c() {
  			div = element("div");
  			create_component(collapse.$$.fragment);
  			t0 = text("<");
  			span = element("span");
  			create_component(searchterm.$$.fragment);
  			create_component(elementattributes.$$.fragment);
  			t1 = text(">");
  			if (if_block0) if_block0.c();
  			if (if_block1) if_block1.c();
  			if_block1_anchor = empty();
  			attr(span, "class", "tag-name svelte-1hhhsbv");
  			attr(div, "style", /*style*/ ctx[1]);
  			attr(div, "class", "svelte-1hhhsbv");
  			toggle_class(div, "hover", /*hover*/ ctx[3]);
  			toggle_class(div, "selected", /*selected*/ ctx[4]);
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(collapse, div, null);
  			append(div, t0);
  			append(div, span);
  			mount_component(searchterm, span, null);
  			mount_component(elementattributes, div, null);
  			append(div, t1);
  			if (if_block0) if_block0.m(div, null);
  			if (if_block1) if_block1.m(target, anchor);
  			insert$1(target, if_block1_anchor, anchor);
  			current = true;

  			if (!mounted) {
  				dispose = listen(div, "dblclick", /*dblclick_handler*/ ctx[13]);
  				mounted = true;
  			}
  		},
  		p(ctx, dirty) {
  			const collapse_changes = {};
  			if (dirty & /*selected*/ 16) collapse_changes.selected = /*selected*/ ctx[4];

  			if (!updating_collapsed && dirty & /*collapsed*/ 1) {
  				updating_collapsed = true;
  				collapse_changes.collapsed = /*collapsed*/ ctx[0];
  				add_flush_callback(() => updating_collapsed = false);
  			}

  			collapse.$set(collapse_changes);
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 32) searchterm_changes.text = /*tagName*/ ctx[5];
  			searchterm.$set(searchterm_changes);
  			const elementattributes_changes = {};
  			if (dirty & /*_attributes*/ 128) elementattributes_changes.attributes = /*_attributes*/ ctx[7];
  			if (dirty & /*listeners*/ 64) elementattributes_changes.listeners = /*listeners*/ ctx[6];
  			elementattributes.$set(elementattributes_changes);

  			if (/*collapsed*/ ctx[0]) {
  				if (if_block0) {
  					if_block0.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 1) {
  						transition_in(if_block0, 1);
  					}
  				} else {
  					if_block0 = create_if_block_2$4(ctx);
  					if_block0.c();
  					transition_in(if_block0, 1);
  					if_block0.m(div, null);
  				}
  			} else if (if_block0) {
  				group_outros();

  				transition_out(if_block0, 1, 1, () => {
  					if_block0 = null;
  				});

  				check_outros();
  			}

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 8) {
  				toggle_class(div, "hover", /*hover*/ ctx[3]);
  			}

  			if (dirty & /*selected*/ 16) {
  				toggle_class(div, "selected", /*selected*/ ctx[4]);
  			}

  			if (!/*collapsed*/ ctx[0]) {
  				if (if_block1) {
  					if_block1.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 1) {
  						transition_in(if_block1, 1);
  					}
  				} else {
  					if_block1 = create_if_block_1$5(ctx);
  					if_block1.c();
  					transition_in(if_block1, 1);
  					if_block1.m(if_block1_anchor.parentNode, if_block1_anchor);
  				}
  			} else if (if_block1) {
  				group_outros();

  				transition_out(if_block1, 1, 1, () => {
  					if_block1 = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapse.$$.fragment, local);
  			transition_in(searchterm.$$.fragment, local);
  			transition_in(elementattributes.$$.fragment, local);
  			transition_in(if_block0);
  			transition_in(if_block1);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapse.$$.fragment, local);
  			transition_out(searchterm.$$.fragment, local);
  			transition_out(elementattributes.$$.fragment, local);
  			transition_out(if_block0);
  			transition_out(if_block1);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(collapse);
  			destroy_component(searchterm);
  			destroy_component(elementattributes);
  			if (if_block0) if_block0.d();
  			if (if_block1) if_block1.d(detaching);
  			if (detaching) detach(if_block1_anchor);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  // (68:166) {#if collapsed}
  function create_if_block_2$4(ctx) {
  	let t0;
  	let span;
  	let searchterm;
  	let t1;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[5] } });

  	return {
  		c() {
  			t0 = text("…</");
  			span = element("span");
  			create_component(searchterm.$$.fragment);
  			t1 = text(">");
  			attr(span, "class", "tag-name svelte-1hhhsbv");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			insert$1(target, span, anchor);
  			mount_component(searchterm, span, null);
  			insert$1(target, t1, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 32) searchterm_changes.text = /*tagName*/ ctx[5];
  			searchterm.$set(searchterm_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			if (detaching) detach(span);
  			destroy_component(searchterm);
  			if (detaching) detach(t1);
  		}
  	};
  }

  // (68:268) {#if !collapsed}
  function create_if_block_1$5(ctx) {
  	let div;
  	let t0;
  	let span;
  	let searchterm;
  	let t1;
  	let current;
  	const default_slot_template = /*#slots*/ ctx[11].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[10], null);
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[5] } });

  	return {
  		c() {
  			if (default_slot) default_slot.c();
  			div = element("div");
  			t0 = text("</");
  			span = element("span");
  			create_component(searchterm.$$.fragment);
  			t1 = text(">");
  			attr(span, "class", "tag-name svelte-1hhhsbv");
  			attr(div, "style", /*style*/ ctx[1]);
  			attr(div, "class", "svelte-1hhhsbv");
  			toggle_class(div, "hover", /*hover*/ ctx[3]);
  		},
  		m(target, anchor) {
  			if (default_slot) {
  				default_slot.m(target, anchor);
  			}

  			insert$1(target, div, anchor);
  			append(div, t0);
  			append(div, span);
  			mount_component(searchterm, span, null);
  			append(div, t1);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 1024) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[10], dirty, null, null);
  				}
  			}

  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 32) searchterm_changes.text = /*tagName*/ ctx[5];
  			searchterm.$set(searchterm_changes);

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 8) {
  				toggle_class(div, "hover", /*hover*/ ctx[3]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (default_slot) default_slot.d(detaching);
  			if (detaching) detach(div);
  			destroy_component(searchterm);
  		}
  	};
  }

  function create_fragment$i(ctx) {
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let current;
  	const if_block_creators = [create_if_block$b, create_else_block$5];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*hasChildren*/ ctx[2]) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type(ctx);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function stringify$1(value) {
  	switch (typeof value) {
  		case "string":
  			return `"${value}"`;
  		case "undefined":
  			return "undefined";
  		case "number":
  			return value != value ? "NaN" : value.toString();
  		case "object":
  			if (value == null) return "null";
  			if (Array.isArray(value)) return `[${value.map(stringify$1).join(", ")}]`;
  			if (value.__isFunction) return value.name + "()";
  			if (value.__isSymbol) return value.name;
  			return `{${Object.entries(value).map(([key, value]) => `${key}: ${stringify$1(value)}`).join(", ")}}`;
  	}
  }

  function instance$h($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;
  	let { style } = $$props;
  	let { hasChildren } = $$props;
  	let { hover } = $$props;
  	let { selected } = $$props;
  	let { tagName } = $$props;
  	let { attributes = [] } = $$props;
  	let { listeners = [] } = $$props;
  	let { collapsed } = $$props;
  	let _attributes;
  	let cache = {};

  	function collapse_collapsed_binding(value) {
  		collapsed = value;
  		$$invalidate(0, collapsed);
  	}

  	const dblclick_handler = () => $$invalidate(0, collapsed = !collapsed);

  	$$self.$$set = $$props => {
  		if ("style" in $$props) $$invalidate(1, style = $$props.style);
  		if ("hasChildren" in $$props) $$invalidate(2, hasChildren = $$props.hasChildren);
  		if ("hover" in $$props) $$invalidate(3, hover = $$props.hover);
  		if ("selected" in $$props) $$invalidate(4, selected = $$props.selected);
  		if ("tagName" in $$props) $$invalidate(5, tagName = $$props.tagName);
  		if ("attributes" in $$props) $$invalidate(8, attributes = $$props.attributes);
  		if ("listeners" in $$props) $$invalidate(6, listeners = $$props.listeners);
  		if ("collapsed" in $$props) $$invalidate(0, collapsed = $$props.collapsed);
  		if ("$$scope" in $$props) $$invalidate(10, $$scope = $$props.$$scope);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*attributes, _attributes, cache*/ 896) {
  			{
  				let localCache = {};

  				$$invalidate(7, _attributes = attributes.map(o => {
  					const value = stringify$1(o.value);
  					localCache[o.key] = value;

  					return {
  						...o,
  						value,
  						flash: !!_attributes && value != cache[o.key]
  					};
  				}));

  				$$invalidate(9, cache = localCache);
  			}
  		}
  	};

  	return [
  		collapsed,
  		style,
  		hasChildren,
  		hover,
  		selected,
  		tagName,
  		listeners,
  		_attributes,
  		attributes,
  		cache,
  		$$scope,
  		slots,
  		collapse_collapsed_binding,
  		dblclick_handler
  	];
  }

  class Element extends SvelteComponent {
  	constructor(options) {
  		super();

  		init(this, options, instance$h, create_fragment$i, safe_not_equal, {
  			style: 1,
  			hasChildren: 2,
  			hover: 3,
  			selected: 4,
  			tagName: 5,
  			attributes: 8,
  			listeners: 6,
  			collapsed: 0
  		});
  	}
  }

  /* src/ui/nodes/Block.svelte generated by Svelte v3.32.3 */

  function create_else_block$6(ctx) {
  	let t0;
  	let searchterm;
  	let t1;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[4] } });

  	return {
  		c() {
  			t0 = text("{#");
  			create_component(searchterm.$$.fragment);
  			t1 = text("}");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			mount_component(searchterm, target, anchor);
  			insert$1(target, t1, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 16) searchterm_changes.text = /*tagName*/ ctx[4];
  			searchterm.$set(searchterm_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			destroy_component(searchterm, detaching);
  			if (detaching) detach(t1);
  		}
  	};
  }

  // (31:39) {#if source}
  function create_if_block_2$5(ctx) {
  	let t;

  	return {
  		c() {
  			t = text(/*source*/ ctx[5]);
  		},
  		m(target, anchor) {
  			insert$1(target, t, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*source*/ 32) set_data(t, /*source*/ ctx[5]);
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(t);
  		}
  	};
  }

  // (31:117) {#if collapsed}
  function create_if_block_1$6(ctx) {
  	let t0;
  	let searchterm;
  	let t1;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[4] } });

  	return {
  		c() {
  			t0 = text("…{/");
  			create_component(searchterm.$$.fragment);
  			t1 = text("}");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			mount_component(searchterm, target, anchor);
  			insert$1(target, t1, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 16) searchterm_changes.text = /*tagName*/ ctx[4];
  			searchterm.$set(searchterm_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			destroy_component(searchterm, detaching);
  			if (detaching) detach(t1);
  		}
  	};
  }

  // (31:197) {#if !collapsed}
  function create_if_block$c(ctx) {
  	let div;
  	let t0;
  	let searchterm;
  	let t1;
  	let current;
  	const default_slot_template = /*#slots*/ ctx[7].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[6], null);
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[4] } });

  	return {
  		c() {
  			if (default_slot) default_slot.c();
  			div = element("div");
  			t0 = text("{/");
  			create_component(searchterm.$$.fragment);
  			t1 = text("}");
  			attr(div, "class", "tag-close tag-name svelte-x8r9lc");
  			attr(div, "style", /*style*/ ctx[1]);
  			toggle_class(div, "hover", /*hover*/ ctx[2]);
  		},
  		m(target, anchor) {
  			if (default_slot) {
  				default_slot.m(target, anchor);
  			}

  			insert$1(target, div, anchor);
  			append(div, t0);
  			mount_component(searchterm, div, null);
  			append(div, t1);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 64) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[6], dirty, null, null);
  				}
  			}

  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 16) searchterm_changes.text = /*tagName*/ ctx[4];
  			searchterm.$set(searchterm_changes);

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 4) {
  				toggle_class(div, "hover", /*hover*/ ctx[2]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (default_slot) default_slot.d(detaching);
  			if (detaching) detach(div);
  			destroy_component(searchterm);
  		}
  	};
  }

  function create_fragment$j(ctx) {
  	let div;
  	let collapse;
  	let updating_collapsed;
  	let current_block_type_index;
  	let if_block0;
  	let if_block0_anchor;
  	let if_block2_anchor;
  	let current;
  	let mounted;
  	let dispose;

  	function collapse_collapsed_binding(value) {
  		/*collapse_collapsed_binding*/ ctx[8](value);
  	}

  	let collapse_props = { selected: /*selected*/ ctx[3] };

  	if (/*collapsed*/ ctx[0] !== void 0) {
  		collapse_props.collapsed = /*collapsed*/ ctx[0];
  	}

  	collapse = new Collapse({ props: collapse_props });
  	binding_callbacks.push(() => bind(collapse, "collapsed", collapse_collapsed_binding));
  	const if_block_creators = [create_if_block_2$5, create_else_block$6];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*source*/ ctx[5]) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type(ctx);
  	if_block0 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  	let if_block1 = /*collapsed*/ ctx[0] && create_if_block_1$6(ctx);
  	let if_block2 = !/*collapsed*/ ctx[0] && create_if_block$c(ctx);

  	return {
  		c() {
  			div = element("div");
  			create_component(collapse.$$.fragment);
  			if_block0.c();
  			if_block0_anchor = empty();
  			if (if_block1) if_block1.c();
  			if (if_block2) if_block2.c();
  			if_block2_anchor = empty();
  			attr(div, "class", "tag-open tag-name svelte-x8r9lc");
  			attr(div, "style", /*style*/ ctx[1]);
  			toggle_class(div, "hover", /*hover*/ ctx[2]);
  			toggle_class(div, "selected", /*selected*/ ctx[3]);
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(collapse, div, null);
  			if_blocks[current_block_type_index].m(div, null);
  			append(div, if_block0_anchor);
  			if (if_block1) if_block1.m(div, null);
  			if (if_block2) if_block2.m(target, anchor);
  			insert$1(target, if_block2_anchor, anchor);
  			current = true;

  			if (!mounted) {
  				dispose = listen(div, "dblclick", /*dblclick_handler*/ ctx[9]);
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			const collapse_changes = {};
  			if (dirty & /*selected*/ 8) collapse_changes.selected = /*selected*/ ctx[3];

  			if (!updating_collapsed && dirty & /*collapsed*/ 1) {
  				updating_collapsed = true;
  				collapse_changes.collapsed = /*collapsed*/ ctx[0];
  				add_flush_callback(() => updating_collapsed = false);
  			}

  			collapse.$set(collapse_changes);
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block0 = if_blocks[current_block_type_index];

  				if (!if_block0) {
  					if_block0 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block0.c();
  				} else {
  					if_block0.p(ctx, dirty);
  				}

  				transition_in(if_block0, 1);
  				if_block0.m(div, if_block0_anchor);
  			}

  			if (/*collapsed*/ ctx[0]) {
  				if (if_block1) {
  					if_block1.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 1) {
  						transition_in(if_block1, 1);
  					}
  				} else {
  					if_block1 = create_if_block_1$6(ctx);
  					if_block1.c();
  					transition_in(if_block1, 1);
  					if_block1.m(div, null);
  				}
  			} else if (if_block1) {
  				group_outros();

  				transition_out(if_block1, 1, 1, () => {
  					if_block1 = null;
  				});

  				check_outros();
  			}

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 4) {
  				toggle_class(div, "hover", /*hover*/ ctx[2]);
  			}

  			if (dirty & /*selected*/ 8) {
  				toggle_class(div, "selected", /*selected*/ ctx[3]);
  			}

  			if (!/*collapsed*/ ctx[0]) {
  				if (if_block2) {
  					if_block2.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 1) {
  						transition_in(if_block2, 1);
  					}
  				} else {
  					if_block2 = create_if_block$c(ctx);
  					if_block2.c();
  					transition_in(if_block2, 1);
  					if_block2.m(if_block2_anchor.parentNode, if_block2_anchor);
  				}
  			} else if (if_block2) {
  				group_outros();

  				transition_out(if_block2, 1, 1, () => {
  					if_block2 = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapse.$$.fragment, local);
  			transition_in(if_block0);
  			transition_in(if_block1);
  			transition_in(if_block2);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapse.$$.fragment, local);
  			transition_out(if_block0);
  			transition_out(if_block1);
  			transition_out(if_block2);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(collapse);
  			if_blocks[current_block_type_index].d();
  			if (if_block1) if_block1.d();
  			if (if_block2) if_block2.d(detaching);
  			if (detaching) detach(if_block2_anchor);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function instance$i($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;
  	let { style } = $$props;
  	let { hover } = $$props;
  	let { selected } = $$props;
  	let { tagName } = $$props;
  	let { source } = $$props;
  	let { collapsed } = $$props;

  	function collapse_collapsed_binding(value) {
  		collapsed = value;
  		$$invalidate(0, collapsed);
  	}

  	const dblclick_handler = () => $$invalidate(0, collapsed = !collapsed);

  	$$self.$$set = $$props => {
  		if ("style" in $$props) $$invalidate(1, style = $$props.style);
  		if ("hover" in $$props) $$invalidate(2, hover = $$props.hover);
  		if ("selected" in $$props) $$invalidate(3, selected = $$props.selected);
  		if ("tagName" in $$props) $$invalidate(4, tagName = $$props.tagName);
  		if ("source" in $$props) $$invalidate(5, source = $$props.source);
  		if ("collapsed" in $$props) $$invalidate(0, collapsed = $$props.collapsed);
  		if ("$$scope" in $$props) $$invalidate(6, $$scope = $$props.$$scope);
  	};

  	return [
  		collapsed,
  		style,
  		hover,
  		selected,
  		tagName,
  		source,
  		$$scope,
  		slots,
  		collapse_collapsed_binding,
  		dblclick_handler
  	];
  }

  class Block extends SvelteComponent {
  	constructor(options) {
  		super();

  		init(this, options, instance$i, create_fragment$j, safe_not_equal, {
  			style: 1,
  			hover: 2,
  			selected: 3,
  			tagName: 4,
  			source: 5,
  			collapsed: 0
  		});
  	}
  }

  /* src/ui/nodes/Slot.svelte generated by Svelte v3.32.3 */

  function create_if_block_1$7(ctx) {
  	let t0;
  	let searchterm;
  	let t1;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[4] } });

  	return {
  		c() {
  			t0 = text("…</");
  			create_component(searchterm.$$.fragment);
  			t1 = text(">");
  		},
  		m(target, anchor) {
  			insert$1(target, t0, anchor);
  			mount_component(searchterm, target, anchor);
  			insert$1(target, t1, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 16) searchterm_changes.text = /*tagName*/ ctx[4];
  			searchterm.$set(searchterm_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(t0);
  			destroy_component(searchterm, detaching);
  			if (detaching) detach(t1);
  		}
  	};
  }

  // (30:148) {#if !collapsed}
  function create_if_block$d(ctx) {
  	let div;
  	let t0;
  	let searchterm;
  	let t1;
  	let current;
  	const default_slot_template = /*#slots*/ ctx[6].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[5], null);
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[4] } });

  	return {
  		c() {
  			if (default_slot) default_slot.c();
  			div = element("div");
  			t0 = text("</");
  			create_component(searchterm.$$.fragment);
  			t1 = text(">");
  			attr(div, "class", "tag-close tag-name svelte-g71n30");
  			attr(div, "style", /*style*/ ctx[1]);
  			toggle_class(div, "hover", /*hover*/ ctx[2]);
  		},
  		m(target, anchor) {
  			if (default_slot) {
  				default_slot.m(target, anchor);
  			}

  			insert$1(target, div, anchor);
  			append(div, t0);
  			mount_component(searchterm, div, null);
  			append(div, t1);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 32) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[5], dirty, null, null);
  				}
  			}

  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 16) searchterm_changes.text = /*tagName*/ ctx[4];
  			searchterm.$set(searchterm_changes);

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 4) {
  				toggle_class(div, "hover", /*hover*/ ctx[2]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (default_slot) default_slot.d(detaching);
  			if (detaching) detach(div);
  			destroy_component(searchterm);
  		}
  	};
  }

  function create_fragment$k(ctx) {
  	let div;
  	let collapse;
  	let updating_collapsed;
  	let t0;
  	let searchterm;
  	let t1;
  	let if_block1_anchor;
  	let current;
  	let mounted;
  	let dispose;

  	function collapse_collapsed_binding(value) {
  		/*collapse_collapsed_binding*/ ctx[7](value);
  	}

  	let collapse_props = { selected: /*selected*/ ctx[3] };

  	if (/*collapsed*/ ctx[0] !== void 0) {
  		collapse_props.collapsed = /*collapsed*/ ctx[0];
  	}

  	collapse = new Collapse({ props: collapse_props });
  	binding_callbacks.push(() => bind(collapse, "collapsed", collapse_collapsed_binding));
  	searchterm = new SearchTerm({ props: { text: /*tagName*/ ctx[4] } });
  	let if_block0 = /*collapsed*/ ctx[0] && create_if_block_1$7(ctx);
  	let if_block1 = !/*collapsed*/ ctx[0] && create_if_block$d(ctx);

  	return {
  		c() {
  			div = element("div");
  			create_component(collapse.$$.fragment);
  			t0 = text("<");
  			create_component(searchterm.$$.fragment);
  			t1 = text(">");
  			if (if_block0) if_block0.c();
  			if (if_block1) if_block1.c();
  			if_block1_anchor = empty();
  			attr(div, "class", "tag-open tag-name svelte-g71n30");
  			attr(div, "style", /*style*/ ctx[1]);
  			toggle_class(div, "hover", /*hover*/ ctx[2]);
  			toggle_class(div, "selected", /*selected*/ ctx[3]);
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(collapse, div, null);
  			append(div, t0);
  			mount_component(searchterm, div, null);
  			append(div, t1);
  			if (if_block0) if_block0.m(div, null);
  			if (if_block1) if_block1.m(target, anchor);
  			insert$1(target, if_block1_anchor, anchor);
  			current = true;

  			if (!mounted) {
  				dispose = listen(div, "dblclick", /*dblclick_handler*/ ctx[8]);
  				mounted = true;
  			}
  		},
  		p(ctx, [dirty]) {
  			const collapse_changes = {};
  			if (dirty & /*selected*/ 8) collapse_changes.selected = /*selected*/ ctx[3];

  			if (!updating_collapsed && dirty & /*collapsed*/ 1) {
  				updating_collapsed = true;
  				collapse_changes.collapsed = /*collapsed*/ ctx[0];
  				add_flush_callback(() => updating_collapsed = false);
  			}

  			collapse.$set(collapse_changes);
  			const searchterm_changes = {};
  			if (dirty & /*tagName*/ 16) searchterm_changes.text = /*tagName*/ ctx[4];
  			searchterm.$set(searchterm_changes);

  			if (/*collapsed*/ ctx[0]) {
  				if (if_block0) {
  					if_block0.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 1) {
  						transition_in(if_block0, 1);
  					}
  				} else {
  					if_block0 = create_if_block_1$7(ctx);
  					if_block0.c();
  					transition_in(if_block0, 1);
  					if_block0.m(div, null);
  				}
  			} else if (if_block0) {
  				group_outros();

  				transition_out(if_block0, 1, 1, () => {
  					if_block0 = null;
  				});

  				check_outros();
  			}

  			if (!current || dirty & /*style*/ 2) {
  				attr(div, "style", /*style*/ ctx[1]);
  			}

  			if (dirty & /*hover*/ 4) {
  				toggle_class(div, "hover", /*hover*/ ctx[2]);
  			}

  			if (dirty & /*selected*/ 8) {
  				toggle_class(div, "selected", /*selected*/ ctx[3]);
  			}

  			if (!/*collapsed*/ ctx[0]) {
  				if (if_block1) {
  					if_block1.p(ctx, dirty);

  					if (dirty & /*collapsed*/ 1) {
  						transition_in(if_block1, 1);
  					}
  				} else {
  					if_block1 = create_if_block$d(ctx);
  					if_block1.c();
  					transition_in(if_block1, 1);
  					if_block1.m(if_block1_anchor.parentNode, if_block1_anchor);
  				}
  			} else if (if_block1) {
  				group_outros();

  				transition_out(if_block1, 1, 1, () => {
  					if_block1 = null;
  				});

  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(collapse.$$.fragment, local);
  			transition_in(searchterm.$$.fragment, local);
  			transition_in(if_block0);
  			transition_in(if_block1);
  			current = true;
  		},
  		o(local) {
  			transition_out(collapse.$$.fragment, local);
  			transition_out(searchterm.$$.fragment, local);
  			transition_out(if_block0);
  			transition_out(if_block1);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(collapse);
  			destroy_component(searchterm);
  			if (if_block0) if_block0.d();
  			if (if_block1) if_block1.d(detaching);
  			if (detaching) detach(if_block1_anchor);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  function instance$j($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;
  	let { style } = $$props;
  	let { hover } = $$props;
  	let { selected } = $$props;
  	let { tagName } = $$props;
  	let { collapsed } = $$props;

  	function collapse_collapsed_binding(value) {
  		collapsed = value;
  		$$invalidate(0, collapsed);
  	}

  	const dblclick_handler = () => $$invalidate(0, collapsed = !collapsed);

  	$$self.$$set = $$props => {
  		if ("style" in $$props) $$invalidate(1, style = $$props.style);
  		if ("hover" in $$props) $$invalidate(2, hover = $$props.hover);
  		if ("selected" in $$props) $$invalidate(3, selected = $$props.selected);
  		if ("tagName" in $$props) $$invalidate(4, tagName = $$props.tagName);
  		if ("collapsed" in $$props) $$invalidate(0, collapsed = $$props.collapsed);
  		if ("$$scope" in $$props) $$invalidate(5, $$scope = $$props.$$scope);
  	};

  	return [
  		collapsed,
  		style,
  		hover,
  		selected,
  		tagName,
  		$$scope,
  		slots,
  		collapse_collapsed_binding,
  		dblclick_handler
  	];
  }

  class Slot extends SvelteComponent {
  	constructor(options) {
  		super();

  		init(this, options, instance$j, create_fragment$k, safe_not_equal, {
  			style: 1,
  			hover: 2,
  			selected: 3,
  			tagName: 4,
  			collapsed: 0
  		});
  	}
  }

  /* src/ui/nodes/Iteration.svelte generated by Svelte v3.32.3 */

  function create_fragment$l(ctx) {
  	let div;
  	let t;
  	let current;
  	const default_slot_template = /*#slots*/ ctx[4].default;
  	const default_slot = create_slot(default_slot_template, ctx, /*$$scope*/ ctx[3], null);

  	return {
  		c() {
  			div = element("div");
  			t = text("↪");
  			if (default_slot) default_slot.c();
  			attr(div, "style", /*style*/ ctx[0]);
  			attr(div, "class", "svelte-x8r9lc");
  			toggle_class(div, "hover", /*hover*/ ctx[1]);
  			toggle_class(div, "selected", /*selected*/ ctx[2]);
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			append(div, t);

  			if (default_slot) {
  				default_slot.m(target, anchor);
  			}

  			current = true;
  		},
  		p(ctx, [dirty]) {
  			if (!current || dirty & /*style*/ 1) {
  				attr(div, "style", /*style*/ ctx[0]);
  			}

  			if (dirty & /*hover*/ 2) {
  				toggle_class(div, "hover", /*hover*/ ctx[1]);
  			}

  			if (dirty & /*selected*/ 4) {
  				toggle_class(div, "selected", /*selected*/ ctx[2]);
  			}

  			if (default_slot) {
  				if (default_slot.p && dirty & /*$$scope*/ 8) {
  					update_slot(default_slot, default_slot_template, ctx, /*$$scope*/ ctx[3], dirty, null, null);
  				}
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(default_slot, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(default_slot, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			if (default_slot) default_slot.d(detaching);
  		}
  	};
  }

  function instance$k($$self, $$props, $$invalidate) {
  	let { $$slots: slots = {}, $$scope } = $$props;
  	let { style } = $$props;
  	let { hover } = $$props;
  	let { selected } = $$props;

  	$$self.$$set = $$props => {
  		if ("style" in $$props) $$invalidate(0, style = $$props.style);
  		if ("hover" in $$props) $$invalidate(1, hover = $$props.hover);
  		if ("selected" in $$props) $$invalidate(2, selected = $$props.selected);
  		if ("$$scope" in $$props) $$invalidate(3, $$scope = $$props.$$scope);
  	};

  	return [style, hover, selected, $$scope, slots];
  }

  class Iteration extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$k, create_fragment$l, safe_not_equal, { style: 0, hover: 1, selected: 2 });
  	}
  }

  /* src/ui/nodes/Text.svelte generated by Svelte v3.32.3 */

  function create_fragment$m(ctx) {
  	let div;
  	let searchterm;
  	let current;
  	searchterm = new SearchTerm({ props: { text: /*nodeValue*/ ctx[1] } });

  	return {
  		c() {
  			div = element("div");
  			create_component(searchterm.$$.fragment);
  			attr(div, "style", /*style*/ ctx[0]);
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(searchterm, div, null);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			const searchterm_changes = {};
  			if (dirty & /*nodeValue*/ 2) searchterm_changes.text = /*nodeValue*/ ctx[1];
  			searchterm.$set(searchterm_changes);

  			if (!current || dirty & /*style*/ 1) {
  				attr(div, "style", /*style*/ ctx[0]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(searchterm.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(searchterm.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(searchterm);
  		}
  	};
  }

  function instance$l($$self, $$props, $$invalidate) {
  	let { style } = $$props;
  	let { nodeValue } = $$props;

  	$$self.$$set = $$props => {
  		if ("style" in $$props) $$invalidate(0, style = $$props.style);
  		if ("nodeValue" in $$props) $$invalidate(1, nodeValue = $$props.nodeValue);
  	};

  	return [style, nodeValue];
  }

  class Text extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$l, create_fragment$m, safe_not_equal, { style: 0, nodeValue: 1 });
  	}
  }

  /* src/ui/nodes/Anchor.svelte generated by Svelte v3.32.3 */

  function create_fragment$n(ctx) {
  	let div;
  	let t;

  	return {
  		c() {
  			div = element("div");
  			t = text("#anchor");
  			attr(div, "style", /*style*/ ctx[0]);
  			attr(div, "class", "svelte-1oevsoq");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			append(div, t);
  		},
  		p(ctx, [dirty]) {
  			if (dirty & /*style*/ 1) {
  				attr(div, "style", /*style*/ ctx[0]);
  			}
  		},
  		i: noop,
  		o: noop,
  		d(detaching) {
  			if (detaching) detach(div);
  		}
  	};
  }

  function instance$m($$self, $$props, $$invalidate) {
  	let { style } = $$props;

  	$$self.$$set = $$props => {
  		if ("style" in $$props) $$invalidate(0, style = $$props.style);
  	};

  	return [style];
  }

  class Anchor extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$m, create_fragment$n, safe_not_equal, { style: 0 });
  	}
  }

  /* src/ui/nodes/Node.svelte generated by Svelte v3.32.3 */

  function get_each_context_1$2(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[0] = list[i];
  	return child_ctx;
  }

  function get_each_context$5(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[14] = list[i];
  	return child_ctx;
  }

  // (111:48) {:else}
  function create_else_block$7(ctx) {
  	let each_blocks = [];
  	let each_1_lookup = new Map();
  	let each_1_anchor;
  	let current;
  	let each_value_1 = /*node*/ ctx[0].children;
  	const get_key = ctx => /*node*/ ctx[0].id;

  	for (let i = 0; i < each_value_1.length; i += 1) {
  		let child_ctx = get_each_context_1$2(ctx, each_value_1, i);
  		let key = get_key(child_ctx);
  		each_1_lookup.set(key, each_blocks[i] = create_each_block_1$2(key, child_ctx));
  	}

  	return {
  		c() {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			each_1_anchor = empty();
  		},
  		m(target, anchor) {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(target, anchor);
  			}

  			insert$1(target, each_1_anchor, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			if (dirty & /*node, depth*/ 3) {
  				each_value_1 = /*node*/ ctx[0].children;
  				group_outros();
  				each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value_1, each_1_lookup, each_1_anchor.parentNode, outro_and_destroy_block, create_each_block_1$2, each_1_anchor, get_each_context_1$2);
  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value_1.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].d(detaching);
  			}

  			if (detaching) detach(each_1_anchor);
  		}
  	};
  }

  // (93:11) {#if $visibility[node.type]}
  function create_if_block$e(ctx) {
  	let li;
  	let switch_instance;
  	let updating_collapsed;
  	let current;
  	let mounted;
  	let dispose;

  	const switch_instance_spread_levels = [
  		{ tagName: /*node*/ ctx[0].tagName },
  		/*node*/ ctx[0].detail,
  		{
  			hasChildren: /*node*/ ctx[0].children.length != 0
  		},
  		{
  			hover: /*$hoveredNodeId*/ ctx[5] == /*node*/ ctx[0].id
  		},
  		{
  			selected: /*$selectedNode*/ ctx[6].id == /*node*/ ctx[0].id
  		},
  		{
  			style: `padding-left: ${/*depth*/ ctx[1] * 12}px`
  		}
  	];

  	function switch_instance_collapsed_binding(value) {
  		/*switch_instance_collapsed_binding*/ ctx[8](value);
  	}

  	var switch_value = /*nodeType*/ ctx[3];

  	function switch_props(ctx) {
  		let switch_instance_props = {
  			$$slots: { default: [create_default_slot$5] },
  			$$scope: { ctx }
  		};

  		for (let i = 0; i < switch_instance_spread_levels.length; i += 1) {
  			switch_instance_props = assign(switch_instance_props, switch_instance_spread_levels[i]);
  		}

  		if (/*node*/ ctx[0].collapsed !== void 0) {
  			switch_instance_props.collapsed = /*node*/ ctx[0].collapsed;
  		}

  		return { props: switch_instance_props };
  	}

  	if (switch_value) {
  		switch_instance = new switch_value(switch_props(ctx));
  		binding_callbacks.push(() => bind(switch_instance, "collapsed", switch_instance_collapsed_binding));
  	}

  	return {
  		c() {
  			li = element("li");
  			if (switch_instance) create_component(switch_instance.$$.fragment);
  			attr(li, "class", "svelte-18cyfcm");
  			toggle_class(li, "flash", /*flash*/ ctx[2]);
  		},
  		m(target, anchor) {
  			insert$1(target, li, anchor);

  			if (switch_instance) {
  				mount_component(switch_instance, li, null);
  			}

  			/*li_binding*/ ctx[9](li);
  			current = true;

  			if (!mounted) {
  				dispose = [
  					listen(li, "animationend", /*animationend_handler*/ ctx[10]),
  					listen(li, "mouseover", stop_propagation(/*mouseover_handler*/ ctx[11])),
  					listen(li, "click", stop_propagation(/*click_handler*/ ctx[12]))
  				];

  				mounted = true;
  			}
  		},
  		p(ctx, dirty) {
  			const switch_instance_changes = (dirty & /*node, $hoveredNodeId, $selectedNode, depth*/ 99)
  			? get_spread_update(switch_instance_spread_levels, [
  					dirty & /*node*/ 1 && { tagName: /*node*/ ctx[0].tagName },
  					dirty & /*node*/ 1 && get_spread_object(/*node*/ ctx[0].detail),
  					dirty & /*node*/ 1 && {
  						hasChildren: /*node*/ ctx[0].children.length != 0
  					},
  					dirty & /*$hoveredNodeId, node*/ 33 && {
  						hover: /*$hoveredNodeId*/ ctx[5] == /*node*/ ctx[0].id
  					},
  					dirty & /*$selectedNode, node*/ 65 && {
  						selected: /*$selectedNode*/ ctx[6].id == /*node*/ ctx[0].id
  					},
  					dirty & /*depth*/ 2 && {
  						style: `padding-left: ${/*depth*/ ctx[1] * 12}px`
  					}
  				])
  			: {};

  			if (dirty & /*$$scope, node, depth, $selectedNode*/ 524355) {
  				switch_instance_changes.$$scope = { dirty, ctx };
  			}

  			if (!updating_collapsed && dirty & /*node*/ 1) {
  				updating_collapsed = true;
  				switch_instance_changes.collapsed = /*node*/ ctx[0].collapsed;
  				add_flush_callback(() => updating_collapsed = false);
  			}

  			if (switch_value !== (switch_value = /*nodeType*/ ctx[3])) {
  				if (switch_instance) {
  					group_outros();
  					const old_component = switch_instance;

  					transition_out(old_component.$$.fragment, 1, 0, () => {
  						destroy_component(old_component, 1);
  					});

  					check_outros();
  				}

  				if (switch_value) {
  					switch_instance = new switch_value(switch_props(ctx));
  					binding_callbacks.push(() => bind(switch_instance, "collapsed", switch_instance_collapsed_binding));
  					create_component(switch_instance.$$.fragment);
  					transition_in(switch_instance.$$.fragment, 1);
  					mount_component(switch_instance, li, null);
  				} else {
  					switch_instance = null;
  				}
  			} else if (switch_value) {
  				switch_instance.$set(switch_instance_changes);
  			}

  			if (dirty & /*flash*/ 4) {
  				toggle_class(li, "flash", /*flash*/ ctx[2]);
  			}
  		},
  		i(local) {
  			if (current) return;
  			if (switch_instance) transition_in(switch_instance.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			if (switch_instance) transition_out(switch_instance.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(li);
  			if (switch_instance) destroy_component(switch_instance);
  			/*li_binding*/ ctx[9](null);
  			mounted = false;
  			run_all(dispose);
  		}
  	};
  }

  // (111:55) {#each node.children as node (node.id)}
  function create_each_block_1$2(key_1, ctx) {
  	let first;
  	let node_1;
  	let current;

  	node_1 = new Node({
  			props: {
  				node: /*node*/ ctx[0],
  				depth: /*depth*/ ctx[1]
  			}
  		});

  	return {
  		key: key_1,
  		first: null,
  		c() {
  			first = empty();
  			create_component(node_1.$$.fragment);
  			this.first = first;
  		},
  		m(target, anchor) {
  			insert$1(target, first, anchor);
  			mount_component(node_1, target, anchor);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			const node_1_changes = {};
  			if (dirty & /*node*/ 1) node_1_changes.node = /*node*/ ctx[0];
  			if (dirty & /*depth*/ 2) node_1_changes.depth = /*depth*/ ctx[1];
  			node_1.$set(node_1_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(node_1.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(node_1.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(first);
  			destroy_component(node_1, detaching);
  		}
  	};
  }

  // (108:5) {#if $selectedNode.id == node.id}
  function create_if_block_1$8(ctx) {
  	let span;
  	let span_style_value;

  	return {
  		c() {
  			span = element("span");
  			attr(span, "style", span_style_value = `left: ${/*depth*/ ctx[1] * 12 + 6}px`);
  			attr(span, "class", "svelte-18cyfcm");
  		},
  		m(target, anchor) {
  			insert$1(target, span, anchor);
  		},
  		p(ctx, dirty) {
  			if (dirty & /*depth*/ 2 && span_style_value !== (span_style_value = `left: ${/*depth*/ ctx[1] * 12 + 6}px`)) {
  				attr(span, "style", span_style_value);
  			}
  		},
  		d(detaching) {
  			if (detaching) detach(span);
  		}
  	};
  }

  // (108:91) {#each node.children as child (child.id)}
  function create_each_block$5(key_1, ctx) {
  	let first;
  	let node_1;
  	let current;

  	node_1 = new Node({
  			props: {
  				node: /*child*/ ctx[14],
  				depth: /*node*/ ctx[0].type == "iteration"
  				? /*depth*/ ctx[1]
  				: /*depth*/ ctx[1] + 1
  			}
  		});

  	return {
  		key: key_1,
  		first: null,
  		c() {
  			first = empty();
  			create_component(node_1.$$.fragment);
  			this.first = first;
  		},
  		m(target, anchor) {
  			insert$1(target, first, anchor);
  			mount_component(node_1, target, anchor);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			const node_1_changes = {};
  			if (dirty & /*node*/ 1) node_1_changes.node = /*child*/ ctx[14];

  			if (dirty & /*node, depth*/ 3) node_1_changes.depth = /*node*/ ctx[0].type == "iteration"
  			? /*depth*/ ctx[1]
  			: /*depth*/ ctx[1] + 1;

  			node_1.$set(node_1_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(node_1.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(node_1.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(first);
  			destroy_component(node_1, detaching);
  		}
  	};
  }

  // (99:3) <svelte:component       this={nodeType}       tagName={node.tagName}       bind:collapsed={node.collapsed}       {...node.detail}       hasChildren={node.children.length != 0}       hover={$hoveredNodeId == node.id}       selected={$selectedNode.id == node.id}       style={`padding-left: ${depth * 12}px`}     >
  function create_default_slot$5(ctx) {
  	let ul;
  	let each_blocks = [];
  	let each_1_lookup = new Map();
  	let current;
  	let if_block = /*$selectedNode*/ ctx[6].id == /*node*/ ctx[0].id && create_if_block_1$8(ctx);
  	let each_value = /*node*/ ctx[0].children;
  	const get_key = ctx => /*child*/ ctx[14].id;

  	for (let i = 0; i < each_value.length; i += 1) {
  		let child_ctx = get_each_context$5(ctx, each_value, i);
  		let key = get_key(child_ctx);
  		each_1_lookup.set(key, each_blocks[i] = create_each_block$5(key, child_ctx));
  	}

  	return {
  		c() {
  			if (if_block) if_block.c();
  			ul = element("ul");

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}
  		},
  		m(target, anchor) {
  			if (if_block) if_block.m(target, anchor);
  			insert$1(target, ul, anchor);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			current = true;
  		},
  		p(ctx, dirty) {
  			if (/*$selectedNode*/ ctx[6].id == /*node*/ ctx[0].id) {
  				if (if_block) {
  					if_block.p(ctx, dirty);
  				} else {
  					if_block = create_if_block_1$8(ctx);
  					if_block.c();
  					if_block.m(ul.parentNode, ul);
  				}
  			} else if (if_block) {
  				if_block.d(1);
  				if_block = null;
  			}

  			if (dirty & /*node, depth*/ 3) {
  				each_value = /*node*/ ctx[0].children;
  				group_outros();
  				each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value, each_1_lookup, ul, outro_and_destroy_block, create_each_block$5, null, get_each_context$5);
  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;

  			for (let i = 0; i < each_value.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			current = true;
  		},
  		o(local) {
  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			current = false;
  		},
  		d(detaching) {
  			if (if_block) if_block.d(detaching);
  			if (detaching) detach(ul);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].d();
  			}
  		}
  	};
  }

  function create_fragment$o(ctx) {
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let current;
  	const if_block_creators = [create_if_block$e, create_else_block$7];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*$visibility*/ ctx[4][/*node*/ ctx[0].type]) return 0;
  		return 1;
  	}

  	current_block_type_index = select_block_type(ctx);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	return {
  		c() {
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  function instance$n($$self, $$props, $$invalidate) {
  	let nodeType;
  	let $visibility;
  	let $hoveredNodeId;
  	let $selectedNode;
  	component_subscribe($$self, visibility, $$value => $$invalidate(4, $visibility = $$value));
  	component_subscribe($$self, hoveredNodeId, $$value => $$invalidate(5, $hoveredNodeId = $$value));
  	component_subscribe($$self, selectedNode, $$value => $$invalidate(6, $selectedNode = $$value));
  	let { node } = $$props;
  	let { depth = 1 } = $$props;
  	let _timeout = null;

  	node.invalidate = () => {
  		if (_timeout) return;

  		_timeout = setTimeout(
  			() => {
  				_timeout = null;
  				$$invalidate(0, node);
  			},
  			100
  		);
  	};

  	let lastLength = node.children.length;
  	let flash = false;

  	function switch_instance_collapsed_binding(value) {
  		if ($$self.$$.not_equal(node.collapsed, value)) {
  			node.collapsed = value;
  			$$invalidate(0, node);
  		}
  	}

  	function li_binding($$value) {
  		binding_callbacks[$$value ? "unshift" : "push"](() => {
  			node.dom = $$value;
  			$$invalidate(0, node);
  		});
  	}

  	const animationend_handler = () => $$invalidate(2, flash = false);
  	const mouseover_handler = () => set_store_value(hoveredNodeId, $hoveredNodeId = node.id, $hoveredNodeId);
  	const click_handler = () => set_store_value(selectedNode, $selectedNode = node, $selectedNode);

  	$$self.$$set = $$props => {
  		if ("node" in $$props) $$invalidate(0, node = $$props.node);
  		if ("depth" in $$props) $$invalidate(1, depth = $$props.depth);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*node*/ 1) {
  			$$invalidate(3, nodeType = ({
  				element: Element,
  				component: Element,
  				block: Block,
  				slot: Slot,
  				iteration: Iteration,
  				text: Text,
  				anchor: Anchor
  			})[node.type]);
  		}

  		if ($$self.$$.dirty & /*flash, node, lastLength*/ 133) {
  			{
  				$$invalidate(2, flash = flash || node.children.length != lastLength);
  				$$invalidate(7, lastLength = node.children.length);
  			}
  		}
  	};

  	return [
  		node,
  		depth,
  		flash,
  		nodeType,
  		$visibility,
  		$hoveredNodeId,
  		$selectedNode,
  		lastLength,
  		switch_instance_collapsed_binding,
  		li_binding,
  		animationend_handler,
  		mouseover_handler,
  		click_handler
  	];
  }

  class Node extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$n, create_fragment$o, safe_not_equal, { node: 0, depth: 1 });
  	}
  }

  /* src/ui/SvelteDevToolsUi.svelte generated by Svelte v3.32.3 */

  function get_each_context$6(ctx, list, i) {
  	const child_ctx = ctx.slice();
  	child_ctx[10] = list[i];
  	return child_ctx;
  }

  // (60:579) {:else}
  function create_else_block$8(ctx) {
  	let errormessage;
  	let current;
  	errormessage = new ErrorMessage({});

  	return {
  		c() {
  			create_component(errormessage.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(errormessage, target, anchor);
  			current = true;
  		},
  		p: noop,
  		i(local) {
  			if (current) return;
  			transition_in(errormessage.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(errormessage.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(errormessage, detaching);
  		}
  	};
  }

  // (60:150) 
  function create_if_block_1$9(ctx) {
  	let div;
  	let toolbar;
  	let ul;
  	let each_blocks = [];
  	let each_1_lookup = new Map();
  	let breadcrumbs;
  	let componentview;
  	let current;
  	let mounted;
  	let dispose;

  	toolbar = new Toolbar({
  			props: {
  				$$slots: { default: [create_default_slot$6] },
  				$$scope: { ctx }
  			}
  		});

  	let each_value = /*$rootNodes*/ ctx[3];
  	const get_key = ctx => /*node*/ ctx[10].id;

  	for (let i = 0; i < each_value.length; i += 1) {
  		let child_ctx = get_each_context$6(ctx, each_value, i);
  		let key = get_key(child_ctx);
  		each_1_lookup.set(key, each_blocks[i] = create_each_block$6(key, child_ctx));
  	}

  	breadcrumbs = new Breadcrumbs({});
  	componentview = new ComponentView({});

  	return {
  		c() {
  			div = element("div");
  			create_component(toolbar.$$.fragment);
  			ul = element("ul");

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].c();
  			}

  			create_component(breadcrumbs.$$.fragment);
  			create_component(componentview.$$.fragment);
  			attr(ul, "class", "svelte-ukg5x");
  			attr(div, "class", "node-tree svelte-ukg5x");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(toolbar, div, null);
  			append(div, ul);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].m(ul, null);
  			}

  			mount_component(breadcrumbs, div, null);
  			mount_component(componentview, target, anchor);
  			current = true;

  			if (!mounted) {
  				dispose = listen(ul, "mouseleave", /*mouseleave_handler*/ ctx[9]);
  				mounted = true;
  			}
  		},
  		p(ctx, dirty) {
  			const toolbar_changes = {};

  			if (dirty & /*$$scope, profilerEnabled*/ 8194) {
  				toolbar_changes.$$scope = { dirty, ctx };
  			}

  			toolbar.$set(toolbar_changes);

  			if (dirty & /*$rootNodes*/ 8) {
  				each_value = /*$rootNodes*/ ctx[3];
  				group_outros();
  				each_blocks = update_keyed_each(each_blocks, dirty, get_key, 1, ctx, each_value, each_1_lookup, ul, outro_and_destroy_block, create_each_block$6, null, get_each_context$6);
  				check_outros();
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(toolbar.$$.fragment, local);

  			for (let i = 0; i < each_value.length; i += 1) {
  				transition_in(each_blocks[i]);
  			}

  			transition_in(breadcrumbs.$$.fragment, local);
  			transition_in(componentview.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(toolbar.$$.fragment, local);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				transition_out(each_blocks[i]);
  			}

  			transition_out(breadcrumbs.$$.fragment, local);
  			transition_out(componentview.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(toolbar);

  			for (let i = 0; i < each_blocks.length; i += 1) {
  				each_blocks[i].d();
  			}

  			destroy_component(breadcrumbs);
  			destroy_component(componentview, detaching);
  			mounted = false;
  			dispose();
  		}
  	};
  }

  // (60:35) {#if profilerEnabled}
  function create_if_block$f(ctx) {
  	let div;
  	let profiler;
  	let current;
  	profiler = new Profiler({});
  	profiler.$on("close", /*close_handler*/ ctx[7]);

  	return {
  		c() {
  			div = element("div");
  			create_component(profiler.$$.fragment);
  			attr(div, "class", "svelte-ukg5x");
  		},
  		m(target, anchor) {
  			insert$1(target, div, anchor);
  			mount_component(profiler, div, null);
  			current = true;
  		},
  		p: noop,
  		i(local) {
  			if (current) return;
  			transition_in(profiler.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(profiler.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(div);
  			destroy_component(profiler);
  		}
  	};
  }

  // (60:182) <Button on:click={() => (profilerEnabled = true)}>
  function create_default_slot_1$3(ctx) {
  	let svg;
  	let path;

  	return {
  		c() {
  			svg = svg_element("svg");
  			path = svg_element("path");
  			attr(path, "d", "M0,4.8H3.4V16H0ZM6.4,0H9.6V16H6.4Zm6.4,9H16V16h-3.2z");
  			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
  			attr(svg, "viewBox", "0 0 16 16");
  		},
  		m(target, anchor) {
  			insert$1(target, svg, anchor);
  			append(svg, path);
  		},
  		d(detaching) {
  			if (detaching) detach(svg);
  		}
  	};
  }

  // (60:173) <Toolbar>
  function create_default_slot$6(ctx) {
  	let button;
  	let pickerbutton;
  	let visibilitybutton;
  	let search;
  	let current;

  	button = new Button({
  			props: {
  				$$slots: { default: [create_default_slot_1$3] },
  				$$scope: { ctx }
  			}
  		});

  	button.$on("click", /*click_handler*/ ctx[8]);
  	pickerbutton = new PickerButton({});
  	visibilitybutton = new VisibilityButton({});
  	search = new Search({});

  	return {
  		c() {
  			create_component(button.$$.fragment);
  			create_component(pickerbutton.$$.fragment);
  			create_component(visibilitybutton.$$.fragment);
  			create_component(search.$$.fragment);
  		},
  		m(target, anchor) {
  			mount_component(button, target, anchor);
  			mount_component(pickerbutton, target, anchor);
  			mount_component(visibilitybutton, target, anchor);
  			mount_component(search, target, anchor);
  			current = true;
  		},
  		p(ctx, dirty) {
  			const button_changes = {};

  			if (dirty & /*$$scope*/ 8192) {
  				button_changes.$$scope = { dirty, ctx };
  			}

  			button.$set(button_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(button.$$.fragment, local);
  			transition_in(pickerbutton.$$.fragment, local);
  			transition_in(visibilitybutton.$$.fragment, local);
  			transition_in(search.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(button.$$.fragment, local);
  			transition_out(pickerbutton.$$.fragment, local);
  			transition_out(visibilitybutton.$$.fragment, local);
  			transition_out(search.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			destroy_component(button, detaching);
  			destroy_component(pickerbutton, detaching);
  			destroy_component(visibilitybutton, detaching);
  			destroy_component(search, detaching);
  		}
  	};
  }

  // (60:478) {#each $rootNodes as node (node.id)}
  function create_each_block$6(key_2, ctx) {
  	let first;
  	let node;
  	let current;
  	node = new Node({ props: { node: /*node*/ ctx[10] } });

  	return {
  		key: key_2,
  		first: null,
  		c() {
  			first = empty();
  			create_component(node.$$.fragment);
  			this.first = first;
  		},
  		m(target, anchor) {
  			insert$1(target, first, anchor);
  			mount_component(node, target, anchor);
  			current = true;
  		},
  		p(new_ctx, dirty) {
  			ctx = new_ctx;
  			const node_changes = {};
  			if (dirty & /*$rootNodes*/ 8) node_changes.node = /*node*/ ctx[10];
  			node.$set(node_changes);
  		},
  		i(local) {
  			if (current) return;
  			transition_in(node.$$.fragment, local);
  			current = true;
  		},
  		o(local) {
  			transition_out(node.$$.fragment, local);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(first);
  			destroy_component(node, detaching);
  		}
  	};
  }

  function create_fragment$p(ctx) {
  	let span;
  	let current_block_type_index;
  	let if_block;
  	let if_block_anchor;
  	let current;
  	const if_block_creators = [create_if_block$f, create_if_block_1$9, create_else_block$8];
  	const if_blocks = [];

  	function select_block_type(ctx, dirty) {
  		if (/*profilerEnabled*/ ctx[1]) return 0;
  		if (/*$rootNodes*/ ctx[3].length) return 1;
  		return 2;
  	}

  	current_block_type_index = select_block_type(ctx);
  	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

  	return {
  		c() {
  			span = element("span");
  			if_block.c();
  			if_block_anchor = empty();
  		},
  		m(target, anchor) {
  			insert$1(target, span, anchor);
  			/*span_binding*/ ctx[6](span);
  			if_blocks[current_block_type_index].m(target, anchor);
  			insert$1(target, if_block_anchor, anchor);
  			current = true;
  		},
  		p(ctx, [dirty]) {
  			let previous_block_index = current_block_type_index;
  			current_block_type_index = select_block_type(ctx);

  			if (current_block_type_index === previous_block_index) {
  				if_blocks[current_block_type_index].p(ctx, dirty);
  			} else {
  				group_outros();

  				transition_out(if_blocks[previous_block_index], 1, 1, () => {
  					if_blocks[previous_block_index] = null;
  				});

  				check_outros();
  				if_block = if_blocks[current_block_type_index];

  				if (!if_block) {
  					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
  					if_block.c();
  				} else {
  					if_block.p(ctx, dirty);
  				}

  				transition_in(if_block, 1);
  				if_block.m(if_block_anchor.parentNode, if_block_anchor);
  			}
  		},
  		i(local) {
  			if (current) return;
  			transition_in(if_block);
  			current = true;
  		},
  		o(local) {
  			transition_out(if_block);
  			current = false;
  		},
  		d(detaching) {
  			if (detaching) detach(span);
  			/*span_binding*/ ctx[6](null);
  			if_blocks[current_block_type_index].d(detaching);
  			if (detaching) detach(if_block_anchor);
  		}
  	};
  }

  const key = {};
  const getContext$1 = getContext.bind(undefined, key);
  const setContext$1 = setContext.bind(undefined, key);

  function instance$o($$self, $$props, $$invalidate) {
  	let $selectedNode;
  	let $hoveredNodeId;
  	let $rootNodes;
  	component_subscribe($$self, selectedNode, $$value => $$invalidate(5, $selectedNode = $$value));
  	component_subscribe($$self, hoveredNodeId, $$value => $$invalidate(2, $hoveredNodeId = $$value));
  	component_subscribe($$self, rootNodes, $$value => $$invalidate(3, $rootNodes = $$value));
  	let { hooks } = $$props;
  	setContext$1(hooks);
  	let dom;
  	let profilerEnabled = false;

  	function span_binding($$value) {
  		binding_callbacks[$$value ? "unshift" : "push"](() => {
  			dom = $$value;
  			$$invalidate(0, dom);
  		});
  	}

  	const close_handler = () => $$invalidate(1, profilerEnabled = false);
  	const click_handler = () => $$invalidate(1, profilerEnabled = true);
  	const mouseleave_handler = () => set_store_value(hoveredNodeId, $hoveredNodeId = null, $hoveredNodeId);

  	$$self.$$set = $$props => {
  		if ("hooks" in $$props) $$invalidate(4, hooks = $$props.hooks);
  	};

  	$$self.$$.update = () => {
  		if ($$self.$$.dirty & /*dom*/ 1) {
  			{
  				if (dom) {
  					const defaultView = dom.ownerDocument.defaultView;
  					defaultView.addEventListener("keydown", e => e.target !== defaultView && handleKeydown(e));
  				}
  			}
  		}

  		if ($$self.$$.dirty & /*profilerEnabled, hooks*/ 18) {
  			profilerEnabled
  			? hooks.startProfiler()
  			: hooks.stopProfiler();
  		}

  		if ($$self.$$.dirty & /*hooks, $selectedNode*/ 48) {
  			hooks.setSelected($selectedNode.id);
  		}

  		if ($$self.$$.dirty & /*hooks, $hoveredNodeId*/ 20) {
  			hooks.setHover($hoveredNodeId);
  		}
  	};

  	return [
  		dom,
  		profilerEnabled,
  		$hoveredNodeId,
  		$rootNodes,
  		hooks,
  		$selectedNode,
  		span_binding,
  		close_handler,
  		click_handler,
  		mouseleave_handler
  	];
  }

  class SvelteDevToolsUi extends SvelteComponent {
  	constructor(options) {
  		super();
  		init(this, options, instance$o, create_fragment$p, safe_not_equal, { hooks: 4 });
  	}
  }

  var rawStyles = `html {
  height: 100%;
  font-size: 12px;
}

body {
  display: flex;
  margin: 0;
  height: 100%;
  color: rgb(74, 74, 79);
  font-size: 11px;
  font-family: monospace;
}

body.dark {
  background-color: rgb(42, 42, 46);
  color: rgb(177, 177, 179);
  scrollbar-color: rgb(115, 115, 115) rgb(60, 60, 61);
}

body.dark ::-webkit-scrollbar {
  width: 14px;
  height: 14px;
  background-color: transparent;
  box-shadow: inset 0 0 1px rgba(255, 255, 255, 0.5);
}

body.dark ::-webkit-scrollbar-thumb {
  background-color: rgb(51, 51, 51);
  box-shadow: inset 0 0 1px rgba(255, 255, 255, 0.5);
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

[data-tooltip]:hover::after,
[data-tooltip]:hover::before {
  opacity: 1;
  pointer-events: auto;
}

[data-tooltip]::after {
  position: absolute;
  bottom: -0.167rem /* -2px */;
  left: 0;
  z-index: 1;
  display: block;
  padding: 0.5rem /* 6px */ 1.333rem /* 16px */;
  border-radius: 0.417rem /* 5px */;
  background-color: rgb(48, 64, 81);
  color: white;
  content: attr(data-tooltip);
  white-space: pre;
  opacity: 0;
  transition: opacity 0.2s;
  transform: translateY(100%);
  pointer-events: none;
}

[data-tooltip]::before {
  position: absolute;
  bottom: -0.167rem /* -2px */;
  left: 2.5rem /* 30px */;
  display: block;
  width: 0;
  height: 0;
  border-right: 0.417rem /* 5px */ solid transparent;
  border-bottom: 0.417rem /* 5px */ solid rgb(48, 64, 81);
  border-left: 0.417rem /* 5px */ solid transparent;
  content: '';
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}

div.svelte-ukg5x{display:flex;overflow:hidden;flex:1 1 0;flex-direction:column}ul.svelte-ukg5x{overflow:auto;flex-grow:1;padding-top:0.583rem}
ul.svelte-1frls2x.svelte-1frls2x{display:flex;align-items:center;height:1.667rem;border-top:1px solid rgb(224, 224, 226)}li.svelte-1frls2x.svelte-1frls2x{display:flex;align-items:center;padding-left:0.75rem;cursor:pointer}li.selected.svelte-1frls2x.svelte-1frls2x{color:rgb(0, 116, 232)}li.svelte-1frls2x.svelte-1frls2x:hover{opacity:0.8}li.svelte-1frls2x.svelte-1frls2x:last-child{padding-right:0.75rem}li.svelte-1frls2x:last-child div.svelte-1frls2x{display:none}div.svelte-1frls2x.svelte-1frls2x{position:relative;margin-left:0.75rem;width:0;height:0;border-top:0.25rem solid transparent;border-bottom:0.25rem solid transparent;border-left:0.417rem solid #8e8eb2}div.svelte-1frls2x.svelte-1frls2x::after{position:absolute;top:-0.25rem;left:-0.417rem;display:block;width:0;height:0;border-top:0.25rem solid transparent;border-bottom:0.25rem solid transparent;border-left:0.167rem solid #ffffff;content:''}.dark ul.svelte-1frls2x.svelte-1frls2x{border-top-color:rgb(60, 60, 61)}.dark div.svelte-1frls2x.svelte-1frls2x::after{border-left-color:rgba(135, 135, 137, 0.9)}
.root.svelte-voryue{position:absolute;top:40%;left:50%;transform:translate(-50%, -50%)}h1.svelte-voryue{margin-top:2.5rem /* 30px */;margin-bottom:0.667rem /* 8px */;text-align:center;font-size:1.4em}ul.svelte-voryue{padding-left:1.667rem /* 20px */;list-style-type:disc}li.svelte-voryue{margin-bottom:0.667rem /* 8px */}
button.svelte-1jb7vvd{position:relative;z-index:1;margin:0.083rem /* 1px */;padding:0.417rem /* 5px */;outline:none;border:none;border-radius:0.167rem /* 2px */;background-color:transparent;color:rgb(12, 12, 13);line-height:0;cursor:pointer}button.active.svelte-1jb7vvd{color:rgb(0, 96, 223)}button.svelte-1jb7vvd:hover{background-color:rgb(237, 237, 240)}button.svelte-1jb7vvd:active:hover{color:inherit}button.svelte-1jb7vvd:active{color:rgba(12, 12, 13, 0.8)}button.svelte-1jb7vvd:disabled{color:rgba(12, 12, 13, 0.2)}.dark button.svelte-1jb7vvd{color:rgba(249, 249, 250, 0.7)}.dark button.active.svelte-1jb7vvd{color:rgb(117, 186, 255)}.dark button.svelte-1jb7vvd:hover{background-color:rgb(37, 37, 38)}.dark button.svelte-1jb7vvd:active{color:rgba(249, 249, 250, 0.8)}.dark button.svelte-1jb7vvd:disabled{color:rgba(249, 249, 250, 0.2)}.dark button.svelte-1jb7vvd:disabled,button.svelte-1jb7vvd:disabled{background-color:transparent;cursor:default}button.svelte-1jb7vvd svg{width:1.333rem;height:1.333rem;vertical-align:middle;fill:currentColor}
div.svelte-1yox9nf{position:fixed;top:0;right:0;bottom:0;left:0;cursor:default}ul.svelte-1yox9nf{position:absolute;top:2.667rem /* 32px */;left:-1.667rem /* -20px */;padding:0.5rem /* 6px */ 0;border:0.083rem /* 1px */ solid rgb(224, 224, 226);border-radius:0.167rem /* 2px */;background-color:#ffffff;box-shadow:0 0.083rem 0.25rem rgba(0, 0, 0, 0.075) !important;text-align:left;line-height:1}span.svelte-1yox9nf{position:absolute;top:-0.833rem /* -10px */;left:1.667rem /* 20px */;display:block;overflow:hidden;width:1.917rem /* 23px */;height:1rem /* 12px */}span.svelte-1yox9nf::before{position:absolute;top:0.25rem /* 3px */;left:0.167rem /* 2px */;display:block;width:1.333rem /* 16px */;height:1.333rem /* 16px */;border:0.083rem /* 1px */ solid rgb(224, 224, 226);background-color:#ffffff;box-shadow:0 0.083rem 0.25rem rgba(0, 0, 0, 0.075) !important;content:'';transform:rotate(45deg)}li.svelte-1yox9nf{position:relative;padding:0.333rem /* 4px */ 0.833rem /* 10px */ 0.333rem /* 4px */ 2.333rem
      /* 28px */}li.svelte-1yox9nf:hover{background-color:rgb(239, 239, 242)}li.checked.svelte-1yox9nf::before{position:absolute;top:0;left:0.833rem /* 10px */;display:block;width:0.917rem /* 11px */;height:100%;background:center / contain no-repeat
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='rgb(12, 12, 13)'%3E%3Cpath stroke-width='0.5' d='M6 14a1 1 0 0 1-.707-.293l-3-3a1 1 0 0 1 1.414-1.414l2.157 2.157 6.316-9.023a1 1 0 0 1 1.639 1.146l-7 10a1 1 0 0 1-.732.427A.863.863 0 0 1 6 14z'/%3E%3C/svg%3E%0A");content:''}.dark li.checked.svelte-1yox9nf::before{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='rgba(249, 249, 250, 0.7)'%3E%3Cpath stroke-width='0.5' d='M6 14a1 1 0 0 1-.707-.293l-3-3a1 1 0 0 1 1.414-1.414l2.157 2.157 6.316-9.023a1 1 0 0 1 1.639 1.146l-7 10a1 1 0 0 1-.732.427A.863.863 0 0 1 6 14z'/%3E%3C/svg%3E%0A")}.dark span.svelte-1yox9nf:before,.dark ul.svelte-1yox9nf{border:none;background-color:#4a4a4f;color:#f9f9fa}.dark li.svelte-1yox9nf:hover{background-color:#5c5c61}
div.svelte-o66q11{display:flex;align-items:stretch;padding:0 0.417rem /* 5px */;border-bottom:0.083rem /* 1px */ solid rgb(224, 224, 226);background-color:rgb(249, 249, 250)}.dark div.svelte-o66q11{border-bottom-color:rgb(60, 60, 61);background-color:rgb(42, 42, 46)}
form.svelte-24wsvu{display:flex;align-items:center;flex-grow:1;margin:0}svg.svelte-24wsvu{margin:0.333rem /* 4px */ 0.333rem /* 4px */ 0.333rem /* 4px */ 0.5rem
      /* 6px */;width:1rem /* 12px */}input.svelte-24wsvu{flex-grow:1;outline:none;border:none;background:none;color:inherit;font-size:inherit}.separator.svelte-24wsvu{margin:0 0.417rem /* 5px */;width:0.083rem /* 1px */;height:calc(100% - 0.833rem /* 10px */);background-color:rgb(224, 224, 226)}.dark .separator.svelte-24wsvu{background-color:rgb(60, 60, 61)}.next.svelte-24wsvu,.prev.svelte-24wsvu{position:relative;display:block;margin:0.417rem /* 5px */;width:0.417rem /* 5px */;height:0.417rem /* 5px */;border-style:solid;transform:rotate(45deg)}.next.svelte-24wsvu{bottom:0.167rem /* 2px */;border-width:0 0.083rem /* 1px */ 0.083rem /* 1px */ 0}.prev.svelte-24wsvu{top:0.167rem /* 2px */;border-width:0.083rem /* 1px */ 0 0 0.083rem /* 1px */}
.frame.svelte-1e93on8.svelte-1e93on8{flex-grow:1}p.svelte-1e93on8.svelte-1e93on8{display:flex;align-items:center;justify-content:center;height:100%}.panel.svelte-1e93on8.svelte-1e93on8{display:flex;flex-wrap:wrap;padding:1rem}.panel.svelte-1e93on8 div.svelte-1e93on8{margin:0.417rem /* 5px */ 0;width:calc(100% / 3)}.panel.svelte-1e93on8 span.svelte-1e93on8{margin-right:0.417rem /* 5px */;font-weight:bold}
.root.svelte-1l8s776{display:flex;flex:0 0 auto;flex-direction:column;height:100%;color:rgb(57, 63, 76)}.content.svelte-1l8s776{overflow-y:auto;flex-grow:1}.spacer.svelte-1l8s776{flex-grow:1}.dark .root.svelte-1l8s776{background-color:rgb(27, 27, 29);color:rgb(177, 177, 179)}
li.svelte-18cyfcm{position:relative}span.svelte-18cyfcm{position:absolute;top:1.6rem;bottom:1.6rem;z-index:1;width:0.167rem /* 2px */;background-color:#e0e0e2}li.flash.svelte-18cyfcm > :first-child,li.flash.svelte-18cyfcm > :first-child *,li.svelte-18cyfcm .flash,li.svelte-18cyfcm .flash *{animation:svelte-18cyfcm-flash 0.8s ease-in-out}@keyframes svelte-18cyfcm-flash{10%{background-color:rgb(250, 217, 242)}}li.svelte-18cyfcm .selected,li.svelte-18cyfcm .selected *,li.svelte-18cyfcm .hover.selected{background-color:rgb(0, 116, 232);color:#ffffff}li.svelte-18cyfcm > .selected::after{content:' == $s'}li.svelte-18cyfcm .hover{background-color:#f0f9fe}.dark span.svelte-18cyfcm,.dark li.svelte-18cyfcm .selected,.dark li.svelte-18cyfcm .selected *,.dark li.svelte-18cyfcm .hover.selected{background-color:rgb(32, 78, 138);color:#ffffff}.dark li.svelte-18cyfcm .hover{background-color:rgb(53, 59, 72)}
ul.svelte-1xgh790{display:flex}li.svelte-1xgh790{flex:0 1 auto;min-width:0.417rem /* 5px */}
.empty.svelte-kz400h{margin:0.667rem /* 8px */ 0 0 1rem /* 12px */;color:rgb(118, 118, 118)}h1.svelte-kz400h{margin:0.667rem /* 8px */ 0 0 0.667rem /* 8px */;color:rgb(118, 118, 118);font-weight:bold;font-size:0.917rem}ul.svelte-kz400h{margin:0.417rem /* 5px */}ul.svelte-kz400h,div.svelte-kz400h{margin-bottom:1.667rem /* 20px */}
div.svelte-131jtav{position:relative}.resize.horizontal.svelte-131jtav{position:absolute;top:0;bottom:0;left:0;width:0.417rem /* 5px */;border-left:0.083rem /* 1px */ solid rgb(224, 224, 226);cursor:ew-resize}.resize.vertical.svelte-131jtav{position:absolute;top:0;right:0;left:0;height:0.417rem /* 5px */;border-top:0.083rem /* 1px */ solid rgb(224, 224, 226);cursor:ns-resize}.resize.svelte-131jtav:hover{border-color:rgb(177, 177, 179)}.dark .resize.svelte-131jtav{border-color:rgb(60, 60, 61)}.dark .resize.svelte-131jtav:hover{border-color:rgb(107, 107, 108)}
div.svelte-x8r9lc{height:1.333rem /* 16px */;line-height:1.333rem /* 16px */}div.svelte-x8r9lc{color:rgb(151, 164, 179)}.dark div.svelte-x8r9lc{color:rgb(175, 181, 191)}
div.svelte-1hhhsbv{line-height:1.333rem /* 16px */}.tag-name.svelte-1hhhsbv{color:rgb(0, 116, 232)}.dark .tag-name.svelte-1hhhsbv{color:rgb(117, 191, 255)}
div.svelte-g71n30{height:1.333rem /* 16px */;line-height:1.333rem /* 16px */}div.svelte-g71n30{color:rgb(0, 116, 232)}.dark div.svelte-g71n30{color:rgb(117, 191, 255)}
div.svelte-x8r9lc{height:1.333rem /* 16px */;line-height:1.333rem /* 16px */}div.svelte-x8r9lc{color:rgb(151, 164, 179)}.dark div.svelte-x8r9lc{color:rgb(175, 181, 191)}
div.svelte-1oevsoq{color:rgb(151, 164, 179)}.dark div.svelte-1oevsoq{color:rgb(175, 181, 191)}
div.svelte-11jbbiy{display:flex;overflow:hidden;flex-wrap:wrap;justify-content:center;margin:0.083rem /* 1px */ 0 0 0.083rem /* 1px */;height:2rem;color:white;line-height:2rem;cursor:pointer}div.svelte-11jbbiy:hover{opacity:0.8}.mount.svelte-11jbbiy{background-color:rgb(0, 116, 232)}.patch.svelte-11jbbiy{background-color:rgb(221, 0, 169)}.detach.svelte-11jbbiy{background-color:rgb(115, 115, 115)}
ul.svelte-19h4tbk{margin-left:0.667rem /* 8px */;width:calc(100% - 0.667rem /* 8px */)}li.svelte-19h4tbk{position:relative;display:flex;align-items:end;flex-wrap:wrap;padding:0.333rem /* 4px */ 0 0.333rem /* 4px */ 1.25rem /* 15px */}.function.svelte-19h4tbk,.symbol.svelte-19h4tbk,.object.svelte-19h4tbk{color:rgb(0, 116, 232)}li.svelte-19h4tbk .string{color:rgb(221, 0, 169)}li.svelte-19h4tbk .number{color:rgb(5, 139, 0)}li.svelte-19h4tbk .null{color:rgb(115, 115, 115)}li.svelte-19h4tbk .collapse{margin-left:-1.25rem /* -15px */}.error.svelte-19h4tbk{position:absolute;top:0;right:0;font-size:0.917rem}.dark .function.svelte-19h4tbk,.dark .symbol.svelte-19h4tbk,.dark .object.svelte-19h4tbk{color:rgb(117, 191, 255)}.dark li.svelte-19h4tbk .string{color:rgb(255, 125, 233)}
.attr-name.svelte-1eqzefe{position:relative;color:rgb(221, 0, 169)}.attr-value.svelte-1eqzefe{display:inline-block;overflow:hidden;max-width:16.667rem /* 200px */;color:rgb(0, 62, 170);vertical-align:bottom;text-overflow:ellipsis;white-space:nowrap}.dark .attr-name.svelte-1eqzefe{color:rgb(255, 125, 233)}.dark .attr-value.svelte-1eqzefe{color:rgb(185, 142, 255)}
span.svelte-y3ayvn{position:relative;display:inline-block;align-self:stretch;width:1.25rem /* 15px */;vertical-align:bottom;cursor:pointer}span.svelte-y3ayvn::after{position:absolute;bottom:0.333rem /* 4px */;left:0.333rem /* 4px */;width:0;height:0;border-top:0.417rem /* 5px */ solid rgba(135, 135, 137, 0.9);border-right:0.333rem /* 4px */ solid transparent;border-left:0.333rem /* 4px */ solid transparent;content:'';transition:transform 0.3s;transform:rotate(0deg)}.node-tree span.svelte-y3ayvn::after{bottom:0.417rem /* 5px */}span.selected.svelte-y3ayvn::after{border-top-color:#ffffff}span.collapsed.svelte-y3ayvn::after{transform:rotate(-90deg)}
span.svelte-q8dzkt{background-color:yellow !important;color:black !important}
span.svelte-1e74dxt:not(.readOnly){flex-grow:1;cursor:pointer}input.svelte-1e74dxt{flex-grow:1;margin-right:0.833rem /* 10px */;outline:none;border:none;box-shadow:0 0 2px 1px rgba(0, 0, 0, 0.1);font-size:inherit}`;

  const ref = window.open('', null, 'location=off');

  while (ref.document.head.firstChild) {
    ref.document.head.removeChild(ref.document.head.firstChild);
  }

  while (ref.document.body.firstChild) {
    ref.document.body.removeChild(ref.document.body.firstChild);
  }

  const style = ref.document.createElement('style');
  style.innerHTML = rawStyles;
  ref.document.head.append(style);

  new SvelteDevToolsUi({
    target: ref.document.body,
    props: {
      hooks,
    },
  });

}());
