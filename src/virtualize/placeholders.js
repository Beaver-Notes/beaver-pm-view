import { VIRTUAL_PLACEHOLDER_CLASS } from './constants.js';
import { applyVirtualMargins } from './heights.js';
import { forkRuntime } from './runtime.js';

const virtualDOMStates = new WeakMap;
const semanticTemplates = new Map;
const HEIGHT_SENTINEL = '987654.321px';
const MARGIN_SENTINEL = '876543.219px';

function captureVirtualDOMState(dom) {
    return {
        reusable: true,
        style: dom.getAttribute('style'),
        className: dom.getAttribute('class'),
        ariaHidden: dom.getAttribute('aria-hidden'),
        contentEditable: dom.getAttribute('contenteditable'),
        pmVirtual: dom.getAttribute('data-pm-virtual'),
    };
}

function restoreAttribute(dom, name, value) {
    if (value == null)
        dom.removeAttribute(name);
    else
        dom.setAttribute(name, value);
}

function restoreVirtualDOMBase(dom, state) {
    restoreAttribute(dom, 'style', state.style);
    restoreAttribute(dom, 'class', state.className);
    restoreAttribute(dom, 'aria-hidden', state.ariaHidden);
    restoreAttribute(dom, 'contenteditable', state.contentEditable);
    restoreAttribute(dom, 'data-pm-virtual', state.pmVirtual);
}

function markVirtualDOM(dom, height, margins, state) {
    restoreVirtualDOMBase(dom, state);
    dom.classList.add(VIRTUAL_PLACEHOLDER_CLASS);
    dom.dataset.pmVirtual = 'true';
    dom.setAttribute('aria-hidden', 'true');
    dom.setAttribute('contenteditable', 'false');
    dom.style.height = height + 'px';
    applyVirtualMargins(dom, margins);
    dom.style.overflow = 'hidden';
}

export function reusableNode(node, view, outerDeco) {
    return !!(node && node.isTextblock && view && !(view.nodeViews && view.nodeViews[node.type.name]) &&
        !(outerDeco && outerDeco.length) && !Object.keys(node.attrs).length);
}

function semanticTemplate(node, view) {
    if (!reusableNode(node, view, null))
        return null;
    let key = node.type.name;
    if (semanticTemplates.has(key))
        return semanticTemplates.get(key);
    let rendered = forkRuntime.DOMSerializer.renderSpec(
        document, node.type.spec.toDOM(node), null, node.attrs);
    if (!rendered.dom || rendered.contentDOM !== rendered.dom) {
        semanticTemplates.set(key, null);
        return null;
    }
    let dom = rendered.dom, state = captureVirtualDOMState(dom);
    dom.classList.add(VIRTUAL_PLACEHOLDER_CLASS);
    dom.dataset.pmVirtual = 'true';
    dom.setAttribute('aria-hidden', 'true');
    dom.setAttribute('contenteditable', 'false');
    dom.style.height = HEIGHT_SENTINEL;
    dom.style.marginTop = MARGIN_SENTINEL;
    dom.style.marginBottom = MARGIN_SENTINEL;
    dom.style.overflow = 'hidden';
    let template = { markup: dom.outerHTML, state };
    semanticTemplates.set(key, template);
    return template;
}

export function registerReusableDOM(dom) {
    if (!dom || dom.nodeType != 1)
        return false;
    let state = captureVirtualDOMState(dom);
    state.contentDOM = dom;
    virtualDOMStates.set(dom, state);
    return true;
}

export function virtualDOMState(dom) {
    return virtualDOMStates.get(dom);
}

export function restoreVirtualDOM(dom) {
    let state = virtualDOMStates.get(dom);
    if (state)
        restoreVirtualDOMBase(dom, state);
    return state;
}

export function restoreVirtualPlaceholder(dom, height, margins) {
    let state = virtualDOMStates.get(dom);
    if (!state || !state.reusable)
        return false;
    markVirtualDOM(dom, height, margins, state);
    return true;
}

export function createVirtualDOM(height, margins, options) {
    let dom = null;
    if (options && reusableNode(options.node, options.view, options.outerDeco)) {
        let rendered = forkRuntime.DOMSerializer.renderSpec(
            document, options.node.type.spec.toDOM(options.node), null, options.node.attrs);
        if (rendered.dom && rendered.contentDOM === rendered.dom)
            dom = rendered.dom;
    }
    if (dom) {
        let state = captureVirtualDOMState(dom);
        state.contentDOM = dom;
        virtualDOMStates.set(dom, state);
        markVirtualDOM(dom, height, margins, state);
        return dom;
    }
    dom = document.createElement('div');
    dom.className = VIRTUAL_PLACEHOLDER_CLASS;
    dom.dataset.pmVirtual = 'true';
    dom.setAttribute('aria-hidden', 'true');
    dom.contentEditable = 'false';
    dom.style.height = height + 'px';
    applyVirtualMargins(dom, margins);
    dom.style.overflow = 'hidden';
    return dom;
}

export function createVirtualDOMBatch(parentDOM, heights, margins, nodes, view, outerDecos) {
    // Static numeric markup parses in one native operation; per-placeholder DOM calls dominate heavy mounts.
    let markup = [], states = [];
    for (let index = 0; index < heights.length; index++) {
        let node = nodes && nodes[index];
        let outerDeco = outerDecos && outerDecos[index];
        let template = node && reusableNode(node, view, outerDeco) && semanticTemplate(node, view);
        if (template) {
            let margin = margins && margins[index];
            markup.push(template.markup
                .replace(HEIGHT_SENTINEL, heights[index] + 'px')
                .replace(MARGIN_SENTINEL, margin ? margin.top + 'px' : '0px')
                .replace(MARGIN_SENTINEL, margin ? margin.bottom + 'px' : '0px'));
            states[index] = template.state;
            continue;
        }
        let margin = margins && margins[index];
        let marginStyle = margin
            ? ';margin-top:' + margin.top + 'px;margin-bottom:' + margin.bottom + 'px'
            : '';
        markup.push('<div class="' + VIRTUAL_PLACEHOLDER_CLASS + '" data-pm-virtual="true" aria-hidden="true"' +
            ' contenteditable="false" style="height:' + heights[index] + 'px' + marginStyle + ';overflow:hidden"></div>');
    }
    parentDOM.innerHTML = forkRuntime.maybeWrapTrusted(markup.join(''));
    let children = Array.from(parentDOM.children);
    for (let index = 0; index < states.length; index++) {
        if (!states[index]) continue;
        let state = { ...states[index], contentDOM: children[index] };
        virtualDOMStates.set(children[index], state);
    }
    return children;
}
