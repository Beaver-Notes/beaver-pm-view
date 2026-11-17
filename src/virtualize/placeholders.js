import { VIRTUAL_PLACEHOLDER_CLASS } from './constants.js';
import { applyVirtualMargins } from './heights.js';
import { forkRuntime } from './runtime.js';

export function createVirtualDOM(height, margins) {
    let dom = document.createElement('div');
    dom.className = VIRTUAL_PLACEHOLDER_CLASS;
    dom.dataset.pmVirtual = 'true';
    dom.setAttribute('aria-hidden', 'true');
    dom.contentEditable = 'false';
    dom.style.height = height + 'px';
    applyVirtualMargins(dom, margins);
    dom.style.overflow = 'hidden';
    return dom;
}

export function createVirtualDOMBatch(parentDOM, heights, margins) {
    // Static numeric markup parses in one native operation; per-placeholder DOM calls dominate heavy mounts.
    let markup = [];
    for (let index = 0; index < heights.length; index++) {
        let margin = margins && margins[index];
        let marginStyle = margin
            ? ';margin-top:' + margin.top + 'px;margin-bottom:' + margin.bottom + 'px'
            : '';
        markup.push('<div class="' + VIRTUAL_PLACEHOLDER_CLASS + '" data-pm-virtual="true" aria-hidden="true"' +
            ' contenteditable="false" style="height:' + heights[index] + 'px' + marginStyle + ';overflow:hidden"></div>');
    }
    parentDOM.innerHTML = forkRuntime.maybeWrapTrusted(markup.join(''));
    return Array.from(parentDOM.children);
}
