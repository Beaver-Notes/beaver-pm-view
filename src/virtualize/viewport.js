import { virtualHeight, virtualMargins } from './heights.js';

export function virtualScroller(view) {
    for (let element = view.dom; element && element.nodeType == 1; element = element.parentElement) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY))
            return { element };
    }
    return { window: view.root.defaultView || window };
}

export function virtualViewport(view) {
    let scroller = virtualScroller(view);
    if (scroller.element) {
        let rect = scroller.element.getBoundingClientRect();
        let window = view.root.defaultView || globalThis.window;
        // The scroll container's box is not the viewport. A container that is
        // not height constrained reports the height of its content, which
        // would put the whole document into the visible band and materialize
        // every block. Only the part of the container the window shows is
        // visible.
        let top = Math.max(rect.top, 0);
        let bottom = Math.min(rect.bottom, window.innerHeight || rect.bottom);
        if (bottom <= top) {
            top = rect.top;
            bottom = rect.bottom;
        }
        return { top, bottom, scroller };
    }
    return { top: 0, bottom: scroller.window.innerHeight, scroller };
}

export function virtualRangeForDescs(view, descs, overscan) {
    let viewport = virtualViewport(view);
    let editorRect = view.dom.getBoundingClientRect();
    let visibleTop = viewport.top - editorRect.top - overscan;
    let visibleBottom = viewport.bottom - editorRect.top + overscan;
    let offset = 0, start = descs.length, end = 0;
    for (let index = 0; index < descs.length; index++) {
        let desc = descs[index];
        let box = desc.estimatedHeight;
        if (!(box > 0)) box = virtualHeight(view, desc.node);
        let height = virtualFlowHeightFor(view, desc.node, box);
        if (offset < visibleBottom && offset + height > visibleTop) {
            start = Math.min(start, index);
            end = Math.max(end, index + 1);
        }
        offset += height;
    }
    return { start, end };
}

export function virtualRangeForBuild(view, doc) {
    let state = view._virtualization;
    let viewport = virtualViewport(view);
    let editorRect = view.dom.getBoundingClientRect();
    let overscan = state.options.overscanPx;
    // While the view is constructed the editor element is still detached
    // (Tiptap moves it into the document on the next tick), so it has no
    // rectangle to measure against. The initial window is a model
    // assumption then: the document starts at the top of the viewport.
    let laidOut = editorRect.height > 0 || view.dom.offsetHeight > 0;
    let visibleTop = laidOut ? viewport.top - editorRect.top - overscan : -overscan;
    let visibleBottom = laidOut ? viewport.bottom - editorRect.top + overscan : viewport.bottom + overscan;
    let offset = 0, start = doc.childCount, end = 0;
    for (let i = 0; i < doc.childCount; i++) {
        let height = virtualFlowHeightFor(view, doc.child(i));
        if (offset < visibleBottom && offset + height > visibleTop) {
            start = Math.min(start, i);
            end = Math.max(end, i + 1);
        }
        offset += height;
    }
    return { start, end };
}

export function hasUsableLayout(view) {
    return view.dom.getBoundingClientRect().height > 0 || view.dom.offsetHeight > 0;
}

// The binary search assumes that the rectangles grow with the index. A
// block that is not in the document has no rectangle, and a placeholder
// without a height has none either: both look like "inside the viewport"
// to the search, which would report the whole document as visible.
function virtualRangeRectUsable(desc, rect) {
    if (!desc || !desc.dom || !desc.dom.parentNode)
        return false;
    if (desc.virtual && !(rect.height > 0))
        return false;
    return true;
}

export function findVirtualRange(view, overscan) {
    let children = view._virtualization && view._virtualization.topLevelDescs;
    if (!children || !children.length)
        return { start: 0, end: 0 };
    let viewport = virtualViewport(view);
    let top = viewport.top - overscan, bottom = viewport.bottom + overscan;
    let low = 0, high = children.length - 1, start = children.length;
    while (low <= high) {
        let middle = (low + high) >> 1;
        let desc = children[middle], rect = desc.dom.getBoundingClientRect();
        if (!virtualRangeRectUsable(desc, rect))
            return virtualRangeForDescs(view, children, overscan);
        if (rect.bottom < top)
            low = middle + 1;
        else {
            start = middle;
            high = middle - 1;
        }
    }
    if (start == children.length)
        return { start, end: start };
    low = start;
    high = children.length - 1;
    let end = start - 1;
    while (low <= high) {
        let middle = (low + high) >> 1;
        let desc = children[middle], rect = desc.dom.getBoundingClientRect();
        if (!virtualRangeRectUsable(desc, rect))
            return virtualRangeForDescs(view, children, overscan);
        if (rect.top > bottom)
            high = middle - 1;
        else {
            end = middle;
            low = middle + 1;
        }
    }
    return { start, end: end + 1 };
}

export function captureVirtualAnchor(view) {
    let range = findVirtualRange(view, 0), descs = view._virtualization.topLevelDescs;
    if (range.start >= descs.length)
        return null;
    let desc = descs[range.start];
    // A block that is not in the document has no position: anchoring to it
    // would move the scroll position once the block is materialized.
    if (!desc || !desc.dom || !desc.dom.parentNode)
        return null;
    return {
        index: range.start,
        node: desc.node,
        top: desc.dom.getBoundingClientRect().top,
        scroller: virtualScroller(view),
    };
}

export function restoreVirtualAnchor(view, anchor) {
    if (!anchor)
        return;
    let descs = view._virtualization.topLevelDescs;
    let desc = descs[anchor.index];
    // A structural edit can move the anchor to another index, so the block
    // that was captured is looked up by its node.
    if (!desc || anchor.node && desc.node !== anchor.node) {
        desc = anchor.node ? descs.find(candidate => candidate && candidate.node === anchor.node) : null;
        if (!desc)
            return;
    }
    let delta = desc.dom.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < .01)
        return;
    if (anchor.scroller.element)
        anchor.scroller.element.scrollTop += delta;
    else
        anchor.scroller.window.scrollTo(anchor.scroller.window.scrollX, anchor.scroller.window.scrollY + delta);
}

export function virtualScrollHeight(view) {
    let scroller = virtualScroller(view);
    return scroller.element
        ? scroller.element.scrollHeight
        : scroller.window.document.documentElement.scrollHeight;
}

export function virtualFlowHeight(boxHeight, margins) {
    let top = margins ? margins.top || 0 : 0, bottom = margins ? margins.bottom || 0 : 0;
    return boxHeight + Math.max(top, bottom);
}

// The space a block takes in the flow: its border box plus the margins it
// carries. The range math needs the flow height, the placeholder style needs
// the border box.
export function virtualFlowHeightFor(view, node, boxHeight) {
    let state = view._virtualization;
    let box = boxHeight != null ? boxHeight : virtualHeight(view, node);
    return virtualFlowHeight(box, virtualMargins(state, node));
}
