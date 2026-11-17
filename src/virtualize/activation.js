import { DEFAULT_CONTENT_WIDTH } from './constants.js';
import { compensateVirtualHeight, dematerializeRealDescs, materializeVirtualDescs } from './materialize.js';
import { forkRuntime } from './runtime.js';
import { topLevelDescAtIndex, topLevelIndexAtPos, virtualOptions } from './state.js';
import {
    captureVirtualAnchor,
    findVirtualRange,
    hasUsableLayout,
    restoreVirtualAnchor,
    virtualRangeForBuild,
    virtualRangeForDescs,
    virtualScroller,
    virtualScrollHeight,
} from './viewport.js';
import { calibrateNodeHeight } from './heights.js';

export function destroyVirtualization(view) {
    let state = view._virtualization;
    if (!state)
        return;
    if (state.scrollRaf != null)
        cancelAnimationFrame(state.scrollRaf);
    if (state.activationRaf != null)
        cancelAnimationFrame(state.activationRaf);
    if (state.scrollTarget && state.scrollHandler)
        state.scrollTarget.removeEventListener('scroll', state.scrollHandler);
    view._virtualization = null;
}

function attachVirtualScroll(view, state) {
    let scroller = virtualScroller(view);
    state.scrollTarget = scroller.window || scroller.element;
    state.scrollHandler = () => {
        if (state.scrollRaf != null)
            return;
        state.scrollRaf = requestAnimationFrame(() => {
            state.scrollRaf = null;
            if (!view.isDestroyed)
                activateVirtualization(view);
        });
    };
    state.scrollTarget.addEventListener('scroll', state.scrollHandler, { passive: true });
}

export function ensureVirtualization(view) {
    let options = virtualOptions(view);
    if (!options || view.state.doc.childCount <= options.threshold) {
        destroyVirtualization(view);
        return null;
    }
    let state = view._virtualization, dematerialize = false;
    if (!state) {
        // The activation is deferred until the editor is in the document:
        // while the element is detached there is no layout to measure, and
        // the blocks outside the initial window have to be dematerialized
        // once the layout is there.
        let deferActivation = !view.docView || !view.dom.isConnected;
        state = view._virtualization = {
            options,
            heights: new WeakMap(),
            estimates: new WeakMap(),
            heightAdjustments: new WeakMap(),
            topLevelDescs: [],
            calibration: new Map(),
            width: view.dom.clientWidth || DEFAULT_CONTENT_WIDTH,
            range: null,
            activationPending: deferActivation,
            activationRaf: null,
            activationAttempts: 0,
            topLevelChanged: true,
        };
        state.range = virtualRangeForBuild(view, view.state.doc);
        state.docChildCount = view.state.doc.childCount;
        attachVirtualScroll(view, state);
        dematerialize = true;
        // The constructor schedules the activation once the view is built.
        // A state that appears later (the shared document arrives after the
        // editor is mounted) has to schedule it here.
        if (state.activationPending && view.docView)
            scheduleVirtualActivation(view);
    }
    else {
        let rangeChanged = state.docChildCount != view.state.doc.childCount ||
            state.options.overscanPx != options.overscanPx;
        state.options = options;
        if (rangeChanged) {
            state.docChildCount = view.state.doc.childCount;
            state.topLevelChanged = true;
        }
    }
    if (dematerialize && view.docView)
        dematerializeRealDescs(view, state, { keepSelection: true });
    return state;
}

export function materializeSelectionBlocks(view, force = false) {
    let state = ensureVirtualization(view);
    if (!state || state.activationPending && !force)
        return;
    let doc = view.state.doc, descs = [];
    let positions = view.state.selection.anchor == view.state.selection.head
        ? [view.state.selection.anchor]
        : [view.state.selection.anchor, view.state.selection.head];
    for (let pos of positions) {
        let index = topLevelIndexAtPos(doc, pos);
        let desc = topLevelDescAtIndex(view, index);
        if (desc && desc.virtual)
            descs.push(desc);
    }
    materializeVirtualDescs(view, descs);
}

export function materializeVisibleBlocks(view) {
    let state = ensureVirtualization(view);
    if (!state)
        return;
    if (hasUsableLayout(view)) {
        for (let pass = 0; pass < 20; pass++) {
            let range = findVirtualRange(view, state.options.overscanPx);
            state.range = range;
            let descs = [];
            for (let i = range.start; i < range.end; i++) {
                let desc = state.topLevelDescs[i];
                if (desc && desc.virtual)
                    descs.push(desc);
            }
            if (!descs.length || !materializeVirtualDescs(view, descs).length)
                break;
        }
    }
    // Blocks the user scrolled past must not stay materialized: every later
    // edit would have to tear them down and lay them out again. This also
    // runs without a layout: the range of the last pass is enough to know
    // which blocks are outside of it.
    dematerializeRealDescs(view, state, { keepSelection: true });
    state.topLevelChanged = false;
}

export function activateVirtualization(view) {
    let state = ensureVirtualization(view);
    if (!state)
        return;
    if (!state.activationPending) {
        materializeVisibleBlocks(view);
        return;
    }
    if (!view.dom.isConnected && ++state.activationAttempts <= 60) {
        // The editor element is still detached: there is no layout to
        // measure, so the activation waits for the element to reach the
        // document. Without the wait the blocks outside the range would
        // stay materialized for good.
        scheduleVirtualActivation(view);
        return;
    }
    state.activationPending = false;
    state.activationAttempts = 0;
    if (state.activationRaf != null) {
        cancelAnimationFrame(state.activationRaf);
        state.activationRaf = null;
    }
    let scrollHeightBefore = virtualScrollHeight(view);
    for (let desc of state.topLevelDescs)
        if (desc && !desc.virtual) calibrateNodeHeight(view, desc);
    let range = hasUsableLayout(view)
        ? findVirtualRange(view, state.options.overscanPx)
        : virtualRangeForDescs(view, state.topLevelDescs, state.options.overscanPx);
    state.range = range;
    materializeSelectionBlocks(view, true);
    materializeVisibleBlocks(view);
    let scrollHeightDelta = virtualScrollHeight(view) - scrollHeightBefore;
    if (scrollHeightDelta) {
        let anchor = captureVirtualAnchor(view);
        let descs = state.topLevelDescs.slice(state.range.start, state.range.end);
        compensateVirtualHeight(state, descs, scrollHeightDelta);
        restoreVirtualAnchor(view, anchor);
    }
    if (!view.isDestroyed && view.hasFocus())
        forkRuntime.selectionToDOM(view);
}

export function scheduleVirtualActivation(view) {
    let state = view._virtualization;
    if (!state || !state.activationPending || state.activationRaf != null)
        return;
    let raf = requestAnimationFrame(() => {
        state.activationRaf = null;
        if (view._virtualization !== state)
            return;
        activateVirtualization(view);
    });
    if (state.activationPending)
        state.activationRaf = raf;
}

export function initializeVirtualization(view) {
    view._virtualization = null;
    return ensureVirtualization(view);
}

export function prepareVirtualUpdate(view, prev, state) {
    let virtualState = ensureVirtualization(view);
    let selectionChanged = !state.selection.eq(prev.selection);
    let deferSelection = !!(virtualState && virtualState.activationPending && !selectionChanged);
    return { virtualState, selectionChanged, deferSelection };
}

export function materializeForSelection(view, update) {
    if (update.deferSelection)
        return;
    materializeSelectionBlocks(view, update.selectionChanged);
    let state = update.virtualState;
    if (state && state.topLevelChanged && !state.activationPending)
        materializeVisibleBlocks(view);
}
