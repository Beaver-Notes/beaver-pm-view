import {
    DEFAULT_AVG_CHAR_WIDTH,
    DEFAULT_CONTENT_WIDTH,
    DEFAULT_CODE_LINE_HEIGHT,
    DEFAULT_CODE_MARGIN,
    DEFAULT_CODE_PADDING,
    DEFAULT_FONT_SIZE,
    DEFAULT_HEADING,
    DEFAULT_LINE_HEIGHT,
    DEFAULT_LIST_ITEM_MARGIN,
    DEFAULT_LIST_MARGIN,
    DEFAULT_PARAGRAPH_MARGIN,
    DEFAULT_TABLE_AVG_CHAR_WIDTH,
    DEFAULT_TABLE_CELL_PADDING,
    DEFAULT_TABLE_LINE_HEIGHT,
    DEFAULT_VIRTUAL_HEIGHT,
    MIN_CALIBRATION_TEXT_LENGTH,
} from './constants.js';

export function virtualCalibrationKey(node) {
    if (node.type.name == 'heading')
        return 'heading:' + node.attrs.level;
    return node.type.name;
}

function pixelValue(value) {
    let number = Number.parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function computedStyleFor(dom) {
    let window = dom.ownerDocument && dom.ownerDocument.defaultView;
    return window ? window.getComputedStyle(dom) : null;
}

function estimatedTextLength(node) {
    return node.isText ? node.text.length : node.textContent.length;
}

function estimatedLineCount(length, charsPerLine) {
    return Math.max(1, Math.ceil(length / Math.max(1, charsPerLine)));
}

function calibratedHeight(state, key) {
    return state.calibration.get(key);
}

export function estimateNodeHeight(view, node) {
    let state = view._virtualization;
    if (!state)
        return DEFAULT_VIRTUAL_HEIGHT;
    let name = node.type.name, width = state.width || DEFAULT_CONTENT_WIDTH;
    if (name == 'paragraph') {
        let calibration = calibratedHeight(state, name);
        let lineHeight = calibration && calibration.lineHeight || DEFAULT_LINE_HEIGHT;
        let charsPerLine = calibration && calibration.charsPerLine || width / DEFAULT_AVG_CHAR_WIDTH;
        return estimatedLineCount(estimatedTextLength(node), charsPerLine) * lineHeight;
    }
    if (name == 'heading') {
        let level = Math.min(6, Math.max(1, node.attrs.level || 1));
        let key = 'heading:' + level, defaults = DEFAULT_HEADING[level];
        let calibration = calibratedHeight(state, key);
        let lineHeight = calibration && calibration.lineHeight || defaults.lineHeight;
        let fontSize = calibration && calibration.fontSize || defaults.fontSize;
        let charsPerLine = calibration && calibration.charsPerLine || width / (fontSize * .5);
        return estimatedLineCount(estimatedTextLength(node), charsPerLine) * lineHeight;
    }
    if (name == 'table') {
        let rows = node.childCount, columns = rows ? node.child(0).childCount : 0;
        if (!rows || !columns)
            return DEFAULT_VIRTUAL_HEIGHT;
        let calibration = calibratedHeight(state, name);
        let lineHeight = calibration && calibration.cellLineHeight || DEFAULT_TABLE_LINE_HEIGHT;
        let padding = calibration && calibration.cellPadding != null ? calibration.cellPadding : DEFAULT_TABLE_CELL_PADDING;
        let columnChars = calibration && calibration.columnChars;
        let height = 0;
        for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
            let row = node.child(rowIndex), lines = 1;
            for (let column = 0; column < row.childCount; column++) {
                let cell = row.child(column);
                let charsPerLine = columnChars && columnChars[column] || width / columns / DEFAULT_TABLE_AVG_CHAR_WIDTH;
                lines = Math.max(lines, estimatedLineCount(estimatedTextLength(cell), charsPerLine));
            }
            height += lines * lineHeight + padding;
        }
        return height;
    }
    if (name == 'bulletList' || name == 'orderedList') {
        let calibration = calibratedHeight(state, name);
        let lineHeight = calibration && calibration.lineHeight || DEFAULT_LINE_HEIGHT;
        let charsPerLine = calibration && calibration.charsPerLine || width / DEFAULT_AVG_CHAR_WIDTH;
        let items = node.childCount;
        let lines = Math.max(items, estimatedLineCount(estimatedTextLength(node), charsPerLine));
        return lines * lineHeight + items * DEFAULT_LIST_ITEM_MARGIN;
    }
    if (name == 'codeBlock') {
        let calibration = calibratedHeight(state, name);
        let lineHeight = calibration && calibration.lineHeight || DEFAULT_CODE_LINE_HEIGHT;
        let padding = calibration && calibration.padding != null ? calibration.padding : DEFAULT_CODE_PADDING;
        let lines = Math.max(1, node.textContent.split(/\r\n|\r|\n/).length);
        return lines * lineHeight + padding;
    }
    if (name == 'div') {
        let calibration = calibratedHeight(state, name);
        let lineHeight = calibration && calibration.lineHeight || DEFAULT_LINE_HEIGHT;
        let charsPerLine = calibration && calibration.charsPerLine || width / DEFAULT_AVG_CHAR_WIDTH;
        let lines = Math.max(node.childCount, estimatedLineCount(estimatedTextLength(node), charsPerLine));
        return lines * lineHeight;
    }
    return DEFAULT_VIRTUAL_HEIGHT;
}

function refreshVirtualEstimates(view, state, key) {
    let children = state.topLevelDescs;
    if (!children)
        return;
    for (let desc of children) {
        if (!desc || !desc.virtual || !desc.node || virtualCalibrationKey(desc.node) != key)
            continue;
        if (!state.heights.get(desc.node))
            state.estimates.set(desc.node, estimateNodeHeight(view, desc.node));
        let height = virtualHeight(view, desc.node);
        desc.estimatedHeight = height;
        desc.dom.style.height = height + 'px';
        applyVirtualMargins(desc.dom, virtualMargins(state, desc.node));
    }
}

export function calibrateNodeHeight(view, desc) {
    let state = view._virtualization, node = desc && desc.node, dom = desc && desc.dom;
    if (!state || !node || !dom || dom.nodeType != 1 || desc.virtual)
        return;
    let key = virtualCalibrationKey(node);
    if (state.calibration.has(key))
        return;
    let height = dom.getBoundingClientRect().height;
    if (!(height > 0))
        return;
    let style = computedStyleFor(dom);
    let fontSize = style && pixelValue(style.fontSize) || DEFAULT_FONT_SIZE;
    let lineHeight = style && pixelValue(style.lineHeight) || fontSize * 1.5;
    let marginTop = style ? pixelValue(style.marginTop) : 0;
    let marginBottom = style ? pixelValue(style.marginBottom) : 0;
    // The first block of the editor has no top margin. That is a rule for the
    // first block, so the type keeps its own top margin for every placeholder
    // that stands in for it.
    if (!marginTop && dom.parentNode && dom.parentNode.firstElementChild == dom)
        marginTop = defaultVirtualMargin(node);
    let margin = Math.max(marginTop, marginBottom);
    let padding = style ? pixelValue(style.paddingTop) + pixelValue(style.paddingBottom) : 0;
    let textLength = (dom.textContent || '').trim().length;
    if (node.type.name == 'table') {
        let rows = Array.from(dom.querySelectorAll('tr'));
        if (!rows.length)
            return;
        let lineHeightTotal = 0, paddingTotal = 0, samples = 0;
        let columnChars = [], columnSamples = [];
        for (let row of rows) {
            let cells = Array.from(row.children);
            for (let column = 0; column < cells.length; column++) {
                let cell = cells[column], cellStyle = computedStyleFor(cell);
                let cellLineHeight = cellStyle && pixelValue(cellStyle.lineHeight) || DEFAULT_TABLE_LINE_HEIGHT;
                let cellPadding = cellStyle
                    ? pixelValue(cellStyle.paddingTop) + pixelValue(cellStyle.paddingBottom) +
                        pixelValue(cellStyle.borderTopWidth) + pixelValue(cellStyle.borderBottomWidth)
                    : DEFAULT_TABLE_CELL_PADDING;
                let cellHeight = cell.getBoundingClientRect().height;
                if (!(cellHeight > 0))
                    continue;
                let lines = Math.max(1, Math.ceil((cellHeight - cellPadding) / cellLineHeight - .05));
                let cellTextLength = (cell.textContent || '').trim().length;
                let chars = cellTextLength >= MIN_CALIBRATION_TEXT_LENGTH ? cellTextLength / lines : 0;
                if (chars) {
                    columnChars[column] = (columnChars[column] || 0) + chars;
                    columnSamples[column] = (columnSamples[column] || 0) + 1;
                }
                lineHeightTotal += cellLineHeight;
                paddingTotal += cellPadding;
                samples++;
            }
        }
        if (!samples)
            return;
        for (let column = 0; column < columnChars.length; column++)
            columnChars[column] = columnSamples[column] ? columnChars[column] / columnSamples[column] : 0;
        state.calibration.set(key, {
            cellLineHeight: lineHeightTotal / samples,
            cellPadding: paddingTotal / samples,
            columnChars,
            marginTop,
            marginBottom,
            margin,
            margins: { top: marginTop, bottom: marginBottom },
        });
    }
    else {
        let lines = Math.max(1, Math.round(height / lineHeight));
        state.calibration.set(key, {
            fontSize,
            lineHeight,
            marginTop,
            marginBottom,
            margin,
            margins: { top: marginTop, bottom: marginBottom },
            padding,
            charsPerLine: textLength >= MIN_CALIBRATION_TEXT_LENGTH ? textLength / lines : 0,
        });
    }
    let width = view.dom.clientWidth;
    if (width > 0)
        state.width = width;
    refreshVirtualEstimates(view, state, key);
}

// A measured block occupies its border box plus the margins the browser
// collapses around it. A placeholder that replaces it has to carry the same
// margins, otherwise the swap changes the flow height and the content below
// it moves.
function defaultVirtualMargin(node) {
    let name = node.type.name;
    if (name == 'paragraph' || name == 'div')
        return DEFAULT_PARAGRAPH_MARGIN;
    if (name == 'heading') {
        let level = Math.min(6, Math.max(1, node.attrs.level || 1));
        let defaults = DEFAULT_HEADING[level] || DEFAULT_HEADING[4];
        return defaults.margin;
    }
    if (name == 'bulletList' || name == 'orderedList')
        return DEFAULT_LIST_MARGIN;
    if (name == 'codeBlock')
        return DEFAULT_CODE_MARGIN;
    return 0;
}

// The margin objects are shared per node type: the reconciler compares them
// by identity to know whether a placeholder has to be restyled.
const virtualDefaultMargins = new Map;

export function virtualMargins(state, node) {
    if (!state || !node)
        return null;
    let key = virtualCalibrationKey(node);
    let calibration = state.calibration.get(key);
    if (calibration)
        return calibration.margins;
    let margins = virtualDefaultMargins.get(key);
    if (!margins) {
        let value = defaultVirtualMargin(node);
        margins = { top: value, bottom: value };
        virtualDefaultMargins.set(key, margins);
    }
    return margins;
}

export function applyVirtualMargins(dom, margins) {
    if (!dom || !margins)
        return;
    let top = margins.top + 'px', bottom = margins.bottom + 'px';
    if (dom.style.marginTop != top) dom.style.marginTop = top;
    if (dom.style.marginBottom != bottom) dom.style.marginBottom = bottom;
}

export function virtualHeight(view, node) {
    let state = view._virtualization;
    if (!state)
        return DEFAULT_VIRTUAL_HEIGHT;
    let height = state.heights.get(node);
    if (!(height > 0)) {
        height = state.estimates.get(node);
        if (!(height > 0)) {
            height = estimateNodeHeight(view, node);
            state.estimates.set(node, height);
        }
    }
    height += state.heightAdjustments.get(node) || 0;
    return height > 0 ? height : 0;
}

function virtualNodeEdgeText(node) {
    let first = node.firstChild, last = node.lastChild;
    while (first && !first.isText && !first.isLeaf) first = first.firstChild;
    while (last && !last.isText && !last.isLeaf) last = last.lastChild;
    return (first && first.isText ? first.text.slice(0, 32) : '') + '\0' +
        (last && last.isText ? last.text.slice(-32) : '');
}

export function virtualNodeKey(node) {
    let attrs = Object.keys(node.attrs).sort().map(name => {
        let value = node.attrs[name];
        if (value && typeof value == 'object') {
            try { value = JSON.stringify(value); }
            catch { value = String(value); }
        }
        return name + '=' + String(value);
    }).join(';');
    return node.type.name + '\0' + attrs + '\0' + virtualNodeEdgeText(node);
}

export function sameVirtualNodeShape(oldNode, node) {
    return oldNode.sameMarkup(node) && oldNode.nodeSize == node.nodeSize &&
        oldNode.childCount == node.childCount &&
        virtualNodeEdgeText(oldNode) == virtualNodeEdgeText(node);
}

export function copyVirtualNodeState(state, oldNode, node, sameShape) {
    if (sameShape) {
        let height = state.heights.get(oldNode);
        if (height != null && !state.heights.has(node)) state.heights.set(node, height);
        let estimate = state.estimates.get(oldNode);
        if (estimate != null && !state.estimates.has(node)) state.estimates.set(node, estimate);
    }
    let adjustment = state.heightAdjustments.get(oldNode);
    if (adjustment != null && !state.heightAdjustments.has(node))
        state.heightAdjustments.set(node, adjustment);
}
