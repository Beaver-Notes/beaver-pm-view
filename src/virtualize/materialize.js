import {
    applyVirtualMargins,
    calibrateNodeHeight,
    virtualHeight,
    virtualMargins,
} from './heights.js';
import { createVirtualDOM } from './placeholders.js';
import { createNodeDesc, createVirtualDesc } from './descs.js';
import { forkRuntime } from './runtime.js';
import { topLevelDescAtIndex, topLevelIndexAtPos, virtualOptions } from './state.js';
import { captureVirtualAnchor, restoreVirtualAnchor, virtualFlowHeight } from './viewport.js';

function selectionTopLevelIndexes(view) {
    let doc = view.state.doc, selection = view.state.selection, indexes = new Set;
    let positions = selection.anchor == selection.head
        ? [selection.anchor]
        : [selection.anchor, selection.head];
    for (let pos of positions) {
        let index = topLevelIndexAtPos(doc, pos);
        if (index >= 0)
            indexes.add(index);
    }
    return indexes;
}

function staleRealDescs(view, state, options) {
    let parent = view.docView;
    if (!parent || !parent.children || !state.range)
        return [];
    let keepSelection = options && options.keepSelection ? selectionTopLevelIndexes(view) : null;
    let stale = [];
    for (let index = 0; index < state.topLevelDescs.length; index++) {
        let desc = state.topLevelDescs[index];
        if (!desc || !desc.node || desc.virtual || desc.parent != parent)
            continue;
        let docIndex = desc.topLevelIndex;
        if (docIndex == null)
            docIndex = index;
        if (docIndex >= state.range.start && docIndex < state.range.end)
            continue;
        if (keepSelection && keepSelection.has(docIndex))
            continue;
        stale.push({ desc, docIndex });
    }
    return stale;
}

export function hasStaleRealDescs(view, state, options) {
    return staleRealDescs(view, state, options).length > 0;
}

// Re-derive the DOM selection from the model after a swap rebuilt the DOM.
// selectionToDOM writes through Selection.collapse, which some environments
// (happy-dom) silently no-op; verify the write and fall back to a plain
// range set, which leaves real browsers (where collapse works) untouched.
function restoreModelSelection(view) {
    forkRuntime.selectionToDOM(view);
    if (view.isDestroyed) return;
    let sel = view.state.selection;
    let anchorDOM = view.docView.domFromPos(sel.anchor, sel.anchor ? -1 : 1);
    let headDOM = sel.head == sel.anchor ? anchorDOM : view.docView.domFromPos(sel.head, sel.head ? -1 : 1);
    let domSel = view.domSelectionRange();
    if (!domSel ||
        (domSel.anchorNode === anchorDOM.node && domSel.anchorOffset === anchorDOM.offset &&
         domSel.focusNode === headDOM.node && domSel.focusOffset === headDOM.offset))
        return;
    let range = view.dom.ownerDocument.createRange();
    let from = anchorDOM, to = headDOM;
    if (sel.anchor > sel.head) { from = headDOM; to = anchorDOM; }
    range.setEnd(to.node, to.offset);
    range.setStart(from.node, from.offset);
    domSel.removeAllRanges();
    domSel.addRange(range);
}

export function dematerializeRealDescs(view, state, options) {
    // A direct caller can hand in a state from a doc that no longer
    // qualifies: never swap on a document below the threshold.
    let config = virtualOptions(view);
    if (!config || view.state.doc.childCount <= config.threshold)
        return 0;
    let parent = view.docView;
    if (!parent || !parent.children || !state.range)
        return 0;
    let stale = staleRealDescs(view, state, options);
    if (!stale.length)
        return 0;
    // Plan the swap before touching the DOM: a measured block turns into a
    // placeholder with the same border box and the same margins, so the flow
    // height does not change and no anchor correction is needed. Reading the
    // geometry after the swap would force a layout, which is what makes
    // structural edits expensive.
    let plan = [], neutral = true;
    for (let { desc, docIndex } of stale) {
        if (!state.heights.has(desc.node)) {
            let measured = desc.dom.getBoundingClientRect().height;
            if (measured > 0) state.heights.set(desc.node, measured);
        }
        let margins = virtualMargins(state, desc.node);
        if (!margins || state.heightAdjustments.get(desc.node)) neutral = false;
        plan.push({ desc, docIndex, margins });
    }
    let anchor = neutral ? null : (options && options.anchor !== undefined
        ? options.anchor
        : captureVirtualAnchor(view)), changed = 0;
    for (let { desc, docIndex, margins } of plan) {
        let height = virtualHeight(view, desc.node);
        let virtual = createVirtualDesc(parent, desc.node, desc.outerDeco, desc.innerDeco,
            createVirtualDOM(height, margins), height, view);
        virtual.topLevelIndex = docIndex;
        let childIndex = parent.children.indexOf(desc);
        desc.destroy();
        if (childIndex >= 0) parent.children[childIndex] = virtual;
        state.topLevelDescs[docIndex] = virtual;
        changed++;
    }
    let observer = view.domObserver, restartObserver = observer && observer.running;
    if (restartObserver)
        observer.stop();
    try {
        forkRuntime.renderDescs(parent.contentDOM, parent.children, view);
    }
    finally {
        if (restartObserver)
            observer.start();
    }
    if (anchor)
        restoreVirtualAnchor(view, anchor);
    // The swap rebuilt the DOM around blocks that may have held the caret;
    // re-derive it from the model instead of leaving a stale DOM selection.
    forkRuntime.selectionToDOM(view);
    restoreModelSelection(view);
    return changed;
}

export function compensateVirtualHeight(state, result, delta) {
    if (!delta || !result.length)
        return;
    let first = Infinity, last = -1;
    for (let desc of result) {
        let index = desc.topLevelIndex;
        if (index == null)
            continue;
        first = Math.min(first, index);
        last = Math.max(last, index);
    }
    if (first == Infinity)
        return;
    let adjust = desc => {
        if (!desc || !desc.virtual || !desc.node)
            return;
        let height = desc.estimatedHeight, nextHeight;
        if (delta > 0) {
            let reduction = Math.min(height, delta);
            nextHeight = height - reduction;
            delta -= reduction;
        }
        else {
            nextHeight = height - delta;
            delta = 0;
        }
        let change = nextHeight - height;
        if (!change)
            return;
        let adjustment = (state.heightAdjustments.get(desc.node) || 0) + change;
        state.heightAdjustments.set(desc.node, adjustment);
        desc.estimatedHeight = nextHeight;
        desc.dom.style.height = nextHeight + 'px';
    };
    for (let index = last + 1; index < state.topLevelDescs.length && delta; index++)
        adjust(state.topLevelDescs[index]);
    for (let index = first - 1; index >= 0 && delta; index--)
        adjust(state.topLevelDescs[index]);
}

// The flow height of a block that turns from a placeholder into a real block
// changes unless the placeholder already occupied the same space. The cached
// heights answer that without reading the scroll height back, which would
// force a layout after the DOM was already changed.
function virtualSwapDelta(state, desc) {
    let node = desc.node;
    if (!node)
        return null;
    let height = state.heights.get(node);
    if (!(height > 0))
        return null;
    let margins = virtualMargins(state, node);
    let realTop = margins ? margins.top : 0, realBottom = margins ? margins.bottom : 0;
    let placeholderTop = Number.parseFloat(desc.dom.style.marginTop) || 0;
    let placeholderBottom = Number.parseFloat(desc.dom.style.marginBottom) || 0;
    if (placeholderTop != realTop || placeholderBottom != realBottom)
        return null;
    let placeholderHeight = Number.parseFloat(desc.dom.style.height) || 0;
    return height - placeholderHeight;
}

function placeholderFlowHeight(dom) {
    let boxHeight = Number.parseFloat(dom.style.height) || 0;
    let top = Number.parseFloat(dom.style.marginTop) || 0;
    let bottom = Number.parseFloat(dom.style.marginBottom) || 0;
    return boxHeight + Math.max(top, bottom);
}

export function materializeVirtualDescs(view, descs, options) {
    let state = forkRuntime.ensureVirtualization(view);
    if (!state || !descs.length)
        return [];
    let unique = descs.filter((desc, index) => desc && desc.virtual && desc.parent &&
        descs.indexOf(desc) == index);
    if (!unique.length)
        return [];
    let modelDelta = 0, exact = true;
    let placeholderFlows = new Map;
    for (let desc of unique) {
        let delta = virtualSwapDelta(state, desc);
        if (delta == null) {
            exact = false;
            break;
        }
        modelDelta += delta;
    }
    for (let desc of unique)
        placeholderFlows.set(desc, placeholderFlowHeight(desc.dom));
    let neutral = exact && modelDelta == 0;
    // The caller can hand in an anchor that was captured before it changed the
    // DOM: capturing it here would read the layout after the mutation and
    // force a second layout pass.
    let anchor = neutral ? null : (options && options.anchor !== undefined
        ? options.anchor
        : captureVirtualAnchor(view));
    let result = [], resultFlows = [], parent;
    for (let desc of unique) {
        parent = desc.parent;
        let index = parent.children.indexOf(desc);
        if (index < 0)
            continue;
        let pos = parent.posBeforeChild(desc);
        let docIndex = desc.topLevelIndex;
        if (docIndex == null)
            docIndex = topLevelIndexAtPos(view.state.doc, pos);
        let current = view.state.doc.child(docIndex);
        if (current)
            desc.node = current;
        let real = createNodeDesc(parent, desc.node, desc.outerDeco, desc.innerDeco, view, pos, { forceReal: true });
        if (!real || real.virtual)
            continue;
        real.topLevelIndex = docIndex;
        state.topLevelDescs[docIndex] = real;
        // The measured height replaces the estimate, so the compensation that
        // was applied while this block was virtual no longer applies to it.
        state.heightAdjustments.delete(real.node);
        if (real.contentDOM)
            real.updateChildren(view, pos + 1);
        desc.destroy();
        parent.children[index] = real;
        result.push(real);
        // The space the placeholder took is remembered for the compensation.
        resultFlows.push(placeholderFlows.get(desc) || 0);
    }
    if (!result.length)
        return [];
    let observer = view.domObserver, restartObserver = observer && observer.running;
    if (restartObserver)
        observer.stop();
    let delta = 0;
    try {
        forkRuntime.renderDescs(parent.contentDOM, parent.children, view);
        for (let index = 0; index < result.length; index++) {
            let desc = result[index];
            let height = state.heights.get(desc.node);
            if (!(height > 0)) {
                // Only blocks that were never measured need a layout read.
                height = desc.dom.getBoundingClientRect().height;
                if (height > 0) state.heights.set(desc.node, height);
            }
            if (height > 0) desc.estimatedHeight = height;
            calibrateNodeHeight(view, desc);
            if (!exact && height > 0) {
                // The measured block replaces the estimate: the difference is
                // the space the swap took or gave back. Without a measurement
                // the swap size is unknown and nothing is compensated.
                let margins = virtualMargins(state, desc.node);
                delta += virtualFlowHeight(height, margins) - resultFlows[index];
            }
        }
        if (exact)
            delta = modelDelta;
    }
    finally {
        if (restartObserver)
            observer.start();
    }
    // The anchor is restored before the compensation writes: the restore
    // reads the layout, and a style write would force another layout pass.
    if (anchor) restoreVirtualAnchor(view, anchor);
    // Same rule as dematerialize: the swap may have rebuilt the DOM around
    // the caret, so re-derive the selection from the model.
    restoreModelSelection(view);
    // The compensation keeps the document height stable, so the scroll
    // position does not have to be read back from the DOM.
    if (delta)
        compensateVirtualHeight(state, result, delta);
    return result;
}
