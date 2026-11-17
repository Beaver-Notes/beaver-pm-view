import { activateVirtualization, destroyVirtualization, ensureVirtualization, initializeVirtualization,
    materializeForSelection, materializeSelectionBlocks, materializeVisibleBlocks, prepareVirtualUpdate,
    scheduleVirtualActivation } from './activation.js';
import { calibrateTopLevelChildren, configureDescs, createNodeDesc, createVirtualDesc,
    registerTopLevelDesc, rememberEstimatedHeight, shouldVirtualizeTopLevel, syncTopLevelDescCount,
    trackTopLevelDesc } from './descs.js';
import { compensateVirtualHeight, dematerializeRealDescs, materializeVirtualDescs } from './materialize.js';
import { createVirtualDOM, createVirtualDOMBatch } from './placeholders.js';
import { updateVirtualTopLevelChildren } from './reconcile.js';
import { configureForkRuntime, forkRuntime } from './runtime.js';
import { isTopLevelUpdater, topLevelDescAtIndex, topLevelIndexAtPos, topLevelIndexForUpdater, virtualOptions } from './state.js';
import { findVirtualRange } from './viewport.js';

export function configureVirtualization(dependencies) {
    configureForkRuntime(dependencies);
    forkRuntime.ensureVirtualization = ensureVirtualization;
    forkRuntime.materializeVirtualDescs = materializeVirtualDescs;
    configureDescs();
}

export {
    activateVirtualization,
    calibrateTopLevelChildren,
    compensateVirtualHeight,
    createNodeDesc,
    createVirtualDesc,
    createVirtualDOM,
    createVirtualDOMBatch,
    dematerializeRealDescs,
    destroyVirtualization,
    ensureVirtualization,
    findVirtualRange,
    initializeVirtualization,
    isTopLevelUpdater,
    materializeForSelection,
    materializeSelectionBlocks,
    materializeVirtualDescs,
    materializeVisibleBlocks,
    prepareVirtualUpdate,
    registerTopLevelDesc,
    rememberEstimatedHeight,
    scheduleVirtualActivation,
    shouldVirtualizeTopLevel,
    syncTopLevelDescCount,
    topLevelDescAtIndex,
    topLevelIndexAtPos,
    topLevelIndexForUpdater,
    trackTopLevelDesc,
    updateVirtualTopLevelChildren,
    virtualOptions,
};
