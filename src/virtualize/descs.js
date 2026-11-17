import {
    applyVirtualMargins,
    calibrateNodeHeight,
    copyVirtualNodeState,
    sameVirtualNodeShape,
    virtualHeight,
    virtualMargins,
} from './heights.js';
import { createVirtualDOM } from './placeholders.js';
import { forkRuntime } from './runtime.js';

let VirtualNodeViewDesc;

export function configureDescs() {
    VirtualNodeViewDesc = class extends forkRuntime.NodeViewDesc {
        constructor(parent, node, outerDeco, innerDeco, dom, estimatedHeight, view) {
            super(parent, node, outerDeco, innerDeco, dom, null, null);
            this.virtual = true;
            this.estimatedHeight = estimatedHeight;
            this.view = view;
            this.margins = null;
        }
        update(node, outerDeco, innerDeco, view) {
            if (!view._virtualization)
                return false;
            let state = view._virtualization, oldNode = this.node;
            copyVirtualNodeState(state, oldNode, node, sameVirtualNodeShape(oldNode, node));
            this.node = node;
            this.outerDeco = outerDeco;
            this.innerDeco = innerDeco;
            let height = virtualHeight(view, node);
            if (this.estimatedHeight != height) {
                this.estimatedHeight = height;
                this.dom.style.height = height + 'px';
            }
            // The margins only change with the node type or the calibration, so
            // the placeholder is not restyled on every reconciliation.
            let margins = virtualMargins(state, node);
            if (this.margins !== margins) {
                applyVirtualMargins(this.dom, margins);
                this.margins = margins;
            }
            this.dirty = forkRuntime.NOT_DIRTY;
            return true;
        }
        matchesNode(node, outerDeco, innerDeco) {
            if (!this.view._virtualization || this.dirty != forkRuntime.NOT_DIRTY)
                return false;
            let sameNode = this.node == node || sameVirtualNodeShape(this.node, node);
            return sameNode && forkRuntime.sameOuterDeco(outerDeco, this.outerDeco) && innerDeco.eq(this.innerDeco);
        }
        destroy() {
            this.parent = undefined;
            if (this.dom.pmViewDesc == this)
                this.dom.pmViewDesc = undefined;
        }
        selectNode() {}
        deselectNode() {}
        descAt(pos) {
            // Keep virtual blocks addressable so nodeDOM can return null without losing their range.
            return pos >= 0 && pos < this.size ? this : undefined;
        }
        localPosFromDOM(dom, offset, bias) {
            let start = this.posAtStart, end = this.posAtEnd;
            // A placeholder click has no text offset, so materialize and use the nearest block edge.
            forkRuntime.materializeVirtualDescs(this.view, [this]);
            return bias > 0 ? end : start;
        }
        domFromPos(pos, side) {
            // Upstream callers expect real content DOM here, so materialize instead of exposing the placeholder.
            let real = forkRuntime.materializeVirtualDescs(this.view, [this])[0];
            return real ? real.domFromPos(pos, side) : { node: this.dom, offset: 0 };
        }
    };
}

export function createVirtualDesc(parent, node, outerDeco, innerDeco, dom, estimatedHeight, view) {
    return new VirtualNodeViewDesc(parent, node, outerDeco, innerDeco, dom, estimatedHeight, view);
}

export function createNodeDesc(parent, node, outerDeco, innerDeco, view, pos, options = {}) {
    let topLevelIndex = options.topLevelIndex == null ? -1 : options.topLevelIndex;
    if (topLevelIndex >= 0 && !options.forceReal && shouldVirtualizeTopLevel(view, topLevelIndex)) {
        let height = virtualHeight(view, node);
        let state = view._virtualization;
        let dom = createVirtualDOM(height);
        applyVirtualMargins(dom, virtualMargins(state, node));
        let desc = createVirtualDesc(parent, node, outerDeco, innerDeco, dom, height, view);
        desc.topLevelIndex = topLevelIndex;
        if (state)
            state.topLevelDescs[topLevelIndex] = desc;
        return desc;
    }
    let desc = forkRuntime.NodeViewDesc.create(parent, node, outerDeco, innerDeco, view, pos);
    if (topLevelIndex >= 0)
        registerTopLevelDesc(view, desc, topLevelIndex);
    return desc;
}

export function shouldVirtualizeTopLevel(view, index) {
    let state = view._virtualization;
    return !!state && (index < state.range.start || index >= state.range.end);
}

export function registerTopLevelDesc(view, desc, index) {
    if (!desc)
        return;
    desc.topLevelIndex = index;
    let state = view._virtualization;
    if (state)
        state.topLevelDescs[index] = desc;
}

export function trackTopLevelDesc(view, root, updater, index) {
    if (root.parent)
        return;
    let desc = updater.top.children[updater.index - 1];
    if (desc)
        registerTopLevelDesc(view, desc, index);
}

export function syncTopLevelDescCount(view, root) {
    if (!root.parent && view._virtualization)
        view._virtualization.topLevelDescs.length = root.node.childCount;
}

export function calibrateTopLevelChildren(view, root) {
    if (root.parent)
        return;
    for (let child of root.children)
        calibrateNodeHeight(view, child);
}

export function rememberEstimatedHeight(view, desc, node) {
    if (desc.estimatedHeight && view._virtualization)
        view._virtualization.heights.set(node, desc.estimatedHeight);
}
