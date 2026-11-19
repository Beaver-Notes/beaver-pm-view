# beaver-pm-view

A virtualization fork of [`prosemirror-view`](https://github.com/ProseMirror/prosemirror-view) 1.42.3, built for [Beaver-Notes](https://github.com/Beaver-Notes). It keeps very long documents responsive by rendering only the part of the document near the viewport.

It is a drop-in replacement: consumers keep importing `prosemirror-view` and alias it to this package.

**Version:** `1.42.3-pm.8` · **Upstream base:** `prosemirror-view` 1.42.3

## How it works

- **Placeholders.** Top-level blocks outside the visible range are rendered as placeholders with a measured (or estimated) height, so scroll length and scrollbar position stay stable.
- **Lazy node views.** A real node view is created for a block when it is needed: on scroll, on caret movement, or on hit testing (for example, clicking a placeholder).
- **Bounded reconciliation.** Top-level structural updates only touch the visible range, so update cost scales with what is on screen, not with document size.
- **Height calibration.** When a placeholder is materialized, its real height is measured and the difference is compensated so the document does not jump under the cursor.
- **Deferred selection.** Selection DOM work waits until layout is ready, and the blocks containing the selection are materialized.

Only top-level blocks are virtualized. Everything inside a materialized block behaves exactly as in upstream.

## Install

Tags follow `<upstream-version>-pm.<revision>`. Yarn 1 does not accept the `gh:` shorthand, so use the HTTPS Git URL:

```sh
yarn add git+https://github.com/Beaver-Notes/beaver-pm-view.git#v1.42.3-pm.8
```

## Usage

Alias `prosemirror-view` to this package in your bundler config:

```js
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// in resolve.alias
'prosemirror-view': require.resolve('beaver-pm-view'),
```

### Configuration

Beaver-Notes sets `overscanPx: 800` in `src/components/note/NoteEditor.vue`. This controls how far beyond the viewport blocks are kept materialized. Raising it to 1600 was measured and made blanking worse, so larger is not better here.

## Known limitations

- Pinned to upstream 1.42.3. Upgrading upstream is a manual process (see [MAINTAINING.md](./MAINTAINING.md#upgrading-upstream)).
- Depends on upstream-private classes and functions, whose contracts can change in any upstream release.
- Height calibration depends on real browser layout. The test suite mocks critical geometry, so a manual scroll check is part of every release.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/index.js` | Upstream dist with marked hook sites that delegate to the fork. |
| `src/virtualize/` | All fork logic (see below). |
| `__tests__/virtualization.spec.js` | Contract suite (36 tests). |

Modules in `src/virtualize/`:

| Module | Responsibility |
| --- | --- |
| `index.js` | Internal API imported by `src/index.js`. |
| `runtime.js` | Upstream-private dependencies supplied through a hook. |
| `constants.js` | Defaults, budget, batch size, and placeholder class. |
| `state.js` | Options and model-position helpers. |
| `heights.js` | Height estimates, calibration, margins, and re-estimate compensation. |
| `viewport.js` | Scroller detection, visible range, and scroll anchors. |
| `placeholders.js` | Placeholder DOM creation. |
| `descs.js` | Virtual/top-level desc creation and matching. |
| `materialize.js` | Placeholder/real-block swaps and height compensation. |
| `reconcile.js` | O(visible-range) top-level structural reconciliation. |
| `activation.js` | State lifecycle, scroll scheduling, and selection activation. |
| `perf.js` | Optional timing instrumentation. |

## Contributing and releasing

Hook inventory, verification commands, release process, upstream upgrade steps, and risks are in [MAINTAINING.md](./MAINTAINING.md).
