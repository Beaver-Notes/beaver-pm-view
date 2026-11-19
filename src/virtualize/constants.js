export const DEFAULT_VIRTUAL_HEIGHT = 300;
export const VIRTUAL_PLACEHOLDER_CLASS = 'ProseMirror-virtual-placeholder';
export const DEFAULT_CONTENT_WIDTH = 800;
export const DEFAULT_FONT_SIZE = 17.04;
export const DEFAULT_LINE_HEIGHT = 25.56;
export const DEFAULT_PARAGRAPH_MARGIN = 8.52;
export const DEFAULT_AVG_CHAR_WIDTH = 8.5;
export const DEFAULT_TABLE_AVG_CHAR_WIDTH = 7;
export const DEFAULT_TABLE_CELL_PADDING = 22;
export const DEFAULT_TABLE_LINE_HEIGHT = 25.56;
// Used until at least three measured table row samples provide a robust median.
export const DEFAULT_TABLE_ROW_HEIGHT = 98;
export const TABLE_ROW_SAMPLE_LIMIT = 20;
export const MIN_TABLE_ROW_HEIGHT = 30;
export const MAX_TABLE_ROW_HEIGHT = 600;
export const DEFAULT_LIST_MARGIN = 21.3;
export const DEFAULT_LIST_ITEM_MARGIN = 8.52;
export const DEFAULT_CODE_LINE_HEIGHT = 25.56;
export const DEFAULT_CODE_PADDING = 36;
export const DEFAULT_CODE_MARGIN = 25.56;
export const MIN_CALIBRATION_TEXT_LENGTH = 40;
export const SCROLL_MATERIALIZATION_BUDGET_MS = 8;
export const SCROLL_BATCH_SIZE = 2;
// Even when materialization is cheap enough to fit the time budget, leave
// overscan work for a later frame so one scroll never consumes the whole band.
export const SCROLL_MATERIALIZATION_MAX_PER_FRAME = 8;

// Above this many replaced top-level blocks the change is a bulk rewrite, not
// a local edit, and the virtualized reconciler is cheaper than the generic
// ProseMirror path.
export const MAX_FAST_PATH_BLOCKS = 8;
export const DEFAULT_HEADING = {
    1: { fontSize: 38.34, lineHeight: 42.6, margin: 38.34 },
    2: { fontSize: 25.56, lineHeight: 34.08, margin: 25.56 },
    3: { fontSize: 21.3, lineHeight: 34.08, margin: 21.3 },
    4: { fontSize: 17.04, lineHeight: 25.56, margin: 17.04 },
    5: { fontSize: 17.04, lineHeight: 25.56, margin: 17.04 },
    6: { fontSize: 17.04, lineHeight: 25.56, margin: 17.04 },
};
