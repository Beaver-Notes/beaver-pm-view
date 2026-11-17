# Beaver PM View fork maintenance

`beaver-pm-view` is a top-level-block virtualization fork of `prosemirror-view`.
The current upstream base is **prosemirror-view 1.42.3**.

The fork is intentionally split so that an upstream upgrade starts from the new
published dist file and only requires reapplying the marked hook sites in
`src/index.js`. All virtualization behavior lives under `src/virtualize/`.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/index.js` | Verbatim upstream 1.42.3 `dist/index.js`, plus marked virtualization hooks. |
| `src/virtualize/index.js` | Internal fork API consumed by `src/index.js`. |
| `src/virtualize/runtime.js` | Bridge for the few upstream-private classes/functions the fork needs. |
| `src/virtualize/constants.js` | Virtualization defaults. |
| `src/virtualize/state.js` | Options and model-position helpers. |
| `src/virtualize/heights.js` | Height estimation, calibration, margins, and node matching state. |
| `src/virtualize/viewport.js` | Scroller/viewport detection, visible-range math, and scroll anchors. |
| `src/virtualize/placeholders.js` | Single and batched placeholder DOM creation. |
| `src/virtualize/descs.js` | Virtual node desc plus top-level desc creation/tracking hooks. |
| `src/virtualize/materialize.js` | Materialize/dematerialize swaps and height compensation. |
| `src/virtualize/reconcile.js` | O(visible-range) top-level structural reconciliation. |
| `src/virtualize/activation.js` | State lifecycle, scroll activation, and selection materialization. |
| `__tests__/virtualization.spec.js` | The fork contract suite (22 tests). |

`src/index.js` currently differs from upstream 1.42.3 by **73 added and 13
removed lines**, with **25 marked hook sites**. There are no substantial inline
virtualization blocks. Inline exceptions are limited to small adapters around
the delegated calls: adapter locals and arguments, identity-only node matching,
the virtual-desc null guard, observer running flags, selection-deferral
conditionals, lifecycle cleanup calls, and the test-only export.

## Consume from Beaver-Notes

Beaver-Notes currently aliases `prosemirror-view` to its in-tree copy at
`vite.config.js:17`:

```js
'prosemirror-view': join(PACKAGE_ROOT, 'src/lib/pm-view-fork/index.js'),
```

The planned switch is to install a reviewed tag of this package and point the
same alias at the installed package.

The requested shorthand is:

```sh
yarn add gh:Daniele-rolli/beaver-pm-view#v<version>
```

Beaver-Notes currently uses Yarn 1.22.22, which treats `gh:` as a registry URL
and fails before cloning. The equivalent HTTPS Git URL is supported and was
verified against the existing `v1.42.3-pm.0` tag:

```sh
yarn add git+https://github.com/Daniele-rolli/beaver-pm-view.git#v1.42.3-pm.0
```

After this revision is reviewed and tagged, install that tag instead:

```sh
yarn add git+https://github.com/Daniele-rolli/beaver-pm-view.git#v1.42.3-pm.1
```

Then update the Vite alias to resolve the installed package. This keeps the
consumer's `prosemirror-view` import name while using `beaver-pm-view` as the
installed package:

```js
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// in resolve.alias
'prosemirror-view': require.resolve('beaver-pm-view'),
```

The package keeps the runtime dependencies of upstream `prosemirror-view`
(`prosemirror-model`, `prosemirror-state`, and `prosemirror-transform`) so a
Git install does not rely on the consumer's transitive dependency graph.

## Versioning and tags

- Package version: `<upstream-prosemirror-view-version>-pm.<fork-revision>`.
- Git tag: `v<package-version>`, for example `v1.42.3-pm.1`.
- `pm.0` was the imported, interleaved baseline.
- `pm.1` is the modular fork layout with isolated virtualization modules.
- Increment the `pm` revision for fork-only changes.
- On an upstream upgrade, use the new upstream version and restart at
  `pm.0`, or continue the existing revision if the upgrade procedure explicitly
  says to preserve it.

Do not publish or tag until the full verification commands below pass on the
exact tree being tagged.

## Upstream upgrade procedure

1. Record the current upstream base and hook inventory:

   ```sh
   grep -n "fork hook (virtualization)" src/index.js
   git diff --no-index --numstat \
     node_modules/prosemirror-view/dist/index.js src/index.js || true
   ```

2. Update the `prosemirror-view` dev dependency to the new upstream version,
   then install:

   ```sh
   yarn install --non-interactive
   ```

3. Replace the vendored upstream file with the new published dist file:

   ```sh
   cp node_modules/prosemirror-view/dist/index.js src/index.js
   ```

4. Reapply every hook site listed below. Use the old fork as the behavioral
   reference, not as the new base. If an upstream function moved or changed,
   adapt the hook to the new surrounding code and update this document's line
   references.

5. Confirm that only hook-related differences remain:

   ```sh
   git diff --no-index --unified=3 \
     node_modules/prosemirror-view/dist/index.js src/index.js || true
   grep -n "fork hook (virtualization)" src/index.js
   ```

   Every changed hunk should correspond to a hook in the inventory. Large
   unmarked changes are an upstream-copying error and must be rejected.

6. Run all gates on the exact tree:

   ```sh
   yarn install --non-interactive
   npx vitest run
   node --check src/index.js
   for file in src/virtualize/*.js; do node --check "$file"; done
   ```

7. Update `package.json` to `<new-upstream>-pm.<revision>`, update the upstream
   base stated in this document, and have the maintainer commit and tag
   `v<package-version>`.

## Hook inventory (upstream 1.42.3 dist)

Line references in the first column are the marked hook lines in the current
fork. References in the last column are lines in the published
`prosemirror-view@1.42.3/dist/index.js`.

| Fork line(s) | Upstream function/site | Upstream line(s) | Purpose |
| --- | --- | --- | --- |
| 4 | Import block | 1-3 | Import the internal virtualization API. |
| 1373 | `NodeViewDesc.matchesNode` | 1371 | Identity-only document matching while virtualization is active. |
| 1386 | `NodeViewDesc.updateChildren` | 1381 | Route structural top-level changes through the virtual reconciler. |
| 1417 | `NodeViewDesc.updateChildren` child callback | 1395-1410 | Track the created top-level desc. |
| 1421 | `NodeViewDesc.updateChildren` | 1381-1412 | Keep the top-level desc array length synchronized. |
| 1434 | `NodeViewDesc.updateChildren` render branch | 1417-1425 | Calibrate newly materialized block heights. |
| 1494 | `NodeViewDesc.updateInner` | 1478 | Preserve a measured virtual height across node updates. |
| 1531 | Module scope after `NodeViewDesc` | after 1515 | Configure the fork with upstream-private dependencies. |
| 1545 | `docViewDesc` | 1518 | Ensure virtualization state exists before building the document desc. |
| 1985 | `ViewTreeUpdater.recreateWrapper` | 1952-1954 | Preserve top-level identity when recreating a wrapper. |
| 2000 | `ViewTreeUpdater.addNode` | 1968-1970 | Create a placeholder for an off-screen top-level node. |
| 3458 | `LeftMouseDown` constructor | 3403, 3424 | Allow virtual descs without a `nodeDOM`. |
| 4709 | `DOMObserver` constructor | 4668-4679 | Track whether the observer is running. |
| 4759 | `DOMObserver.start` | 4721 | Track observer start state. |
| 4770 | `DOMObserver.stop` | 4730 | Track observer stop state. |
| 5522 | `EditorView` constructor | 5423-5486 | Initialize virtualization state before building the document. |
| 5529 | `EditorView` constructor | 5423-5486 | Schedule deferred activation. |
| 5597 | `EditorView.updateStateInner` | 5542-5552 | Prepare virtual state and selection deferral. |
| 5615 | `EditorView.updateStateInner` | 5565-5570 | Use identity-only root matching. |
| 5619 | `EditorView.updateStateInner` | 5571 | Avoid scroll-position reads while selection work is deferred. |
| 5647 | `EditorView.updateStateInner` | 5589-5596 | Materialize selection/visible blocks before selection DOM work. |
| 5654 | `EditorView.updateStateInner` | 5597-5612 | Skip selection DOM writes while activation is deferred. |
| 5920 | `EditorView.destroy` | 5866-5870 | Release virtualization state when no document desc exists. |
| 5936 | `EditorView.destroy` | 5878-5881 | Release virtualization state after destroying the document desc. |
| 6045 | Export block | 5987 | Export `__findVirtualRange` for the contract suite. |

## Verification commands

```sh
yarn install --non-interactive
npx vitest run
node --check src/index.js
for file in src/virtualize/*.js; do node --check "$file"; done
git diff --no-index --numstat \
  node_modules/prosemirror-view/dist/index.js src/index.js || true
```

The final command is expected to report a small non-zero delta because the
hooks are intentional. The current expected result is `73 13`.

## Upgrade risks

- The fork depends on upstream-private classes and functions (`NodeViewDesc`,
  `WidgetViewDesc`, `iterDeco`, `renderDescs`, `maybeWrapTrusted`, and
  `selectionToDOM`). Their names or contracts may change in any upstream
  release even when public APIs are unchanged.
- `NodeViewDesc` subclasses are created through `src/virtualize/descs.js` so
  the fork can use upstream's base class without exporting it from the public
  package API.
- `DOMObserver.running` is fork-only state used to stop and restore the
  observer around DOM swaps. Keep the three observer hooks together.
- The selection deferral path in `EditorView.updateStateInner` is sensitive to
  upstream changes around selection synchronization. Recheck both selection
  and scroll-position behavior, not only placeholder counts.
- Height calibration is browser/layout dependent. The test suite mocks the
  critical geometry, so perform a manual browser check after an upstream
  upgrade before tagging.
