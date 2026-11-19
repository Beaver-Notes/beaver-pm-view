import { DEFAULT_CONTENT_WIDTH, SCROLL_BATCH_SIZE, SCROLL_MATERIALIZATION_BUDGET_MS, SCROLL_MATERIALIZATION_MAX_PER_FRAME } from './constants.js';
import {
    compensateVirtualHeight,
    dematerializeRealDescs,
    hasStaleRealDescs,
    materializeVirtualDescs,
    readPendingVirtualMeasurements,
} from './materialize.js';
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
import { calibrateNodeHeight, commitVirtualHeights } from './heights.js';
import { timeVirtual } from './perf.js';

export function destroyVirtualization(view) {
    let state = view._virtualization;
    if (!state)
        return;
    if (state.scrollRaf != null)
        cancelAnimationFrame(state.scrollRaf);
    if (state.measureRaf != null)
        cancelAnimationFrame(state.measureRaf);
    state.scrollToken = null;
    if (state.activationRaf != null)
        cancelAnimationFrame(state.activationRaf);
    if (state.scrollTarget && state.scrollHandler)
        state.scrollTarget.removeEventListener('scroll', state.scrollHandler);
    view._virtualization = null;
}

function attachVirtualScroll(view, state) {
    let scroller = virtualScroller(view);
    state.scrollTarget = scroller.window || scroller.element;
    state.scrollHandler = () => scheduleVirtualScroll(view);
    state.scrollTarget.addEventListener('scroll', state.scrollHandler, { passive: true });
}

function scheduleVirtualScroll(view, continuation = false) {
    let state = view._virtualization;
    if (!state || state.scrollRaf != null)
        return;
    // A new scroll burst means the viewport moved: the cached range from the
    // previous burst no longer describes what the user can see. Continuation
    // frames finish work inside the same burst and keep the measured range.
    if (!continuation)
        state.scrollRange = null;
    let token = state.scrollToken = {};
    let raf = requestAnimationFrame(() => {
        if (state.scrollToken !== token)
            return;
        state.scrollToken = null;
        state.scrollRaf = null;
        if (view.isDestroyed || view._virtualization !== state)
            return;
        state.inScrollFrame = true;
        let again = false;
        try {
            again = materializeVisibleBlocksForScroll(view);
        }
        finally {
            state.inScrollFrame = false;
        }
        // Scroll frames defer their height reads. Flush them in a later frame
        // so the model converges on the real layout after a scroll burst.
        if (state.pendingVirtualMeasurements && state.pendingVirtualMeasurements.length)
            state.scheduleMeasurements();
        if (again)
            scheduleVirtualScroll(view, true);
    });
    // A synchronous requestAnimationFrame implementation runs the callback
    // before it returns the id.
    if (state.scrollToken === token)
        state.scrollRaf = raf;
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
            pendingVirtualHeightWrites: [],
            pendingVirtualMeasurements: [],
            topLevelDescs: [],
            calibration: new Map(),
            tableRowSamples: [],
            width: view.dom.clientWidth || DEFAULT_CONTENT_WIDTH,
            range: null,
            activationPending: deferActivation,
            activationRaf: null,
            activationAttempts: 0,
            scrollRaf: null,
            scrollToken: null,
            measureRaf: null,
            measureAttempts: 0,
            scrollCleanupPending: false,
            topLevelChanged: true,
        };
        state.range = virtualRangeForBuild(view, view.state.doc);
        state.docChildCount = view.state.doc.childCount;
        // A block that was materialized inside a scroll frame is measured in
        // a later frame: a layout read right after those DOM writes would
        // force a synchronous relayout of the whole document.
        state.scheduleMeasurements = function () {
            if (state.measureRaf != null || view.isDestroyed)
                return;
            state.measureRaf = requestAnimationFrame(() => {
                state.measureRaf = null;
                if (view.isDestroyed || view._virtualization !== state)
                    return;
                // Compensation must not lower placeholders that are about to
                // turn real: that adjustment is dropped on materialization.
                let restoreRange = state.scrollCompensationRange;
                state.scrollCompensationRange = state.scrollRange && state.scrollRange.target;
                try {
                    readPendingVirtualMeasurements(view);
                    commitVirtualHeights(view);
                }
                finally {
                    state.scrollCompensationRange = restoreRange;
                }
                if (state.pendingVirtualMeasurements.length) {
                    // A block that still has no box (detached, not yet laid
                    // out) is retried a few times, then dropped.
                    state.measureAttempts++;
                    if (state.measureAttempts < 8)
                        state.scheduleMeasurements();
                    else
                        state.pendingVirtualMeasurements = [];
                }
                else
                    state.measureAttempts = 0;
            });
        };
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

export function materializeSelectionBlocks(view, force = false, options) {
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
    materializeVirtualDescs(view, descs, options);
}

function materializeVisibleBlocksForScroll(view) {
    return timeVirtual(view, 'scroll.total', () => materializeVisibleBlocksForScrollInner(view));
}

function materializeVisibleBlocksForScrollInner(view) {
    let state = ensureVirtualization(view);
    if (!state || state.activationPending || !hasUsableLayout(view))
        return false;
    // Measuring the range costs a layout read per binary-search step. Within
    // one scroll burst the viewport is fixed, so the first frame's range is
    // reused by the continuation frames instead of re-reading every block.
    let visibleRange = state.scrollRange && state.scrollRange.visible;
    let targetRange = state.scrollRange && state.scrollRange.target;
    if (!visibleRange || !targetRange) {
        visibleRange = timeVirtual(view, 'scroll.findVisibleRange', () => findVirtualRange(view, 0));
        targetRange = timeVirtual(view, 'scroll.findTargetRange', () => findVirtualRange(view, state.options.overscanPx));
        state.scrollRange = { visible: visibleRange, target: targetRange };
    }
    if (!targetRange || targetRange.end <= targetRange.start)
        return false;

    let anchor = !view.composing ? captureVirtualAnchor(view, visibleRange) : null;
    try {
        return materializeVisibleBlocksForScrollBatch(view, state, visibleRange, targetRange, anchor);
    }
    finally {
        commitVirtualHeights(view);
        if (anchor)
            restoreVirtualAnchor(view, anchor);
    }
}

function materializeVisibleBlocksForScrollBatch(view, state, visibleRange, targetRange, anchor) {
    // Cleanup runs at the start of the next frame: the height writes that
    // compensated this frame's materialization must be committed before the
    // stale blocks turn back into placeholders.
    if (state.scrollCleanupPending) {
        dematerializeRealDescs(view, state, { keepSelection: true });
        state.scrollCleanupPending = false;
    }
    let hasPending = range => {
        for (let index = range.start; index < range.end; index++) {
            let desc = state.topLevelDescs[index];
            if (desc && desc.virtual)
                return true;
        }
        return false;
    };
    let pending = hasPending(targetRange);
    if (!pending)
        return false;

    let candidates = [], seen = new Set;
    let addIndex = index => {
        let desc = state.topLevelDescs[index];
        if (!desc || !desc.virtual || seen.has(index))
            return;
        seen.add(index);
        candidates.push(desc);
    };
    // The visible slice comes first. Overscan blocks are only useful after
    // the blocks the user can see are real. They then grow outwards from the
    // visible slice, so the materialized range stays contiguous.
    for (let index = visibleRange.start; index < visibleRange.end; index++)
        addIndex(index);
    for (let index = visibleRange.start - 1; index >= targetRange.start; index--)
        addIndex(index);
    for (let index = visibleRange.end; index < targetRange.end; index++)
        addIndex(index);

    let start = performance.now();
    let deadline = start + SCROLL_MATERIALIZATION_BUDGET_MS;
    let materialized = 0;
    // One call per small group: the read, write and commit phases amortize
    // over the group, so the per-desc planning cost stays out of the budget.
    for (let offset = 0; offset < candidates.length && materialized < SCROLL_MATERIALIZATION_MAX_PER_FRAME;) {
        if (materialized && performance.now() >= deadline)
            break;
        let group = candidates.slice(offset, offset + Math.min(SCROLL_BATCH_SIZE, SCROLL_MATERIALIZATION_MAX_PER_FRAME - materialized));
        offset += group.length;
        let done = timeVirtual(view, 'scroll.materializeCall',
            () => materializeVirtualDescs(view, group, { anchor, deferHeightCommit: true })).length;
        materialized += done;
    }

    // The range describes the blocks that are real now. A pending overscan
    // block must not make a structural edit materialize the whole target in
    // one transaction.
    let rangeStart = -1, rangeEnd = -1;
    for (let index = targetRange.start; index < targetRange.end; index++) {
        let desc = state.topLevelDescs[index];
        if (!desc || desc.virtual)
            continue;
        if (rangeStart < 0) rangeStart = index;
        rangeEnd = index + 1;
    }
    if (rangeStart >= 0)
        state.range = { start: rangeStart, end: rangeEnd };
    state.topLevelChanged = false;

    // Scan for stale blocks after the range update: the old range makes
    // blocks we just scrolled past look fresh and they would never be torn
    // down. Dematerialization is deferred to the next frame so it cannot
    // disturb the height writes committed for the blocks just materialized.
    state.scrollCleanupPending = timeVirtual(view, 'scroll.staleScan',
        () => hasStaleRealDescs(view, state, { keepSelection: true }));

    pending = hasPending(targetRange);
    return (pending && materialized > 0) || state.scrollCleanupPending;
}

export function materializeVisibleBlocks(view, options) {
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
            if (!descs.length || !materializeVirtualDescs(view, descs, options).length)
                break;
        }
    }
    // Blocks the user scrolled past must not stay materialized: every later
    // edit would have to tear them down and lay them out again. This also
    // runs without a layout: the range of the last pass is enough to know
    // which blocks are outside of it.
    dematerializeRealDescs(view, state, { keepSelection: true, anchor: options && options.anchor });
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
    let usableLayout = hasUsableLayout(view);
    let range = usableLayout
        ? findVirtualRange(view, state.options.overscanPx)
        : virtualRangeForDescs(view, state.topLevelDescs, state.options.overscanPx);
    state.range = range;
    let anchor = !view.composing && usableLayout ? captureVirtualAnchor(view) : null;
    for (let desc of state.topLevelDescs)
        if (desc && !desc.virtual) calibrateNodeHeight(view, desc);
    commitVirtualHeights(view);
    if (anchor)
        restoreVirtualAnchor(view, anchor);
    let scrollHeightBefore = virtualScrollHeight(view);
    try {
        materializeSelectionBlocks(view, true, { anchor });
        materializeVisibleBlocks(view, { anchor });
    }
    finally {
        commitVirtualHeights(view);
        if (anchor)
            restoreVirtualAnchor(view, anchor);
    }
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
    // One anchor per dispatch: the read happens before any DOM write of this
    // transaction, and the single restore at its end keeps the scroll position
    // without a second forced layout.
    let anchor = virtualState && !view.composing && hasUsableLayout(view)
        ? captureVirtualAnchor(view)
        : null;
    // The reconciler runs inside the same dispatch and reuses this anchor.
    view._virtualDispatchAnchor = anchor;
    view._virtualAnchorRestored = false;
    view._virtualMeasurementsReadInDispatch = false;
    return { virtualState, selectionChanged, deferSelection, anchor };
}

export function materializeForSelection(view, update) {
    if (update.deferSelection)
        return;
    let anchor = update.anchor;
    try {
        materializeSelectionBlocks(view, update.selectionChanged, { anchor });
        let state = update.virtualState;
        if (state && state.topLevelChanged && !state.activationPending)
            materializeVisibleBlocks(view, { anchor });
    }
    finally {
        commitVirtualHeights(view);
        if (anchor)
            restoreVirtualAnchor(view, anchor);
        view._virtualDispatchAnchor = undefined;
        view._virtualAnchorRestored = false;
        view._virtualMeasurementsReadInDispatch = false;
    }
}
