import { DEFAULT_CONTENT_WIDTH } from './constants.js';

export function virtualOptions(view) {
    let options = view._props.virtualizeTopLevel;
    if (!options || options.enabled === false ||
        !Number.isFinite(options.threshold) || options.threshold < 0 ||
        !Number.isFinite(options.overscanPx) || options.overscanPx < 0)
        return null;
    return options;
}

export function topLevelIndexAtPos(doc, pos) {
    if (!doc.childCount)
        return -1;
    let $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    let index = $pos.index(0);
    return index < doc.childCount ? index : doc.childCount - 1;
}

export function isTopLevelUpdater(updater, view) {
    return updater.top.parent == null && updater.top.node.type == view.state.schema.topNodeType;
}

export function topLevelIndexForUpdater(updater, view, pos) {
    return isTopLevelUpdater(updater, view) ? topLevelIndexAtPos(view.state.doc, pos) : -1;
}

export function topLevelDescAtIndex(view, index) {
    if (index < 0)
        return null;
    let state = view._virtualization;
    let desc = state && state.topLevelDescs[index];
    return desc && desc.parent == view.docView ? desc : null;
}
