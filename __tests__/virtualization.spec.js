import { history, redo, undo } from 'prosemirror-history';
import { Fragment, Node, Schema } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import {
  initProseMirrorDoc,
  redo as redoYjs,
  undo as undoYjs,
  updateYFragment,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { Decoration, DecorationSet, EditorView, __findVirtualRange } from '../src/index.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    table: { content: 'tableRow+', group: 'block', toDOM: () => ['table', 0] },
    tableRow: { content: 'tableCell+', toDOM: () => ['tr', 0] },
    tableCell: { content: 'inline*', toDOM: () => ['td', 0] },
    bulletList: { content: 'listItem+', group: 'block', toDOM: () => ['ul', 0] },
    listItem: { content: 'paragraph+', toDOM: () => ['li', 0] },
    codeBlock: { content: 'text*', group: 'block', marks: '', toDOM: () => ['pre', ['code', 0]] },
    div: { content: 'block+', group: 'block', toDOM: () => ['div', 0] },
    custom: { content: 'block+', group: 'block', toDOM: () => ['div', 0] },
    text: { group: 'inline' },
  },
});

function makeDoc(count, textLength = 0) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const text = textLength ? 'x'.repeat(textLength) : `block ${i}`;
    nodes.push(schema.nodes.paragraph.create(null, schema.text(text)));
  }
  return schema.nodes.doc.create(null, nodes);
}

function makeViewFromDoc(doc, nodeViews, virtualizeTopLevel = { threshold: 2, overscanPx: 0 }, plugins = []) {
  const state = EditorState.create({ doc, plugins });
  const place = document.createElement('div');
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state,
    nodeViews,
    virtualizeTopLevel,
  });
  return { doc, place, view };
}

function makeView(count = 5, nodeViews, virtualizeTopLevel = { threshold: 2, overscanPx: 0 }, textLength = 0) {
  return withViewportHeight(135, () => makeViewFromDoc(makeDoc(count, textLength), nodeViews, virtualizeTopLevel));
}

function lastBlockStart(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function makeTable(rows = 6, columns = 3, textLength = 110) {
  const rowNodes = [];
  for (let row = 0; row < rows; row++) {
    const cells = [];
    for (let column = 0; column < columns; column++) {
      cells.push(schema.nodes.tableCell.create(null, schema.text('x'.repeat(textLength))));
    }
    rowNodes.push(schema.nodes.tableRow.create(null, cells));
  }
  return schema.nodes.table.create(null, rowNodes);
}

function makeList(items = 2, textLength = 110) {
  const itemNodes = [];
  for (let item = 0; item < items; item++) {
    itemNodes.push(schema.nodes.listItem.create(null,
      schema.nodes.paragraph.create(null, schema.text('x'.repeat(textLength)))));
  }
  return schema.nodes.bulletList.create(null, itemNodes);
}

function makeMixedDoc(count) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(i % 997 == 496
      ? makeTable(2, 2, 20)
      : schema.nodes.paragraph.create(null, schema.text(`block ${i}`)));
  }
  return schema.nodes.doc.create(null, nodes);
}

function makeHeavyDoc(count = 3000, tableCount = 500) {
  const nodes = [];
  for (let i = 0; i < tableCount; i++) nodes.push(makeTable());
  while (nodes.length < count) {
    const index = nodes.length;
    nodes.push(schema.nodes.paragraph.create(null, schema.text(`block ${index}`)));
  }
  return schema.nodes.doc.create(null, nodes);
}

// The same document with new content from `tailFrom` on: the blocks that
// changed cannot be matched to the old ones, so the reconciler rebuilds
// them.
function makeChunkedDoc(count, tailFrom) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    if (i >= tailFrom)
      nodes.push(schema.nodes.heading.create({ level: 2 }, schema.text(`block ${i} chunk`)));
    else
      nodes.push(schema.nodes.paragraph.create(null, schema.text(`block ${i}`)));
  }
  return schema.nodes.doc.create(null, nodes);
}

function withViewportHeight(height, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const restore = () => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (descriptor) Object.defineProperty(window, 'innerHeight', descriptor);
    else delete window.innerHeight;
  };
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === document.body || this === document.documentElement) {
      return { top: 0, bottom: height, left: 0, right: 800, width: 800, height };
    }
    return originalRect.call(this);
  };
  let result;
  try {
    result = callback();
  }
  catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then == 'function')
    return result.finally(restore);
  restore();
  return result;
}

// A placeholder takes the space of the block it stands in for: its border box
// plus the margins that collapse around it.
function placeholderFlowHeight(dom) {
  const box = Number.parseFloat(dom.style.height) || 0;
  const top = Number.parseFloat(dom.style.marginTop) || 0;
  const bottom = Number.parseFloat(dom.style.marginBottom) || 0;
  return box + Math.max(top, bottom);
}

function placeholderHeight(node) {
  return withViewportHeight(1, () => {
    const doc = schema.nodes.doc.create(null, [node, node]);
    const { place, view } = makeViewFromDoc(doc, undefined, { threshold: 0, overscanPx: 0 });
    const placeholder = view.dom.querySelector('[data-pm-virtual="true"]');
    expect(placeholder).not.toBeNull();
    const height = placeholderFlowHeight(placeholder);
    view.destroy();
    place.remove();
    return height;
  });
}

function trackPlaceholderHeightWrites(placeholders) {
  let writes = 0;
  const restores = [];
  for (const placeholder of placeholders) {
    const style = new Proxy(placeholder.style, {
      set(target, property, value) {
        if (property == 'height') writes++;
        return Reflect.set(target, property, value, target);
      },
    });
    Object.defineProperty(placeholder, 'style', {
      configurable: true,
      get() {
        return style;
      },
    });
    restores.push(() => delete placeholder.style);
  }
  return {
    get writes() { return writes; },
    reset() { writes = 0; },
    restore() { for (const restore of restores) restore(); },
  };
}

describe('top-level virtualization', () => {
  it('builds placeholders without invoking node views for off-screen blocks', () => {
    let factoryCalls = 0;
    const { place, view } = makeView(5, {
      paragraph: () => {
        factoryCalls++;
        return undefined;
      },
    });

    expect(view.dom.querySelectorAll('[data-pm-virtual="true"]').length).toBeGreaterThan(0);
    expect(factoryCalls).toBeLessThan(5);

    const callsBeforeDestroy = factoryCalls;
    view.destroy();
    expect(factoryCalls).toBe(callsBeforeDestroy);
    place.remove();
  });

  it('materializes the block containing the caret before rendering selection', () => {
    const { doc, place, view } = makeView();
    const start = lastBlockStart(doc, 4);
    expect(view.nodeDOM(start)).toBeNull();

    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, start + 2)));

    expect(view.nodeDOM(start)).not.toBeNull();

    view.destroy();
    place.remove();
  });

  it('round-trips a position through a materialized virtual block', () => {
    let factoryCalls = 0;
    const { doc, place, view } = makeView(5, {
      paragraph: () => {
        factoryCalls++;
        return undefined;
      },
    });
    const start = lastBlockStart(doc, 4);
    expect(view.nodeDOM(start)).toBeNull();

    const callsBeforeMaterialization = factoryCalls;
    const domPos = view.domAtPos(start + 2);

    expect(domPos.node).toBeTruthy();
    expect(view.posAtDOM(domPos.node, domPos.offset)).toBeGreaterThanOrEqual(start + 1);
    expect(factoryCalls).toBe(callsBeforeMaterialization + 1);

    view.domAtPos(start + 2);
    expect(factoryCalls).toBe(callsBeforeMaterialization + 1);

    view.destroy();
    place.remove();
  });

  it('materializes on scroll and corrects the anchor position', async () => {
    const { place, view } = makeView(30, undefined, { threshold: 2, overscanPx: 800 }, 500);
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScrollTo = window.scrollTo;
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    let scrollTop = 650;

    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollTop });
    window.scrollTo = (_x, y) => {
      scrollTop = y;
    };
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 768 - scrollTop, left: 0, right: 800, width: 800, height: 768 };
      }
      if (this.parentNode !== view.dom) return originalRect.call(this);
      const siblings = Array.from(view.dom.children);
      const index = siblings.indexOf(this);
      let top = 0;
      for (let i = 0; i < index; i++) {
        top += siblings[i].dataset.pmVirtual === 'true' ? 300 : 50;
      }
      const height = this.dataset.pmVirtual === 'true' ? 300 : 50;
      return { top: top - scrollTop, bottom: top - scrollTop + height, left: 0, right: 800, width: 800, height };
    };

    try {
      const before = view.dom.querySelectorAll('[data-pm-virtual="true"]').length;
      window.dispatchEvent(new window.Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(view.dom.querySelectorAll('[data-pm-virtual="true"]').length).toBeLessThan(before);
      expect(scrollTop).toBe(400);
    }
    finally {
      view.destroy();
      place.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      window.scrollTo = originalScrollTo;
      if (scrollYDescriptor) Object.defineProperty(window, 'scrollY', scrollYDescriptor);
      else delete window.scrollY;
    }
  });

  it('materializes blocks in an overflow ancestor without changing scroll height', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const doc = makeDoc(100, 500);
    const state = EditorState.create({ doc });
    const view = new EditorView(place, {
      state,
      virtualizeTopLevel: { threshold: 2, overscanPx: 100 },
    });
    let scrollTop = 0;

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return Array.from(view.dom.children).reduce((height, child) =>
          height + (child.dataset.pmVirtual === 'true'
            ? Number.parseFloat(child.style.height) || 0
            : 50), 0);
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller)
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      if (this === view.dom)
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      let top = 0;
      for (let child of view.dom.children) {
        if (child === this)
          return { top: top - scrollTop, bottom: top - scrollTop + 50, left: 0, right: 800, width: 800, height: 50 };
        top += child.dataset.pmVirtual === 'true' ? Number.parseFloat(child.style.height) || 0 : 50;
      }
      return originalRect.call(this);
    };

    try {
      expect(view._virtualization.scrollTarget).toBe(scroller);
      // Compare the post-calibration height; cold calibration is allowed to
      // correct the initial estimate before scrolling starts.
      await new Promise(resolve => requestAnimationFrame(resolve));
      const beforeHeight = scroller.scrollHeight;
      const beforeReal = view.dom.children.length - view.dom.querySelectorAll('[data-pm-virtual="true"]').length;

      scrollTop = 2000;
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new window.Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 30));

      const afterReal = view.dom.children.length - view.dom.querySelectorAll('[data-pm-virtual="true"]').length;
      expect(afterReal).toBeGreaterThan(beforeReal);
      expect(view._virtualization.range.start).toBeGreaterThan(0);
      expect(scroller.scrollHeight).toBeCloseTo(beforeHeight, 5);
    }
    finally {
      view.destroy();
      scroller.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('keeps text and selection transactions off the virtualized top-level path', async () => {
    const doc = makeDoc(3000);
    const { place, view } = makeViewFromDoc(doc, undefined, { threshold: 500, overscanPx: 800 });
    const domWindow = document.defaultView;
    const domNode = domWindow.Node.prototype;
    const insertBefore = vi.spyOn(domNode, 'insertBefore');
    const removeChild = vi.spyOn(domNode, 'removeChild');
    const replaceChild = vi.spyOn(domNode, 'replaceChild');
    const appendChild = vi.spyOn(domNode, 'appendChild');

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 1)));

      const childrenBeforeText = view.docView.children;
      const domChildrenBeforeText = Array.from(view.dom.children);
      insertBefore.mockClear();
      removeChild.mockClear();
      replaceChild.mockClear();
      appendChild.mockClear();

      const textStart = performance.now();
      view.dispatch(view.state.tr.insertText('x', 1));
      const textElapsed = performance.now() - textStart;
      const textReconciliations = view.docView.children === childrenBeforeText ? 0 : 1;
      const textDomWrites = insertBefore.mock.calls.length + removeChild.mock.calls.length +
        replaceChild.mock.calls.length + appendChild.mock.calls.length;

      expect.soft(textReconciliations).toBe(0);
      expect.soft(textDomWrites).toBe(0);
      expect(textElapsed).toBeLessThan(30);
      expect(Array.from(view.dom.children)).toEqual(domChildrenBeforeText);

      const childrenBeforeSelection = view.docView.children;
      const domChildrenBeforeSelection = Array.from(view.dom.children);
      insertBefore.mockClear();
      removeChild.mockClear();
      replaceChild.mockClear();
      appendChild.mockClear();

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      const selectionReconciliations = view.docView.children === childrenBeforeSelection ? 0 : 1;
      const selectionDomWrites = insertBefore.mock.calls.length + removeChild.mock.calls.length +
        replaceChild.mock.calls.length + appendChild.mock.calls.length;

      expect.soft(selectionReconciliations).toBe(0);
      expect.soft(selectionDomWrites).toBe(0);
      expect(Array.from(view.dom.children)).toEqual(domChildrenBeforeSelection);
    }
    finally {
      insertBefore.mockRestore();
      removeChild.mockRestore();
      replaceChild.mockRestore();
      appendChild.mockRestore();
      view.destroy();
      place.remove();
    }
  });

  it('keeps a deep insert dispatch proportional to the visible range', () => {
    const doc = makeMixedDoc(3000);
    const { place, view } = makeViewFromDoc(doc, undefined, { threshold: 500, overscanPx: 800 });
    const lastParagraphPos = lastBlockStart(doc, doc.childCount - 1) + 1;

    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, lastParagraphPos)));
      const start = performance.now();
      view.dispatch(view.state.tr.insertText('x', lastParagraphPos));
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(30);
    }
    finally {
      view.destroy();
      place.remove();
    }
  });

  it('keeps a top-level structural edit proportional to the visible range', () => {
    const doc = makeHeavyDoc();
    const { place, view } = makeViewFromDoc(
      doc,
      undefined,
      { threshold: 500, overscanPx: 800 },
      [history()],
    );
    const lastIndex = doc.childCount - 1;
    const placeholdersBefore = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
    const placeholderSet = new WeakSet(placeholdersBefore);
    const heightWrites = trackPlaceholderHeightWrites(placeholdersBefore);
    const eqSpy = vi.spyOn(Node.prototype, 'eq');

    try {
      const originalHeight = placeholdersBefore[0].style.height;
      placeholdersBefore[0].style.height = originalHeight;
      expect(heightWrites.writes).toBe(1);
      heightWrites.reset();

      const nextChildren = [];
      for (let index = 0; index < doc.childCount; index++) {
        if (index == lastIndex) continue;
        const child = doc.child(index);
        nextChildren.push(child.copy(child.content));
      }
      const moved = doc.child(lastIndex);
      nextChildren.push(moved.copy(moved.content));
      const nextDoc = doc.copy(Fragment.from(nextChildren));

      eqSpy.mockClear();
      const start = performance.now();
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, nextDoc.content));
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(30);
      const moveEqCalls = eqSpy.mock.calls.length;
      expect(moveEqCalls).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);
      expect(placeholdersBefore.length).toBeGreaterThan(0);
      const placeholdersAfter = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      for (const placeholder of placeholdersAfter)
        expect(placeholderSet.has(placeholder)).toBe(true);

      eqSpy.mockClear();
      heightWrites.reset();
      const undoStart = performance.now();
      expect(undo(view.state, view.dispatch)).toBe(true);
      const undoElapsed = performance.now() - undoStart;
      expect(undoElapsed).toBeLessThan(30);
      const undoEqCalls = eqSpy.mock.calls.length;
      expect(undoEqCalls).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);
      const placeholdersAfterUndo = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      expect(placeholdersAfterUndo.filter(placeholder => !placeholderSet.has(placeholder)).length)
        .toBeLessThanOrEqual(1);

      eqSpy.mockClear();
      heightWrites.reset();
      const redoStart = performance.now();
      expect(redo(view.state, view.dispatch)).toBe(true);
      const redoElapsed = performance.now() - redoStart;
      expect(redoElapsed).toBeLessThan(30);
      const redoEqCalls = eqSpy.mock.calls.length;
      expect(redoEqCalls).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);
      const knownPlaceholders = new WeakSet([...placeholdersAfter, ...placeholdersAfterUndo]);
      const placeholdersAfterRedo = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      expect(placeholdersAfterRedo.filter(placeholder => !knownPlaceholders.has(placeholder)).length)
        .toBeLessThanOrEqual(1);

      eqSpy.mockClear();
      heightWrites.reset();
      const insertAt = lastBlockStart(view.state.doc, 1000);
      const insertStart = performance.now();
      view.dispatch(view.state.tr.insert(insertAt,
        schema.nodes.paragraph.create(null, schema.text('inserted block'))));
      expect(performance.now() - insertStart).toBeLessThan(30);
      expect(eqSpy.mock.calls.length).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);

      eqSpy.mockClear();
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(eqSpy.mock.calls.length).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);

      eqSpy.mockClear();
      heightWrites.reset();
      const deleteAt = lastBlockStart(view.state.doc, 2000);
      const deleteEnd = deleteAt + view.state.doc.child(2000).nodeSize;
      const deleteStart = performance.now();
      view.dispatch(view.state.tr.delete(deleteAt, deleteEnd));
      expect(performance.now() - deleteStart).toBeLessThan(30);
      expect(eqSpy.mock.calls.length).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);

      eqSpy.mockClear();
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(eqSpy.mock.calls.length).toBeLessThan(200);
      expect(heightWrites.writes).toBe(0);
    }
    finally {
      eqSpy.mockRestore();
      heightWrites.restore();
      view.destroy();
      place.remove();
    }
  });

  it('keeps a Yjs binding move and undo proportional with a root widget', async () => {
    const doc = makeHeavyDoc();
    const ydoc = new Y.Doc();
    const yfrag = ydoc.getXmlFragment('content');
    updateYFragment(ydoc, yfrag, doc, { mapping: new Map(), isOMark: new Map() });
    const { doc: boundDoc, mapping } = initProseMirrorDoc(yfrag, schema);
    const undoManager = new Y.UndoManager(ydoc, {
      trackedOrigins: new Set([ySyncPluginKey]),
    });
    const state = EditorState.create({
      doc: boundDoc,
      plugins: [
        ySyncPlugin(yfrag, { mapping }),
        yUndoPlugin({ undoManager }),
        new Plugin({
          props: {
            decorations: state => DecorationSet.create(state.doc, [
              Decoration.widget(0, () => document.createElement('span'), {
                key: 'root-widget',
                side: 1,
              }),
            ]),
          },
        }),
      ],
    });
    const place = document.createElement('div');
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state,
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });
    const originalEq = Node.prototype.eq;
    let dispatchDepth = 0;
    let dispatchEqCalls = 0;
    const eqSpy = vi.spyOn(Node.prototype, 'eq').mockImplementation(function eq(other) {
      if (dispatchDepth) dispatchEqCalls++;
      return originalEq.call(this, other);
    });
    const dispatch = view.dispatch;
    view.dispatch = transaction => {
      dispatchDepth++;
      try {
        return dispatch(transaction);
      }
      finally {
        dispatchDepth--;
      }
    };
    let heightWrites;

    try {
      const fromIndex = 2;
      const targetIndex = 6;
      const moved = view.state.doc.child(fromIndex);
      const source = lastBlockStart(view.state.doc, fromIndex);
      const target = lastBlockStart(view.state.doc, targetIndex);
      const originalTexts = view.state.doc.content.content.map(node => node.textContent);

      const moveStart = performance.now();
      const move = view.state.tr
        .delete(source, source + moved.nodeSize)
        .insert(target - moved.nodeSize, moved);
      view.dispatch(move);
      const moveElapsed = performance.now() - moveStart;
      const moveEqCalls = dispatchEqCalls;

      expect(moveElapsed).toBeLessThan(150);
      expect(moveEqCalls).toBeLessThan(200);
      expect(view.state.doc.child(5).textContent).toBe(moved.textContent);
      expect(undoManager.undoStack.length).toBe(1);

      const virtualState = view._virtualization;
      const trackedIndex = 1000;
      const trackedDesc = view._virtualization.topLevelDescs[trackedIndex];
      expect(trackedDesc.virtual).toBe(true);
      const trackedNode = trackedDesc.node;
      const measuredHeight = trackedDesc.estimatedHeight;
      const adjustment = 7;
      virtualState.heights.set(trackedNode, measuredHeight);
      virtualState.estimates.set(trackedNode, measuredHeight);
      virtualState.heightAdjustments.set(trackedNode, adjustment);
      trackedDesc.estimatedHeight += adjustment;
      const expectedHeight = trackedDesc.estimatedHeight;
      trackedDesc.dom.style.height = expectedHeight + 'px';

      const placeholdersBeforeUndo = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      const placeholderSet = new WeakSet(placeholdersBeforeUndo);
      const rootWidgetBeforeUndo = view.dom.querySelector('.ProseMirror-widget');
      expect(rootWidgetBeforeUndo).not.toBeNull();
      heightWrites = trackPlaceholderHeightWrites(placeholdersBeforeUndo);
      const descsBeforeUndo = new Set(view.docView.children);
      dispatchEqCalls = 0;
      await new Promise(resolve => setTimeout(resolve, 500));

      const undoStart = performance.now();
      expect(undoYjs(view.state)).toBe(true);
      const undoElapsed = performance.now() - undoStart;
      const undoEqCalls = dispatchEqCalls;

      expect(undoElapsed).toBeLessThan(150);
      expect(undoEqCalls).toBeLessThan(200);
      expect(view.state.doc.content.content.map(node => node.textContent)).toEqual(originalTexts);
      expect(view.docView.children.filter(desc => !descsBeforeUndo.has(desc)).length)
        .toBeLessThanOrEqual(2);
      const placeholdersAfterUndo = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      expect(placeholdersAfterUndo.filter(placeholder => !placeholderSet.has(placeholder)).length)
        .toBeLessThanOrEqual(1);
      expect(heightWrites.writes).toBe(0);
      expect(view.dom.querySelector('.ProseMirror-widget')).toBe(rootWidgetBeforeUndo);

      const restoredDesc = view._virtualization.topLevelDescs[trackedIndex];
      const restoredNode = restoredDesc.node;
      expect(virtualState.heights.get(restoredNode)).toBe(measuredHeight);
      expect(virtualState.estimates.get(restoredNode)).toBe(measuredHeight);
      expect(virtualState.heightAdjustments.get(restoredNode)).toBe(adjustment);
      expect(restoredDesc.dom.style.height).toBe(expectedHeight + 'px');

      const descsBeforeRedo = new Set(view.docView.children);
      const placeholdersBeforeRedo = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      const redoPlaceholderSet = new WeakSet(placeholdersBeforeRedo);
      heightWrites.reset();
      dispatchEqCalls = 0;

      const redoStart = performance.now();
      expect(redoYjs(view.state)).toBe(true);
      const redoElapsed = performance.now() - redoStart;
      const redoEqCalls = dispatchEqCalls;

      expect(redoElapsed).toBeLessThan(150);
      expect(redoEqCalls).toBeLessThan(200);
      expect(view.state.doc.child(5).textContent).toBe(moved.textContent);
      expect(view.docView.children.filter(desc => !descsBeforeRedo.has(desc)).length)
        .toBeLessThanOrEqual(2);
      const placeholdersAfterRedo = Array.from(view.dom.querySelectorAll('[data-pm-virtual="true"]'));
      expect(placeholdersAfterRedo.filter(placeholder => !redoPlaceholderSet.has(placeholder)).length)
        .toBeLessThanOrEqual(1);
      expect(heightWrites.writes).toBe(0);
      expect(view.dom.querySelector('.ProseMirror-widget')).toBe(rootWidgetBeforeUndo);

      const redoneDesc = view._virtualization.topLevelDescs[trackedIndex];
      const redoneNode = redoneDesc.node;
      expect(virtualState.heights.get(redoneNode)).toBe(measuredHeight);
      expect(virtualState.estimates.get(redoneNode)).toBe(measuredHeight);
      expect(virtualState.heightAdjustments.get(redoneNode)).toBe(adjustment);
      expect(redoneDesc.dom.style.height).toBe(expectedHeight + 'px');
    }
    finally {
      eqSpy.mockRestore();
      heightWrites?.restore();
      undoManager.destroy();
      view.destroy();
      place.remove();
      ydoc.destroy();
    }
  });

  it('keeps a scrolled structural move and undo within the live budget', async () => {
    // The live shape: a heavy document bound to Yjs, scrolled until a few
    // dozen blocks are materialized, then a structural move through the
    // binding and the Yjs undo (popStackItem) back to the original document.
    const doc = makeHeavyDoc();
    const ydoc = new Y.Doc();
    const yfrag = ydoc.getXmlFragment('content');
    updateYFragment(ydoc, yfrag, doc, { mapping: new Map(), isOMark: new Map() });
    const { doc: boundDoc, mapping } = initProseMirrorDoc(yfrag, schema);
    const undoManager = new Y.UndoManager(ydoc, { trackedOrigins: new Set([ySyncPluginKey]) });
    const state = EditorState.create({
      doc: boundDoc,
      plugins: [ySyncPlugin(yfrag, { mapping }), yUndoPlugin({ undoManager })],
    });
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const view = new EditorView(place, {
      state,
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const domNode = document.defaultView.Node.prototype;
    let scrollTop = 0;

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => 50 * view.dom.children.length,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = value; },
    });
    // Consistent geometry: every block is 50px tall, so materializing a block
    // never moves the blocks below it.
    const rectMock = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      const index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) {
        // Nested elements (table cells) get a one line height so the table
        // calibration can be computed, like in the live app.
        return { top: 0, bottom: 25.56, left: 0, right: 100, width: 100, height: 25.56 };
      }
      const top = index * 50 - scrollTop;
      return { top, bottom: top + 50, left: 0, right: 800, width: 800, height: 50 };
    };
    HTMLElement.prototype.getBoundingClientRect = rectMock;

    // A layout read after a DOM write forces the browser to lay the editor
    // out again. The live editor paid for four of those per structural edit.
    const events = [];
    const layoutSpies = [];
    for (const method of ['insertBefore', 'removeChild', 'replaceChild', 'appendChild']) {
      const original = domNode[method];
      layoutSpies.push(vi.spyOn(domNode, method).mockImplementation(function (...args) {
        events.push('write');
        return original.apply(this, args);
      }));
    }
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (...args) {
        events.push('read');
        return rectMock.apply(this, args);
      });
    const originalEq = Node.prototype.eq;
    let dispatchDepth = 0;
    let dispatchEqCalls = 0;
    const eqSpy = vi.spyOn(Node.prototype, 'eq').mockImplementation(function eq(other) {
      if (dispatchDepth) dispatchEqCalls++;
      return originalEq.call(this, other);
    });
    const dispatch = view.dispatch;
    view.dispatch = transaction => {
      dispatchDepth++;
      try {
        return dispatch(transaction);
      }
      finally {
        dispatchDepth--;
      }
    };
    const originalUpdateStateInner = EditorView.prototype.updateStateInner;
    let updateCalls = 0;
    let updateMs = 0;
    const updateSpy = vi.spyOn(view, 'updateStateInner').mockImplementation(function (...args) {
      const start = performance.now();
      try {
        return originalUpdateStateInner.apply(this, args);
      }
      finally {
        updateCalls++;
        updateMs += performance.now() - start;
      }
    });
    const forcedLayouts = () => {
      let dirty = false;
      let cycles = 0;
      for (const event of events) {
        if (event == 'write') dirty = true;
        else if (dirty) {
          cycles++;
          dirty = false;
        }
      }
      return cycles;
    };
    const realDescs = () => view._virtualization.topLevelDescs.filter(desc => desc && !desc.virtual).length;

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      scrollTop = 3200;
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new window.Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 60));
      // The caret block is materialized as well.
      const caretIndex = 600;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(
        view.state.doc,
        lastBlockStart(view.state.doc, caretIndex) + 1,
      )));
      await new Promise(resolve => setTimeout(resolve, 30));

      const materialized = realDescs();
      expect(materialized).toBeGreaterThan(10);
      expect(materialized).toBeLessThan(60);

      const node = view.state.doc.child(2);
      const from = 2;
      const to = 2 + node.nodeSize;
      let targetPos = 2;
      for (let index = 0; index < 6; index++) targetPos += view.state.doc.child(index).nodeSize;
      const originalTexts = view.state.doc.content.content.map(child => child.textContent);
      const descsBeforeMove = new Set(view.docView.children);

      events.length = 0;
      dispatchEqCalls = 0;
      updateCalls = 0;
      updateMs = 0;
      const moveStart = performance.now();
      view.dispatch(view.state.tr.delete(from, to).insert(targetPos - node.nodeSize, node));
      const moveMs = performance.now() - moveStart;
      const moveForced = forcedLayouts();
      const moveEqCalls = dispatchEqCalls;

      expect(moveMs).toBeLessThan(150);
      expect(updateMs).toBeLessThan(150);
      // The comparison work stays proportional to the materialized blocks,
      // not to the 3000 blocks of the document.
      expect(moveEqCalls).toBeLessThan(materialized * 10);
      // One layout pass at most: the range and the anchor are read before the
      // DOM is changed.
      expect(moveForced).toBeLessThanOrEqual(1);
      expect(view.docView.children.filter(desc => !descsBeforeMove.has(desc)).length)
        .toBeLessThanOrEqual(4);

      events.length = 0;
      dispatchEqCalls = 0;
      updateCalls = 0;
      updateMs = 0;
      const undoStart = performance.now();
      expect(undoYjs(view.state)).toBe(true);
      const undoMs = performance.now() - undoStart;
      const undoForced = forcedLayouts();
      const undoEqCalls = dispatchEqCalls;

      expect(undoMs).toBeLessThan(150);
      expect(updateMs).toBeLessThan(150);
      expect(undoEqCalls).toBeLessThan(materialized * 10);
      expect(undoForced).toBeLessThanOrEqual(1);
      expect(view.state.doc.content.content.map(child => child.textContent)).toEqual(originalTexts);
      expect(view.state.doc.childCount).toBe(doc.childCount);
    }
    finally {
      updateSpy.mockRestore();
      eqSpy.mockRestore();
      rectSpy.mockRestore();
      for (const spy of layoutSpies) spy.mockRestore();
      undoManager.destroy();
      view.destroy();
      place.remove();
      scroller.remove();
      ydoc.destroy();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('keeps the scroll position and the scroll height stable while blocks swap', async () => {
    // A margin aware layout mock: every block has a border box and margins,
    // the browser collapses the margins between siblings and the scroll
    // height is the sum of the flow heights. A placeholder that loses the
    // margins of the block it stands in for moves everything below it.
    const BLOCK_HEIGHT = 25.56;
    const PARAGRAPH_MARGIN = 8.52;
    const HEADING_MARGIN = 17.04;
    const blocks = [];
    for (let index = 0; index < 300; index++) {
      blocks.push(index % 2
        ? schema.nodes.heading.create({ level: 4 }, schema.text(`Heading ${index}`))
        : schema.nodes.paragraph.create(null, schema.text(`block ${index}`)));
    }
    const doc = schema.nodes.doc.create(null, blocks);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({ doc }),
      virtualizeTopLevel: { threshold: 100, overscanPx: 200 },
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalStyle = window.getComputedStyle;
    let scrollTop = 0;

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = value; },
    });
    const layout = () => {
      const children = Array.from(view.dom.children);
      const boxes = [];
      let cursor = 0;
      let previousBottom = 0;
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const virtual = child.dataset.pmVirtual === 'true';
        const box = virtual ? (Number.parseFloat(child.style.height) || 0) : BLOCK_HEIGHT;
        let top;
        let bottom;
        if (virtual) {
          top = Number.parseFloat(child.style.marginTop) || 0;
          bottom = Number.parseFloat(child.style.marginBottom) || 0;
        }
        else {
          const margin = child.tagName == 'H4' ? HEADING_MARGIN : PARAGRAPH_MARGIN;
          top = margin;
          bottom = margin;
        }
        // The first block of the editor has no top margin.
        if (index === 0) top = 0;
        cursor += Math.max(previousBottom, top);
        boxes.push({ top: cursor, height: box, bottom: cursor + box });
        cursor += box;
        previousBottom = bottom;
      }
      return { boxes, total: cursor + previousBottom };
    };
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => layout().total,
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      const index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) return originalRect.call(this);
      const box = layout().boxes[index];
      return {
        top: box.top - scrollTop,
        bottom: box.bottom - scrollTop,
        left: 0,
        right: 800,
        width: 800,
        height: box.height,
      };
    };
    window.getComputedStyle = element => {
      const style = originalStyle.call(window, element);
      const margin = element.tagName == 'H4' ? HEADING_MARGIN : PARAGRAPH_MARGIN;
      const first = element.parentElement && element.parentElement.firstElementChild == element;
      const overrides = {
        fontSize: '17.04px',
        lineHeight: '25.56px',
        marginTop: (first ? 0 : margin) + 'px',
        marginBottom: margin + 'px',
      };
      return new Proxy(style, {
        get(target, property) {
          if (property in overrides) return overrides[property];
          const value = target[property];
          return typeof value == 'function' ? value.bind(target) : value;
        },
      });
    };
    const positions = () => layout().boxes.map(box => box.top - scrollTop);

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      let previous = positions();
      const drifts = [];
      const heights = [];

      for (let step = 0; step < 8; step++) {
        const requested = scrollTop + 400;
        scrollTop = requested;
        scroller.scrollTop = requested;
        scroller.dispatchEvent(new window.Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 30));
        // A scroll correction that the virtualizer applies itself is not a
        // drift, the blocks have to stay where the scroll put them.
        const correction = scrollTop - requested;
        const current = positions();
        let drift = 0;
        for (let index = 0; index < current.length; index++)
          drift = Math.max(drift, Math.abs(current[index] - (previous[index] - 400 - correction)));
        drifts.push(drift);
        heights.push(scroller.scrollHeight);
        previous = current;
      }

      expect(Math.max(...drifts)).toBeLessThanOrEqual(1);
      expect(new Set(heights).size).toBe(1);
    }
    finally {
      view.destroy();
      place.remove();
      scroller.remove();
      window.getComputedStyle = originalStyle;
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('routes a wholesale top-level rewrite through the virtualized reconciler', async () => {
    const doc = makeHeavyDoc();
    const { place, view } = makeViewFromDoc(doc, undefined, { threshold: 500, overscanPx: 800 });
    const eqSpy = vi.spyOn(Node.prototype, 'eq');

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const childrenBefore = view.docView.children;
      const descsBefore = view._virtualization.topLevelDescs.slice();
      // A wholesale rewrite replaces every top-level child with a fresh node
      // object while keeping the child count, which used to fall through to
      // the generic ProseMirror path and match all 3000 blocks one by one.
      const rewritten = [];
      for (let index = 0; index < doc.childCount; index++) {
        rewritten.push(Node.fromJSON(schema, doc.child(index).toJSON()));
      }

      eqSpy.mockClear();
      const start = performance.now();
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size,
        doc.copy(Fragment.from(rewritten)).content));
      const elapsed = performance.now() - start;

      // The virtualized reconciler swaps in a new children array; the generic
      // path mutates the existing one in place.
      expect(view.docView.children).not.toBe(childrenBefore);
      expect(elapsed).toBeLessThan(150);
      expect(eqSpy.mock.calls.length).toBeLessThan(200);
      const descsAfter = view._virtualization.topLevelDescs;
      expect(descsAfter.filter(desc => descsBefore.includes(desc)).length)
        .toBeGreaterThan(doc.childCount - 5);
    }
    finally {
      eqSpy.mockRestore();
      view.destroy();
      place.remove();
    }
  });

  it('keeps the materialized blocks bounded to the visible range while scrolling', async () => {
    const doc = makeHeavyDoc();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScrollTo = window.scrollTo;
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({ doc }),
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });
    let scrollTop = 0;

    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollTop });
    window.scrollTo = (_x, y) => {
      scrollTop = y;
    };
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 50 * view.dom.children.length;
      },
    });
    // Every block is 50px tall, materialized or not, so materializing a block
    // never moves the blocks below it.
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      let index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) return originalRect.call(this);
      let top = index * 50 - scrollTop;
      return { top, bottom: top + 50, left: 0, right: 800, width: 800, height: 50 };
    };

    const realDescs = () => view._virtualization.topLevelDescs.filter(desc => desc && !desc.virtual).length;

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const beforeReal = realDescs();

      scrollTop = 20000;
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new window.Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 60));

      const range = view._virtualization.range;
      const afterReal = realDescs();
      expect(range.start).toBeGreaterThan(0);
      expect(afterReal).toBeGreaterThan(0);
      // Blocks left behind by the scroll must not stay materialized, otherwise
      // every later edit has to tear down all of them.
      expect(afterReal).toBeLessThanOrEqual(range.end - range.start + 2);
      expect(afterReal).toBeLessThan(beforeReal + (range.end - range.start));
    }
    finally {
      view.destroy();
      place.remove();
      scroller.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      window.scrollTo = originalScrollTo;
      if (scrollYDescriptor) Object.defineProperty(window, 'scrollY', scrollYDescriptor);
      else delete window.scrollY;
    }
  });

  it('bounds heavy mount DOM bridge work to the visible range', () => {
    const doc = makeHeavyDoc();
    const place = document.createElement('div');
    document.body.appendChild(place);
    const domWindow = document.defaultView;
    const domNode = domWindow.Node.prototype;
    const createElement = vi.spyOn(document, 'createElement');
    const setAttribute = vi.spyOn(domWindow.Element.prototype, 'setAttribute');
    const insertBefore = vi.spyOn(domNode, 'insertBefore');
    const replaceChild = vi.spyOn(domNode, 'replaceChild');
    let view;

    try {
      view = new EditorView(place, {
        state: EditorState.create({ doc }),
        virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
      });
      const topLevelInsertions = insertBefore.mock.contexts.filter(parent => parent === view.dom).length;
      const topLevelReplacements = replaceChild.mock.contexts.filter(parent => parent === view.dom).length;
      const domBridgeCalls = createElement.mock.calls.length +
        setAttribute.mock.calls.length +
        topLevelInsertions +
        topLevelReplacements;

      expect(domBridgeCalls).toBeLessThan(500);
      expect(view.dom.children.length).toBe(doc.childCount);
      const placeholders = view.dom.querySelectorAll('[data-pm-virtual="true"]');
      expect(placeholders.length).toBeGreaterThan(2900);
      expect(placeholders[0].className).toBe('ProseMirror-virtual-placeholder');
      expect(placeholders[0].getAttribute('aria-hidden')).toBe('true');
      expect(placeholders[0].contentEditable).toBe('false');
      expect(placeholders[0].style.overflow).toBe('hidden');
    }
    finally {
      view?.destroy();
      place.remove();
      createElement.mockRestore();
      setAttribute.mockRestore();
      insertBefore.mockRestore();
      replaceChild.mockRestore();
    }
  });

  it('dematerializes stale real blocks when virtualization activates', () => {
    withViewportHeight(100, () => {
      const { doc, place, view } = makeView(5, undefined, { threshold: 5, overscanPx: 0 });
      expect(view._virtualization).toBeNull();

      const added = Array.from({ length: 20 }, (_, index) =>
        schema.nodes.paragraph.create(null, schema.text(`added ${index}`)));
      const grownDoc = doc.copy(Fragment.from([...doc.content.content, ...added]));
      view.updateState(EditorState.create({ doc: grownDoc }));

      const state = view._virtualization;
      expect(state).not.toBeNull();
      expect(state.range.end).toBeLessThan(grownDoc.childCount);
      expect(view.docView.children[state.range.end].virtual).toBe(true);
      expect(view.docView.children[0].virtual).toBeFalsy();
      for (let index = state.range.end; index < grownDoc.childCount; index++) {
        expect(view.docView.children[index].virtual).toBe(true);
      }

      const lastPos = lastBlockStart(grownDoc, grownDoc.childCount - 1) + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(grownDoc, lastPos)));
      expect(view.nodeDOM(lastPos)).not.toBeNull();

      view.destroy();
      place.remove();
    });
  });

  it('estimates placeholder heights by node type', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('x'.repeat(110)));
    const heading = schema.nodes.heading.create({ level: 3 }, schema.text('Heading'));
    const table = makeTable();
    const list = makeList();
    const codeBlock = schema.nodes.codeBlock.create(null, schema.text('code\n'.repeat(8).trim()));
    const div = schema.nodes.div.create(null,
      schema.nodes.paragraph.create(null, schema.text('x'.repeat(110))));
    const custom = schema.nodes.custom.create(null,
      schema.nodes.paragraph.create(null, schema.text('custom')));

    expect(placeholderHeight(paragraph)).toBeLessThan(100);
    expect(placeholderHeight(heading)).toBeGreaterThan(40);
    expect(placeholderHeight(heading)).toBeLessThan(200);
    expect(placeholderHeight(table)).toBeGreaterThan(550);
    expect(placeholderHeight(table)).toBeLessThan(620);
    expect(placeholderHeight(list)).toBeLessThan(200);
    expect(placeholderHeight(codeBlock)).toBeLessThan(300);
    expect(placeholderHeight(div)).toBeLessThan(150);
    expect(placeholderHeight(custom)).toBe(300);
  });

  it('calibrates a node type from its first real layout', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const text = 'x'.repeat(200);
    const nodeViews = {
      paragraph: () => {
        const dom = document.createElement('p');
        const contentDOM = document.createElement('span');
        dom.dataset.pmCalibration = 'true';
        dom.style.lineHeight = '20px';
        dom.style.fontSize = '10px';
        dom.style.marginTop = '5px';
        dom.style.marginBottom = '5px';
        dom.appendChild(contentDOM);
        return { dom, contentDOM };
      },
    };

    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.dataset && this.dataset.pmCalibration === 'true') {
        return { top: 0, bottom: 40, left: 0, right: 800, width: 800, height: 40 };
      }
      return originalRect.call(this);
    };

    try {
      await withViewportHeight(1, async () => {
        const firstDoc = schema.nodes.doc.create(null,
          [schema.nodes.paragraph.create(null, schema.text(text))]);
        const { place, view } = makeViewFromDoc(firstDoc, nodeViews, { threshold: 0, overscanPx: 0 });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const calibration = view._virtualization.calibration.get('paragraph');
        expect(calibration).toBeTruthy();
        expect(calibration.charsPerLine).toBe(100);

        const secondDoc = schema.nodes.doc.create(null, [
          schema.nodes.paragraph.create(null, schema.text(text)),
          schema.nodes.paragraph.create(null, schema.text(text)),
        ]);
        view.updateState(EditorState.create({ doc: secondDoc }));

        const placeholder = view.dom.querySelector('[data-pm-virtual="true"]');
        expect(placeholder).not.toBeNull();
        // Two calibrated lines of 20px plus the 5px margin of the block.
        expect(placeholderFlowHeight(placeholder)).toBe(45);

        view.destroy();
        place.remove();
      });
    }
    finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('defers heavy mount activation without changing the activated state', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalScrollTo = window.scrollTo;
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    let rectCalls = 0;
    let scrollTop = 0;
    const scrollCalls = [];

    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      rectCalls++;
      if (this.classList?.contains('ProseMirror')) {
        return {
          top: -scrollTop,
          bottom: 768 - scrollTop,
          left: 0,
          right: 800,
          width: 800,
          height: 768,
        };
      }
      const parent = this.parentNode;
      if (parent?.classList?.contains('ProseMirror')) {
        let top = 0;
        for (const sibling of parent.children) {
          const height = sibling.dataset.pmVirtual === 'true'
            ? Number.parseFloat(sibling.style.height) || 0
            : 50;
          if (sibling === this) {
            return {
              top: top - scrollTop,
              bottom: top - scrollTop + height,
              left: 0,
              right: 800,
              width: 800,
              height,
            };
          }
          top += height;
        }
      }
      return originalRect.call(this);
    };
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollTop });
    window.scrollTo = (_x, y) => {
      scrollCalls.push(y);
      scrollTop = y;
    };

    const doc = makeDoc(3000);
    const referencePlace = document.createElement('div');
    const deferredPlace = document.createElement('div');
    document.body.append(referencePlace, deferredPlace);
    let reference;
    let deferred;

    try {
      globalThis.requestAnimationFrame = callback => {
        callback(0);
        return 1;
      };
      reference = new EditorView(referencePlace, {
        state: EditorState.create({ doc }),
        virtualizeTopLevel: { threshold: 500, overscanPx: 0 },
      });
      const referenceScrollCalls = [...scrollCalls];
      globalThis.requestAnimationFrame = originalRaf;
      scrollTop = 0;
      scrollCalls.length = 0;
      rectCalls = 0;

      deferred = new EditorView(deferredPlace, {
        state: EditorState.create({ doc }),
        virtualizeTopLevel: { threshold: 500, overscanPx: 0 },
      });

      expect(rectCalls).toBeLessThanOrEqual(1);
      expect(deferred.dom.querySelectorAll('[data-pm-virtual="true"]').length).toBeGreaterThan(2900);

      await new Promise(resolve => requestAnimationFrame(resolve));

      expect(rectCalls).toBeGreaterThan(0);
      const referenceState = reference._virtualization;
      const deferredState = deferred._virtualization;
      expect(deferredState.range).toEqual(referenceState.range);
      expect(deferredState.topLevelDescs.map(desc => desc.virtual))
        .toEqual(referenceState.topLevelDescs.map(desc => desc.virtual));
      expect(deferredState.topLevelDescs.map(desc => desc.estimatedHeight))
        .toEqual(referenceState.topLevelDescs.map(desc => desc.estimatedHeight));
      expect(deferredState.topLevelDescs.map(desc => desc.dom.style.height))
        .toEqual(referenceState.topLevelDescs.map(desc => desc.dom.style.height));
      expect([...deferredState.calibration]).toEqual([...referenceState.calibration]);
      for (let index = 0; index < doc.childCount; index++) {
        const node = doc.child(index);
        expect(deferredState.heights.get(node)).toBe(referenceState.heights.get(node));
        expect(deferredState.estimates.get(node)).toBe(referenceState.estimates.get(node));
      }
      expect(scrollCalls).toEqual(referenceScrollCalls);
    }
    finally {
      globalThis.requestAnimationFrame = originalRaf;
      reference?.destroy();
      deferred?.destroy();
      referencePlace.remove();
      deferredPlace.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      window.scrollTo = originalScrollTo;
      if (scrollYDescriptor) Object.defineProperty(window, 'scrollY', scrollYDescriptor);
      else delete window.scrollY;
    }
  });

  it('builds a heavy Yjs mount through the virtualized path when the document arrives late', async () => {
    // The live shape: the editor mounts before the shared document arrives,
    // so the whole document lands in one y-tiptap transaction. That
    // transaction rebuilds every top-level block, and it must not build
    // them all for real: the off-screen blocks stay placeholders.
    const doc = makeDoc(3000);
    const ydoc = new Y.Doc();
    const yfrag = ydoc.getXmlFragment('content');
    // The fragment is empty when the editor mounts, so the editor starts
    // with an empty document.
    const { doc: emptyDoc, mapping } = initProseMirrorDoc(yfrag, schema);
    const undoManager = new Y.UndoManager(ydoc, { trackedOrigins: new Set([ySyncPluginKey]) });
    const state = EditorState.create({
      doc: emptyDoc,
      plugins: [ySyncPlugin(yfrag, { mapping }), yUndoPlugin({ undoManager })],
    });
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const view = new EditorView(place, {
      state,
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTop = 0;

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => 50 * view.dom.children.length,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = value; },
    });
    // Consistent geometry: every block is 50px tall.
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      const index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) return originalRect.call(this);
      const top = index * 50 - scrollTop;
      return { top, bottom: top + 50, left: 0, right: 800, width: 800, height: 50 };
    };

    try {
      // The shared document arrives: one transaction replaces the whole
      // document, which is the mount build.
      updateYFragment(ydoc, yfrag, doc, { mapping, isOMark: new Map() });
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => setTimeout(resolve, 50));

      const placeholders = view.dom.querySelectorAll('[data-pm-virtual="true"]').length;
      const descs = view._virtualization.topLevelDescs;
      const real = descs.filter(desc => desc && !desc.virtual).length;
      const virtual = descs.filter(desc => desc && desc.virtual).length;
      expect(view._virtualization.topLevelDescs.length).toBe(3000);
      expect(placeholders).toBeGreaterThan(2900);
      expect(virtual).toBeGreaterThan(2900);
      expect(real).toBeLessThan(60);
      expect(view.state.doc.childCount).toBe(3000);
    }
    finally {
      undoManager.destroy();
      view.destroy();
      place.remove();
      scroller.remove();
      ydoc.destroy();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  }, 60000);

  it('keeps a detached heavy mount virtualized when the scroll container is not height constrained', async () => {
    // The live shape: the editor element is detached while the view is
    // built (Tiptap moves it into the document on the next tick) and the
    // scroll container it ends up in is not height constrained, so its box
    // covers the whole document. The visible band is what the window shows,
    // not the box of the container: with the box as the band every block
    // looks visible and the activation materializes the whole document.
    const doc = makeDoc(3000);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    const originalRect = HTMLElement.prototype.getBoundingClientRect;

    const view = new EditorView(place, {
      state: EditorState.create({ doc }),
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });

    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 100000, left: 0, right: 800, width: 800, height: 100000 };
      }
      // A detached element has no rectangle.
      if (!this.isConnected) {
        return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      }
      if (this.classList?.contains('ProseMirror')) {
        return { top: 0, bottom: 100000, left: 0, right: 800, width: 800, height: 100000 };
      }
      const parent = this.parentNode;
      if (parent?.classList?.contains('ProseMirror')) {
        let top = 0;
        for (const sibling of parent.children) {
          const height = sibling.dataset.pmVirtual === 'true'
            ? Number.parseFloat(sibling.style.height) || 0
            : 50;
          if (sibling === this) {
            return { top, bottom: top + height, left: 0, right: 800, width: 800, height };
          }
          top += height;
        }
      }
      return originalRect.call(this);
    };

    try {
      // The editor reaches the document, the way Tiptap's EditorContent does.
      scroller.appendChild(place);
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));

      const placeholders = view.dom.querySelectorAll('[data-pm-virtual="true"]').length;
      const descs = view._virtualization.topLevelDescs;
      const real = descs.filter(desc => desc && !desc.virtual).length;
      expect(view._virtualization.activationPending).toBe(false);
      expect(placeholders).toBeGreaterThan(2900);
      expect(real).toBeLessThanOrEqual(40);
    }
    finally {
      view.destroy();
      place.remove();
      scroller.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  }, 60000);

  it('keeps the placeholders when a Yjs chunk replaces the tail of the document', async () => {
    // The live shape: the shared document arrives in chunks, and every chunk
    // replaces the document with fresh node objects. The reconciler can only
    // reuse the blocks whose content is unchanged; the blocks it rebuilds
    // stay detached until the DOM is rendered. A range measured over that
    // mix degenerates: a detached block has no rectangle, and the 0/0
    // rectangle looks like "inside the viewport" to the binary search, which
    // then reports the whole document as visible and materializes it.
    const doc = makeDoc(3000);
    const ydoc = new Y.Doc();
    const yfrag = ydoc.getXmlFragment('content');
    updateYFragment(ydoc, yfrag, doc, { mapping: new Map(), isOMark: new Map() });
    const { doc: boundDoc, mapping } = initProseMirrorDoc(yfrag, schema);
    const undoManager = new Y.UndoManager(ydoc, { trackedOrigins: new Set([ySyncPluginKey]) });
    const state = EditorState.create({
      doc: boundDoc,
      plugins: [ySyncPlugin(yfrag, { mapping }), yUndoPlugin({ undoManager })],
    });
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const view = new EditorView(place, {
      state,
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTop = 0;

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => 50 * view.dom.children.length,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = value; },
    });
    // Consistent geometry: every block is 50px tall.
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      const index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) return originalRect.call(this);
      const top = index * 50 - scrollTop;
      return { top, bottom: top + 50, left: 0, right: 800, width: 800, height: 50 };
    };

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const placeholdersBefore = view.dom.querySelectorAll('[data-pm-virtual="true"]').length;
      expect(placeholdersBefore).toBeGreaterThan(2900);

      // The chunk arrives: the tail of the document is new content, so those
      // blocks are rebuilt and the range is measured over a mix of attached
      // and detached blocks.
      const chunked = makeChunkedDoc(3000, 1490);
      updateYFragment(ydoc, yfrag, chunked, { mapping, isOMark: new Map() });
      await new Promise(resolve => requestAnimationFrame(resolve));

      const placeholders = view.dom.querySelectorAll('[data-pm-virtual="true"]').length;
      const descs = view._virtualization.topLevelDescs;
      const real = descs.filter(desc => desc && !desc.virtual).length;
      expect(view._virtualization.range.end).toBeLessThanOrEqual(100);
      expect(placeholders).toBeGreaterThan(2900);
      expect(real).toBeLessThanOrEqual(60);
      expect(view.dom.querySelectorAll('p').length).toBeLessThanOrEqual(60);
    }
    finally {
      undoManager.destroy();
      view.destroy();
      place.remove();
      scroller.remove();
      ydoc.destroy();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  }, 60000);

  it('keeps a large scroll materialization inside one frame budget', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const doc = schema.nodes.doc.create(null,
      Array.from({ length: 320 }, () => makeTable()));
    const ydoc = new Y.Doc();
    const yfrag = ydoc.getXmlFragment('content');
    updateYFragment(ydoc, yfrag, doc, { mapping: new Map(), isOMark: new Map() });
    const { doc: boundDoc, mapping } = initProseMirrorDoc(yfrag, schema);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: boundDoc,
        plugins: [ySyncPlugin(yfrag, { mapping })],
      }),
      virtualizeTopLevel: { threshold: 100, overscanPx: 200 },
    });
    let scrollTop = 0;
    let delayMaterialization = false;
    const delayedElements = new WeakSet();

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => 100 * view.dom.children.length,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = value; },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      const index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) return originalRect.call(this);
      if (delayMaterialization && this.dataset.pmVirtual !== 'true' && !delayedElements.has(this)) {
        delayedElements.add(this);
        const start = performance.now();
        while (performance.now() - start < 8) {}
      }
      const top = index * 100 - scrollTop;
      return { top, bottom: top + 100, left: 0, right: 800, width: 800, height: 100 };
    };

    try {
      await new Promise(resolve => originalRaf(resolve));
      expect(view._virtualization.activationPending).toBe(false);
      delayMaterialization = true;

      const frames = [];
      globalThis.requestAnimationFrame = callback => {
        frames.push(callback);
        return frames.length;
      };
      globalThis.cancelAnimationFrame = () => {};

      scrollTop = 28000;
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new window.Event('scroll'));
      expect(frames).toHaveLength(1);

      const visibleRange = __findVirtualRange(view, 0);
      const overscanRange = __findVirtualRange(view, 200);
      expect(overscanRange.end - overscanRange.start).toBeGreaterThan(3);

      const firstStart = performance.now();
      frames.shift()(firstStart);
      const firstElapsed = performance.now() - firstStart;
      const state = view._virtualization;
      const realInRange = () => state.topLevelDescs
        .slice(overscanRange.start, overscanRange.end)
        .filter(desc => desc && !desc.virtual).length;

      expect(firstElapsed).toBeLessThan(20);
      expect(realInRange()).toBeLessThan(overscanRange.end - overscanRange.start);
      expect(state.topLevelDescs[visibleRange.start].virtual).toBeFalsy();
      // The remaining overscan work continues without another scroll event.
      expect(frames).toHaveLength(1);

      let frameCount = 0;
      while (frames.length && frameCount++ < 20) {
        const start = performance.now();
        frames.shift()(start);
        expect(performance.now() - start).toBeLessThan(20);
      }
      expect(frameCount).toBeLessThan(20);
      expect(frames).toHaveLength(0);
      expect(realInRange()).toBe(overscanRange.end - overscanRange.start);
    }
    finally {
      view.destroy();
      place.remove();
      scroller.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
      ydoc.destroy();
    }
  });

  it('calibrates short table cells from their measured line count', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalStyle = window.getComputedStyle;
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '100px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const tableRows = 4;
    const tableColumns = 2;
    const cellHeight = 73.12;
    const tableHeight = cellHeight * tableRows;
    const trueHeight = tableHeight * 100;
    const makeShortTable = () => {
      const rows = [];
      for (let row = 0; row < tableRows; row++) {
        const cells = [];
        for (let column = 0; column < tableColumns; column++) {
          cells.push(schema.nodes.tableCell.create(null,
            schema.text(`r${row}c${column}`)));
        }
        rows.push(schema.nodes.tableRow.create(null, cells));
      }
      return schema.nodes.table.create(null, rows);
    };
    const doc = schema.nodes.doc.create(null,
      Array.from({ length: 100 }, () => makeShortTable()));
    const ydoc = new Y.Doc();
    const yfrag = ydoc.getXmlFragment('content');
    updateYFragment(ydoc, yfrag, doc, { mapping: new Map(), isOMark: new Map() });
    const { doc: boundDoc, mapping } = initProseMirrorDoc(yfrag, schema);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: boundDoc,
        plugins: [ySyncPlugin(yfrag, { mapping })],
      }),
      virtualizeTopLevel: { threshold: 10, overscanPx: 200 },
    });

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        let height = 0;
        for (const child of view.dom.children) {
          height += child.tagName == 'TABLE'
            ? tableHeight
            : Number.parseFloat(child.style.height) || 0;
        }
        return height;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 100, left: 0, right: 800, width: 800, height: 100 };
      }
      if (this === view.dom) {
        return { top: 0, bottom: 100, left: 0, right: 800, width: 800, height: 100 };
      }
      if (this.tagName == 'TD') {
        return { top: 0, bottom: cellHeight, left: 0, right: 20, width: 20, height: cellHeight };
      }
      if (this.tagName == 'TR') {
        return { top: 0, bottom: cellHeight, left: 0, right: 40, width: 40, height: cellHeight };
      }
      if (this.tagName == 'TABLE') {
        return { top: 0, bottom: tableHeight, left: 0, right: 40, width: 40, height: tableHeight };
      }
      return originalRect.call(this);
    };
    window.getComputedStyle = element => {
      const style = originalStyle.call(window, element);
      if (element.tagName != 'TD') return style;
      const overrides = {
        lineHeight: '25.56px',
        paddingTop: '10px',
        paddingBottom: '10px',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
      };
      return new Proxy(style, {
        get(target, property) {
          if (property in overrides) return overrides[property];
          const value = target[property];
          return typeof value == 'function' ? value.bind(target) : value;
        },
      });
    };

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const calibration = view._virtualization.calibration.get('table');
      expect(calibration).toBeTruthy();
      // Four characters wrap onto two measured lines, so the column holds two
      // characters per line even though the text is shorter than the old gate.
      expect(calibration.columnChars).toEqual([2, 2]);
      expect(Math.abs(scroller.scrollHeight - trueHeight) / trueHeight).toBeLessThan(0.03);
    }
    finally {
      view.destroy();
      place.remove();
      scroller.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      window.getComputedStyle = originalStyle;
      ydoc.destroy();
    }
  });

  it('falls back to the model range when the blocks are not all in the document', () => {
    // A direct degenerate input: the descs are a mix of attached and
    // detached blocks. The detached ones have no rectangle, so the binary
    // search would report the whole document as visible.
    const doc = makeDoc(3000);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.height = '300px';
    document.body.appendChild(scroller);
    const place = document.createElement('div');
    scroller.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({ doc }),
      virtualizeTopLevel: { threshold: 500, overscanPx: 800 },
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTop = 0;

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => 50 * view.dom.children.length,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = value; },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this === scroller) {
        return { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      }
      if (this === view.dom) {
        return { top: -scrollTop, bottom: 300 - scrollTop, left: 0, right: 800, width: 800, height: 300 };
      }
      const index = Array.prototype.indexOf.call(view.dom.children, this);
      if (index < 0) return originalRect.call(this);
      const top = index * 50 - scrollTop;
      return { top, bottom: top + 50, left: 0, right: 800, width: 800, height: 50 };
    };

    try {
      const descs = view._virtualization.topLevelDescs;
      expect(descs.length).toBe(3000);
      // The blocks the binary search probes are detached: they were rebuilt
      // but not rendered yet.
      for (const index of [1499, 2249, 2624, 2812, 2906, 2953, 2977, 2988, 2994, 2997, 2999]) {
        const desc = descs[index];
        expect(desc).toBeTruthy();
        desc.dom.remove();
      }

      const range = __findVirtualRange(view, 800);
      expect(range.start).toBe(0);
      expect(range.end).toBeLessThanOrEqual(100);
    }
    finally {
      view.destroy();
      place.remove();
      scroller.remove();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  }, 60000);
});
