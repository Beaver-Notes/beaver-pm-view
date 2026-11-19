import {
    applyVirtualMargins,
    calibrateNodeHeight,
    commitVirtualHeights,
    virtualHeight,
    virtualMargins,
} from './heights.js';
import { createVirtualDOM, restoreVirtualPlaceholder, virtualDOMState } from './placeholders.js';
import { createNodeDesc, createRealDescFromVirtual, createVirtualDesc } from './descs.js';
import { forkRuntime } from './runtime.js';
import { topLevelDescAtIndex, topLevelIndexAtPos, virtualOptions } from './state.js';
import { captureVirtualAnchor, restoreVirtualAnchor, virtualFlowHeight } from './viewport.js';
import { recordVirtual, timeVirtual } from './perf.js';

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
    return timeVirtual(view, 'dematerialize.total', () => dematerializeRealDescsInner(view, state, options));
}

function dematerializeRealDescsInner(view, state, options) {
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
    let planStart = performance.now();
    for (let { desc, docIndex } of stale) {
        // A layout read here would force the whole document to lay out again
        // mid-scroll. During a scroll frame the estimate is used instead; the
        // deferred measurement refines it when the block is materialized.
        if (!state.heights.has(desc.node) && !state.inScrollFrame) {
            let measured = desc.dom.getBoundingClientRect().height;
            if (measured > 0) state.heights.set(desc.node, measured);
        }
        let margins = virtualMargins(state, desc.node);
        if (!margins || state.heightAdjustments.get(desc.node)) neutral = false;
        let domState = virtualDOMState(desc.dom);
        plan.push({ desc, docIndex, margins, reusable: !!(domState && domState.reusable) });
    }
    recordVirtual(view, 'dematerialize.plan', performance.now() - planStart);
    let anchor = neutral ? null : (options && options.anchor !== undefined
        ? options.anchor
        : captureVirtualAnchor(view)), changed = 0;
    let observer = view.domObserver, restartObserver = observer && observer.running;
    if (restartObserver)
        observer.stop();
    try {
        let createStart = performance.now();
        for (let { desc, docIndex, margins, reusable } of plan) {
            let height = virtualHeight(view, desc.node);
            let dom = desc.dom, virtual;
            let childIndex = parent.children.indexOf(desc);
            desc.destroy();
            if (reusable) {
                while (dom.firstChild)
                    dom.removeChild(dom.firstChild);
                if (restoreVirtualPlaceholder(dom, height, margins))
                    virtual = createVirtualDesc(parent, desc.node, desc.outerDeco, desc.innerDeco,
                        dom, height, view);
            }
            if (!virtual)
                virtual = createVirtualDesc(parent, desc.node, desc.outerDeco, desc.innerDeco,
                    createVirtualDOM(height, margins), height, view);
            virtual.topLevelIndex = docIndex;
            if (childIndex >= 0) parent.children[childIndex] = virtual;
            state.topLevelDescs[docIndex] = virtual;
            changed++;
        }
        recordVirtual(view, 'dematerialize.createPlaceholders', performance.now() - createStart);
        let renderStart = performance.now();
        forkRuntime.renderDescs(parent.contentDOM, parent.children, view);
        recordVirtual(view, 'dematerialize.renderDescs', performance.now() - renderStart);
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
    let selectionStart = performance.now();
    restoreModelSelection(view);
    recordVirtual(view, 'dematerialize.restoreSelection', performance.now() - selectionStart);
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
        // During a scroll burst the target band is materialized in later
        // frames. Lowering one of those placeholders here would be undone
        // when the block turns real and drops its adjustment.
        let avoid = state.scrollCompensationRange;
        if (avoid && desc.topLevelIndex >= avoid.start && desc.topLevelIndex < avoid.end)
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
        let pending = state.pendingVirtualHeightWrites || (state.pendingVirtualHeightWrites = []);
        pending.push({ desc, height: nextHeight, margins: virtualMargins(state, desc.node) });
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
    return timeVirtual(view, 'materialize.total', () => materializeVirtualDescsInner(view, descs, options));
}

function materializeVirtualDescsInner(view, descs, options) {
    let state = forkRuntime.ensureVirtualization(view);
    if (!state || !descs.length)
        return [];
    let unique = descs.filter((desc, index) => desc && desc.virtual && desc.parent &&
        descs.indexOf(desc) == index);
    if (!unique.length)
        return [];

    // Read phase: resolve the model positions and the known height deltas
    // before any DOM mutation. Unknown heights are measured in the next frame.
    let plans = [], knownDelta = 0, exact = true;
    let precomputeStart = performance.now();
    for (let desc of unique) {
        let parent = desc.parent, index = parent.children.indexOf(desc);
        if (index < 0)
            continue;
        let pos = parent.posBeforeChild(desc);
        let docIndex = desc.topLevelIndex;
        if (docIndex == null)
            docIndex = topLevelIndexAtPos(view.state.doc, pos);
        let current = view.state.doc.child(docIndex);
        if (current)
            desc.node = current;
        let delta = virtualSwapDelta(state, desc);
        if (delta == null)
            exact = false;
        else
            knownDelta += delta;
        plans.push({
            desc, parent, index, pos, docIndex, delta,
            placeholderFlow: placeholderFlowHeight(desc.dom),
        });

    }
    recordVirtual(view, 'materialize.precompute', performance.now() - precomputeStart);
    if (!plans.length)
        return [];

    // The caller can hand in an anchor that was captured before it changed the
    // DOM: capturing it here would read the layout after the mutation and
    // force a second layout pass.
    // A dispatch captures one anchor before its first write. Reusing it here
    // avoids a layout read for every materialization pass after the DOM has
    // already changed, which would force another synchronous reflow.
    let anchor = exact && knownDelta == 0 ? null : (
        options && options.anchor !== undefined ? options.anchor
        : view._virtualDispatchAnchor !== undefined ? view._virtualDispatchAnchor
        : captureVirtualAnchor(view));
    let deferHeightCommit = !!(options && options.deferHeightCommit);
    let result = [], parent;
    let observer = view.domObserver, restartObserver = observer && observer.running;
    if (restartObserver)
        observer.stop();
    try {
        // Write phase: create and attach every real block without reading its
        // geometry. A geometry read here would force a layout after the write.
        let createStart = performance.now();
        let pendingMeasurements = state.pendingVirtualMeasurements || (state.pendingVirtualMeasurements = []);
        for (let plan of plans) {
            let desc = plan.desc;
            parent = plan.parent;
            let real = createRealDescFromVirtual(parent, desc);
            if (!real)
                real = createNodeDesc(parent, desc.node, desc.outerDeco, desc.innerDeco, view, plan.pos, { forceReal: true });
            if (!real || real.virtual)
                continue;
            real.topLevelIndex = plan.docIndex;
            state.topLevelDescs[plan.docIndex] = real;
            // The measured height replaces the estimate, so the compensation that
            // was applied while this block was virtual no longer applies to it.
            state.heightAdjustments.delete(real.node);
            if (real.contentDOM)
                real.updateChildren(view, plan.pos + 1);
            desc.destroy();
            parent.children[plan.index] = real;
            result.push(real);
            let knownHeight = state.heights.get(real.node);
            if (plan.delta != null) {
                if (knownHeight > 0)
                    real.estimatedHeight = knownHeight;
            }
            else {
                // The anchor model needs a height for each materialized block,
                // but an estimate is not a measurement. Keep it on estimatedHeight
                // only and queue a real read so the flow can be compensated.
                if (!(knownHeight > 0))
                    knownHeight = virtualHeight(view, real.node);
                let margins = virtualMargins(state, real.node);
                let appliedFlow = knownHeight > 0 ? virtualFlowHeight(knownHeight, margins) : 0;
                if (knownHeight > 0) {
                    real.estimatedHeight = knownHeight;
                    knownDelta += appliedFlow - plan.placeholderFlow;
                }
                pendingMeasurements.push({
                    desc: real, node: real.node,
                    placeholderFlow: plan.placeholderFlow, appliedFlow,
                });
            }
        }
        recordVirtual(view, 'materialize.createDescs', performance.now() - createStart);
        if (!result.length)
            return [];
        let renderStart = performance.now();
        forkRuntime.renderDescs(parent.contentDOM, parent.children, view);
        recordVirtual(view, 'materialize.renderDescs', performance.now() - renderStart);
        if (knownDelta)
            compensateVirtualHeight(state, result, knownDelta);
    }
    finally {
        if (restartObserver)
            observer.start();
    }

    // Direct (non-scroll) materialization measures in this frame: callers such
    // as calibration read the result immediately, with no rAF in between.
    // Scroll frames defer the read so it cannot force a synchronous relayout.
    if (!deferHeightCommit && !state.inScrollFrame && state.pendingVirtualMeasurements && state.pendingVirtualMeasurements.length)
        readPendingVirtualMeasurements(view);

    // Commit phase: flush every queued height write together, then restore
    // the anchor against the committed layout.
    if (!deferHeightCommit)
        commitVirtualHeights(view);
    if (anchor && !deferHeightCommit) {
        let anchorStart = performance.now();
        restoreVirtualAnchor(view, anchor);
        recordVirtual(view, 'materialize.restoreAnchor', performance.now() - anchorStart);
    }
    // Same rule as dematerialize: the swap may have rebuilt the DOM around
    // the caret, so re-derive the selection from the model.
    let selectionStart = performance.now();
    restoreModelSelection(view);
    recordVirtual(view, 'materialize.restoreSelection', performance.now() - selectionStart);
    if (state.pendingVirtualMeasurements && state.pendingVirtualMeasurements.length && !state.inScrollFrame)
        state.scheduleMeasurements();
    return result;
}

// Read phase for blocks materialized in the previous frame. The returned
// compensation is queued as a height write, so the caller can commit it with
// the rest of the frame after every geometry read is complete.
export function readPendingVirtualMeasurements(view, budgetMs = 8) {
    let state = view && view._virtualization;
    let pending = state && state.pendingVirtualMeasurements;
    if (!pending || !pending.length)
        return 0;
    // A dispatch may materialize in several passes. Measure once so the later
    // passes do not force another synchronous layout; their pending records
    // stay queued for the next rAF batch.
    if (view._virtualDispatchAnchor !== undefined) {
        if (view._virtualMeasurementsReadInDispatch)
            return 0;
        view._virtualMeasurementsReadInDispatch = true;
    }
    state.pendingVirtualMeasurements = [];
    let measured = [], retry = [], delta = 0;
    let readStart = performance.now();
    let deadline = readStart + budgetMs;
    for (let index = 0; index < pending.length; index++) {
        let record = pending[index];
        let desc = record.desc;
        if (!desc || desc.virtual || !desc.parent || !desc.dom || !desc.dom.parentNode ||
            state.topLevelDescs[desc.topLevelIndex] !== desc)
            continue;
        // A complex block can take milliseconds to measure. Leave the rest
        // queued rather than turning the whole batch into one long frame.
        if (measured.length && performance.now() >= deadline) {
            retry.push(...pending.slice(index));
            break;
        }
        let height = desc.dom.getBoundingClientRect().height;
        if (!(height > 0)) {
            retry.push(record);
            continue;
        }
        state.heights.set(desc.node, height);
        desc.estimatedHeight = height;
        let margins = virtualMargins(state, desc.node);
        // If an estimate was already compensated at materialization time, only
        // compensate the difference the real measurement makes to it.
        let applied = record.appliedFlow > 0 ? record.appliedFlow : record.placeholderFlow;
        delta += virtualFlowHeight(height, margins) - applied;
        measured.push(desc);
        calibrateNodeHeight(view, desc);
    }
    recordVirtual(view, 'materialize.heightRead', performance.now() - readStart);
    if (retry.length)
        state.pendingVirtualMeasurements = retry;
    if (measured.length && delta)
        compensateVirtualHeight(state, measured, delta);
    return measured.length;
}
