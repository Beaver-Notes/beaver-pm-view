# Maintaining beaver-pm-view

Notes for maintainers: how the fork differs from upstream, how to verify it, and how to release and upgrade it. For an overview and install instructions, see the [README](./README.md).

## Contents

- [Current state](#current-state)
- [Hook inventory](#hook-inventory)
- [Verification](#verification)
- [Versioning and release](#versioning-and-release)
- [Upgrading upstream](#upgrading-upstream)
- [Scroll fix history](#scroll-fix-history)
- [Risks](#risks)

## Current state

Verified on the committed tree:

| Item | Value |
| --- | --- |
| Package version | `1.42.3-pm.8` (`package.json`) |
| Current tagged HEAD | tagged `v1.42.3-pm.8` (resolve with `git rev-parse v1.42.3-pm.8^{commit}`) |
| Previous release | `45b675ae62895286e6062839513f85fa9e7a2de0` (`v1.42.3-pm.7`) |
| Fork delta in `src/index.js` | Upstream 1.42.3 plus 26 marked hooks (86 lines added / 13 removed) |
| Contract tests | 36 in `__tests__/virtualization.spec.js` |

## Hook inventory

Every change to upstream in `src/index.js` is marked `fork hook (virtualization)`. Line numbers are for the current fork and drift as the file changes. Regenerate them with:

```sh
grep -n 'fork hook (virtualization)' src/index.js
```

### Module scope, exports, and view-tree updater

| Fork line | Site | Purpose |
| --- | --- | --- |
| 4 | Import block | Import the internal virtualization API. |
| 517 | `posAtCoords` | Map a placeholder hit to its block start. |
| 1543 | Module scope | Expose upstream internals to fork modules. |
| 1998 | `ViewTreeUpdater.recreateWrapper` | Preserve top-level identity. |
| 2013 | `ViewTreeUpdater.addNode` | Create off-screen placeholders. |
| 3471 | `LeftMouseDown` | Allow virtual descs without a `nodeDOM`. |
| 6058 | Export block | Export `__findVirtualRange` for tests. |

### Desc tree

| Fork line | Site | Purpose |
| --- | --- | --- |
| 1385 | `NodeViewDesc.matchesNode` | Identity-only matching while virtualized. |
| 1398 | `NodeViewDesc.updateChildren` | Route top-level structure to the reconciler. |
| 1429 | `updateChildren` child callback | Track created top-level descs. |
| 1433 | `updateChildren` | Keep the top-level desc array in sync. |
| 1446 | `updateChildren` render branch | Calibrate materialized heights. |
| 1506 | `NodeViewDesc.updateInner` | Preserve measured heights. |
| 1558 | `docViewDesc` | Initialize virtualization state. |

### DOM observer

These three hooks track fork-only `DOMObserver.running` state. Keep them together.

| Fork line | Site | Purpose |
| --- | --- | --- |
| 4722 | `DOMObserver` constructor | Track observer running state. |
| 4772 | `DOMObserver.start` | Track observer running state. |
| 4783 | `DOMObserver.stop` | Track observer running state. |

### Editor view lifecycle

| Fork line | Site | Purpose |
| --- | --- | --- |
| 5535 | `EditorView` constructor | Initialize virtualization state. |
| 5542 | `EditorView` constructor | Defer activation until layout. |
| 5610 | `updateStateInner` | Prepare state and selection deferral. |
| 5628 | `updateStateInner` | Identity-only root matching. |
| 5632 | `updateStateInner` | Defer selection work. |
| 5660 | `updateStateInner` | Materialize selection/visible blocks. |
| 5667 | `updateStateInner` | Skip selection DOM work while deferred. |
| 5933 | `EditorView.destroy` | Release state and listeners. |
| 5949 | `EditorView.destroy` | Release state after destroying the doc desc. |

## Verification

Run on the exact tree being reviewed or tagged:

```sh
npx vitest run
node --check src/index.js
for file in src/virtualize/*.js; do node --check "$file"; done
```

The Beaver-Notes client gates must also pass with this package resolved as `beaver-pm-view`:

```sh
yarn typecheck
npx oxlint --vue-plugin --max-warnings 0
yarn test
```

## Versioning and release

- Package version is `<upstream-version>-pm.<revision>`; the git tag is `v<version>`.
- Tags `v1.42.3-pm.0` through `v1.42.3-pm.8` exist. Keep `package.json` in step with the tag.
- Do not publish or tag until all gates pass on the exact tree.

## Upgrading upstream

1. Replace `src/index.js` with the new published `dist/index.js`.
2. Reapply every hook in the [inventory](#hook-inventory). Use the old fork as a behavior reference, not as the new base.
3. Confirm the only unmarked differences are the intentional adapters, then update the inventory and the upstream version in `package.json`.
4. Run the [verification](#verification) commands and the Beaver-Notes gates.
5. Do a manual browser scroll check. Height calibration depends on real layout, and the tests mock critical geometry.

## Scroll fix history

Fixes on the current HEAD (`v1.42.3-pm.8`):

- **`heights.js`:** a bulk height re-estimate spreads its net delta across placeholders outside the active scroll band, so calibration does not shift the document under the cursor in one frame.
- **`activation.js`:** scroll materialization can cover the whole visible slice in one frame instead of stopping at the small per-frame cap. The time budget still bounds the work.
- **`activation.js`:** a new scroll event clears the cached visible range even when a rAF is already pending. Previously, continuation frames reused a stale range, and fast scrolls could leave the viewport as placeholders until another scroll event.

## Risks

- Several hooks depend on upstream-private classes and functions (`NodeViewDesc`, `WidgetViewDesc`, `iterDeco`, `renderDescs`, `maybeWrapTrusted`, `selectionToDOM`). Their contracts can change in any upstream release.
- `DOMObserver.running` is fork-only state. Keep the three observer hooks together.
- Selection deferral and scroll activation are coupled. After an upgrade, recheck both, not just placeholder counts.
