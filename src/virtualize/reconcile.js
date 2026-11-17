import { MAX_FAST_PATH_BLOCKS } from './constants.js';
import {
    applyVirtualMargins,
    calibrateNodeHeight,
    copyVirtualNodeState,
    sameVirtualNodeShape,
    virtualHeight,
    virtualMargins,
    virtualNodeKey,
} from './heights.js';
import { createNodeDesc, createVirtualDesc } from './descs.js';
import { dematerializeRealDescs, materializeVirtualDescs } from './materialize.js';
import { createVirtualDOM, createVirtualDOMBatch } from './placeholders.js';
import { forkRuntime } from './runtime.js';
import {
    captureVirtualAnchor,
    findVirtualRange,
    hasUsableLayout,
    virtualRangeForDescs,
} from './viewport.js';

function queueVirtualMatch(map, key, desc) {
    let queue = map.get(key);
    if (!queue) map.set(key, queue = { items: [], index: 0 });
    queue.items.push(desc);
}

function takeVirtualMatch(map, key, used) {
    let queue = map.get(key);
    while (queue && queue.index < queue.items.length) {
        let desc = queue.items[queue.index++];
        if (!used.has(desc)) return desc;
    }
    return null;
}

function topLevelStructureChanged(state, doc) {
    let descs = state.topLevelDescs;
    if (descs.length != doc.childCount)
        return true;
    let oldIndices = new Map;
    for (let index = 0; index < descs.length; index++) {
        let desc = descs[index];
        if (!desc || !desc.node)
            return true;
        oldIndices.set(desc.node, index);
    }
    let matchedOld = new Uint8Array(descs.length), unmatchedNew = [], lastIndex = -1;
    for (let index = 0; index < doc.childCount; index++) {
        let oldIndex = oldIndices.get(doc.child(index));
        if (oldIndex == null) {
            unmatchedNew.push(index);
            continue;
        }
        if (oldIndex <= lastIndex)
            return true;
        lastIndex = oldIndex;
        matchedOld[oldIndex] = 1;
    }
    let unmatchedOld = [];
    for (let index = 0; index < matchedOld.length; index++)
        if (!matchedOld[index]) unmatchedOld.push(index);
    if (unmatchedOld.length != unmatchedNew.length)
        return true;
    // A wholesale rewrite (e.g. a shared document projection that replaces
    // every top-level child with a fresh node object) keeps the child count
    // and the unmatched positions, so it looks like a content-only change.
    // Rebuilding all of those blocks through the generic ProseMirror path is
    // far more expensive than the virtualized reconciler.
    if (unmatchedOld.length > MAX_FAST_PATH_BLOCKS)
        return true;
    for (let index = 0; index < unmatchedOld.length; index++)
        if (unmatchedOld[index] != unmatchedNew[index])
            return true;
    return false;
}

// The window follows the blocks that were in it. A structural change moves
// the blocks around, and the reconciliation knows where the reused blocks
// went, so the window can be remapped without reading the layout. That
// matters during a rebuild: the new blocks are detached, so their layout
// cannot be measured, and the old window would point at the wrong blocks.
function remappedVirtualRange(state, oldNodeDescs, matched) {
    let previous = state.range;
    if (!previous || !previous.end)
        return null;
    let newIndex = new Map;
    for (let index = 0; index < matched.length; index++)
        if (matched[index])
            newIndex.set(matched[index], index);
    let start = -1, end = -1;
    for (let oldIndex = previous.start; oldIndex < previous.end && oldIndex < oldNodeDescs.length; oldIndex++) {
        let index = newIndex.get(oldNodeDescs[oldIndex]);
        if (index == null)
            continue;
        if (start < 0 || index < start) start = index;
        if (index + 1 > end) end = index + 1;
    }
    return start < 0 ? null : { start, end };
}

export function updateVirtualTopLevelChildren(parent, view) {
    let state = view._virtualization, oldChildren = parent.children;
    if (!topLevelStructureChanged(state, parent.node))
        return false;
    let nodes = [], outerDecos = [], innerDecos = [], nodePositions = [], entries = [], nodePos = 0;
    forkRuntime.iterDeco(parent.node, parent.innerDeco, widget => {
        entries.push({ widget, pos: nodePos });
    }, (child, outerDeco, innerDeco) => {
        let index = nodes.length;
        entries.push({ nodeIndex: index });
        nodes.push(child);
        outerDecos.push(outerDeco);
        innerDecos.push(innerDeco);
        nodePositions.push(nodePos);
        nodePos += child.nodeSize;
    });

    let byNode = new Map, byContent = new Map, byKey = new Map;
    let oldNodeDescs = [], oldWidgetDescs = [];
    for (let desc of oldChildren) {
        if (!desc) continue;
        if (desc.node) {
            oldNodeDescs.push(desc);
            queueVirtualMatch(byNode, desc.node, desc);
            queueVirtualMatch(byContent, desc.node.content, desc);
            queueVirtualMatch(byKey, virtualNodeKey(desc.node), desc);
        }
        else if (desc instanceof forkRuntime.WidgetViewDesc) {
            oldWidgetDescs.push(desc);
        }
    }

    let used = new Set, matched = [];
    for (let index = 0; index < nodes.length; index++) {
        let node = nodes[index];
        let desc = takeVirtualMatch(byNode, node, used);
        if (!desc) desc = takeVirtualMatch(byContent, node.content, used);
        if (desc) {
            used.add(desc);
            matched[index] = desc;
        }
    }
    for (let index = 0; index < nodes.length; index++) {
        if (matched[index]) continue;
        let desc = takeVirtualMatch(byKey, virtualNodeKey(nodes[index]), used);
        if (desc) {
            used.add(desc);
            matched[index] = desc;
        }
    }
    for (let index = 0; index < nodes.length; index++) {
        if (matched[index]) continue;
        let desc = oldNodeDescs[index];
        if (desc && !used.has(desc) && desc.node && desc.node.sameMarkup(nodes[index])) {
            used.add(desc);
            matched[index] = desc;
        }
    }
    for (let entry of entries) {
        if (!entry.widget) continue;
        for (let desc of oldWidgetDescs) {
            if (used.has(desc) || !desc.matchesWidget(entry.widget)) continue;
            if (entry.widget != desc.widget && desc.widget.type.toDOM.parentNode) continue;
            entry.desc = desc;
            used.add(desc);
            break;
        }
    }

    let initialPlaceholderDOMs = null;
    if (!view.docView && state.range && !parent.contentDOM.firstChild) {
        let heights = [], margins = [];
        for (let index = 0; index < nodes.length; index++) {
            heights.push(virtualHeight(view, nodes[index]));
            margins.push(virtualMargins(state, nodes[index]));
        }
        initialPlaceholderDOMs = createVirtualDOMBatch(parent.contentDOM, heights, margins);
    }

    let nextNodeDescs = [], nextChildren = [];
    for (let index = 0; index < nodes.length; index++) {
        let desc = matched[index], node = nodes[index];
        if (!desc) {
            if (!view.docView && state.range && index >= state.range.start && index < state.range.end) {
                desc = createNodeDesc(parent, node, outerDecos[index], innerDecos[index], view, nodePositions[index], { topLevelIndex: index });
                let placeholder = initialPlaceholderDOMs && initialPlaceholderDOMs[index];
                if (placeholder && placeholder.parentNode == parent.contentDOM)
                    parent.contentDOM.replaceChild(desc.dom, placeholder);
            }
            else {
                let height = virtualHeight(view, node);
                let dom = initialPlaceholderDOMs ? initialPlaceholderDOMs[index] : createVirtualDOM(height);
                // A placeholder carries the margins of the block it stands in
                // for, so the swap does not change the flow height.
                applyVirtualMargins(dom, virtualMargins(state, node));
                desc = createVirtualDesc(parent, node, outerDecos[index], innerDecos[index], dom, height, view);
            }
        }
        desc.parent = parent;
        desc.topLevelIndex = index;
        nextNodeDescs[index] = desc;
    }
    for (let entry of entries) {
        if (entry.widget) {
            nextChildren.push(entry.desc || new forkRuntime.WidgetViewDesc(parent, entry.widget, view, entry.pos));
        }
        else {
            nextChildren.push(nextNodeDescs[entry.nodeIndex]);
        }
    }
    parent.children = nextChildren;

    for (let index = 0; index < nodes.length; index++) {
        let desc = nextNodeDescs[index], oldNode = desc.node;
        if (!oldNode) continue;
        if (desc.virtual) {
            desc.update(nodes[index], outerDecos[index], innerDecos[index], view);
        }
        else {
            copyVirtualNodeState(state, oldNode, nodes[index], sameVirtualNodeShape(oldNode, nodes[index]));
            if (!desc.update(nodes[index], outerDecos[index], innerDecos[index], view)) {
                let childIndex = parent.children.indexOf(desc);
                desc.destroy();
                let height = virtualHeight(view, nodes[index]);
                let dom = createVirtualDOM(height);
                applyVirtualMargins(dom, virtualMargins(state, nodes[index]));
                desc = createVirtualDesc(parent, nodes[index], outerDecos[index], innerDecos[index],
                    dom, height, view);
                desc.topLevelIndex = index;
                nextNodeDescs[index] = desc;
                if (childIndex >= 0) {
                    parent.children[childIndex] = desc;
                    nextChildren[childIndex] = desc;
                }
            }
        }
    }
    for (let desc of oldChildren)
        if (!used.has(desc)) desc.destroy();

    state.topLevelDescs.length = nodes.length;
    for (let index = 0; index < nextNodeDescs.length; index++)
        state.topLevelDescs[index] = nextNodeDescs[index];
    // The visible range and the scroll anchor are read before the DOM
    // changes. Reading the layout after the mutation forces a layout pass
    // over the whole editor, which is what made structural edits expensive.
    // Only descs that are in the document can be measured: a rebuild
    // creates every desc detached, and a detached element has no rectangle,
    // which would make the whole document look visible and materialize it.
    // A rebuild therefore remaps the window and skips the anchor, because
    // there is nothing rendered to anchor to.
    let range = null, anchor = null;
    if (!state.activationPending) {
        // The range can only be measured when every block is in the
        // document. A rebuild creates the new blocks detached, and a
        // detached element has no rectangle: one detached block is enough
        // to make the binary search degenerate, because its 0/0 rectangle
        // looks like "inside the viewport" to the search.
        let rendered = state.topLevelDescs.every(desc => desc && desc.dom && desc.dom.parentNode == parent.contentDOM);
        if (rendered && hasUsableLayout(view)) {
            range = findVirtualRange(view, state.options.overscanPx);
            anchor = captureVirtualAnchor(view);
        }
        else {
            // The rebuilt blocks are not in the document yet, so the layout
            // cannot be measured. The window follows the blocks that were
            // in it: a structural change moves them, and the reconciliation
            // knows where they went. The model range is only the last
            // resort, because it is too coarse to replace a measured one:
            // it would move the materialized blocks and make the editor
            // flash placeholders.
            range = remappedVirtualRange(state, oldNodeDescs, matched);
            if (!range)
                range = virtualRangeForDescs(view, state.topLevelDescs, state.options.overscanPx);
        }
    }
    forkRuntime.renderDescs(parent.contentDOM, nextChildren, view);
    if (initialPlaceholderDOMs && view.trackWrites == parent.contentDOM)
        view.trackWrites = null;
    if (!state.activationPending) {
        for (let desc of nextNodeDescs)
            if (!desc.virtual) calibrateNodeHeight(view, desc);

        state.range = range;
        state.docChildCount = nodes.length;
        if (view.docView) {
            dematerializeRealDescs(view, state, { keepSelection: true, anchor });

            let entering = [];
            for (let index = range.start; index < range.end; index++) {
                let desc = state.topLevelDescs[index];
                if (desc && desc.virtual) entering.push(desc);
            }
            materializeVirtualDescs(view, entering, { anchor });
            state.topLevelChanged = false;
        }
    }
    else {
        state.docChildCount = nodes.length;
    }
    return true;
}
