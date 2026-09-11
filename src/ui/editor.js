// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Canvas and pointer handling for the editor. The model lives in
// src/lib/edit.js; this file draws it and turns input into edits.
//
// Shapes stay live: with the Select tool you can click one, drag it, drag its
// handles to resize, restyle it, or delete it. That is the convention across
// annotation tools generally, and the reason the model keeps objects rather
// than baked strokes.
//
// The original capture is never drawn into. Every frame re-renders from it, so
// undo is exact and repeated edits never degrade the image.

import {
  decorationOps,
  outlineOps,
  simplifyPath,
} from '../lib/geometry.js';

import {
  BOX_TOOLS,
  CORNERED_KINDS,
  CORNER_HANDLES,
  DEFAULT_FILL_OPACITY,
  FILLABLE_TOOLS,
  MAX_STROKE,
  MAX_TEXT_SIZE,
  MAX_COUNTER_RADIUS,
  MIN_COUNTER_RADIUS,
  MIN_STROKE,
  MIN_TEXT_SIZE,
  PATH_TOOLS,
  POINT_TOOLS,
  TEXT_LINE_RATIO,
  TOOL_PRESETS,
  alignOf,
  amend,
  arrowGeometry,
  boundsOf,
  canRedo,
  canUndo,
  clampRect,
  commit,
  constrain,
  cornerOf,
  createDocument,
  cropHandleAt,
  cropHandlesFor,
  dashOf,
  dashPattern,
  effectiveCrop,
  endsOf,
  fillAlphaOf,
  fillOf,
  fontOf,
  handleAt,
  handleCursor,
  handlesFor,
  hasEnd,
  inkAlphaOf,
  inkOf,
  insideRect,
  isEdited,
  isFramedText,
  isSelected,
  isUsableCrop,
  isUsableDrag,
  kindOfTool,
  linesOf,
  measureText,
  moveCrop,
  moveShape,
  moveShapes,
  newId,
  nextCounterNumber,
  normalizeRect,
  redo,
  removeShape,
  removeShapes,
  reorderShapes,
  replaceShape,
  reset,
  resizeCrop,
  resizeShape,
  selectedIds,
  selectedShape,
  selectedShapes,
  shapeAt,
  shapesInMarquee,
  strokeAlphaOf,
  strokeOf,
  textRadius,
  toggleSelected,
  undo,
  wouldReorder,
  wrapOf,
  wrappedLinesOf,
} from '../lib/edit.js';

const DASH = [8, 6];
const HANDLE_SIZE = 9;
const HIGHLIGHT_ALPHA = 0.35;
const PIXELATE_BLOCKS = 14;
/** How much a loupe magnifies what is under it. */
const LOUPE_ZOOM = 2;

export function createEditor({ base, canvas, onChange, initial = {} }) {
  const ctx = canvas.getContext('2d');

  let doc = createDocument(base.width, base.height);
  let tool = initial.tool ?? 'arrow';
  // null is a value here: it is the border switched off, and it has to survive a
  // reload the way no fill already does.
  let colour = initial.colour === null ? null : (initial.colour ?? '#ef4444');
  let width = initial.strokeWidth ?? 4;
  // Style that new shapes inherit. Each is also editable on the selected shape,
  // which is why every one of them lives here rather than only on the shape.
  let dash = initial.dash ?? 'solid';
  let ends = initial.lineEnds ?? 'end';
  let fill = initial.fill ?? null;
  let fillOpacity = initial.fillOpacity ?? DEFAULT_FILL_OPACITY;
  // How solid the stroke is. One, unless someone says otherwise, because a
  // translucent line by default would read as a rendering fault rather than a
  // choice. It is the Border popover's slider, and on a caption it is the frame.
  let strokeOpacity = initial.strokeOpacity ?? 1;
  // Corner radius is a property of the Box, not three separate tools.
  let corner = initial.corner ?? 0;
  let text = {
    size: initial.textSize ?? 24,
    family: initial.textFamily ?? 'system',
    bold: initial.textBold !== false,
    italic: initial.textItalic === true,
    underline: initial.textUnderline === true,
    align: initial.textAlign ?? 'left',
    // Text keeps its own colour rather than borrowing the stroke colour. An
    // arrow pointing at a thing and a caption naming it are rarely wanted in the
    // same colour, and the default matches the stroke so nothing changes for
    // anyone who never opens the control.
    ink: initial.textColour ?? initial.colour ?? '#ef4444',
    inkOpacity: initial.textInkOpacity ?? 1,
    // The frame around the words, and the plate behind them.
    //
    // The frame is off by default because it has no colour, which is the same
    // thing "no fill" already means and needs no switch to explain it. The plate
    // is off by default because it is fully transparent, and it keeps a colour
    // while it is off so that turning it on is one drag of the opacity slider
    // rather than a hunt for a colour first.
    colour: initial.textFrameColour ?? null,
    strokeOpacity: initial.textFrameOpacity ?? 1,
    fill: initial.textFramePlate ?? '#ffffff',
    fillOpacity: initial.textPlateOpacity ?? 0,
    // The frame's own thickness, kept apart from the stroke width that arrows
    // and boxes share. A 4px rule reads as heavy around 24pt type, and nobody
    // wants setting a frame to 2 to thin every arrow they draw next.
    width: initial.textFrameWidth ?? 2,
  };

  let drag = null;
  /** How far the pointer must travel before a freehand sample is worth keeping. */
  const PEN_SAMPLE_GAP = 1.5;
  /** How far a simplified stroke may stray from the one the reader drew. */
  const PEN_TOLERANCE = 0.6;
  // The document as it was when the current arrow key burst began, so the
  // whole burst collapses into one undo step. Null when no burst is open.
  let nudging = null;
  let editing = null;
  // The shape currently open in the text box, hidden from the canvas while its
  // own words sit over it. Null while a new box is being typed into.
  let editingId = null;
  // The shape under the pointer, outlined so a click is never a guess about what
  // it will land on. Held as an id rather than a shape so a stale object cannot
  // be drawn after an edit replaced it.
  // The size of the next numbered step, in image pixels. Null means "follow the
  // stroke width", which is how every step was sized before this could be set,
  // so a reader who never touches the control sees exactly what they always saw.
  let counterRadius = null;
  let hoverId = null;
  // Where the eraser is, in image pixels, so its reach can be drawn. Null when
  // the pointer is off the canvas, which is when the ring must not be drawn.
  let eraserAt = null;

  /**
   * A crop that has been drawn but not applied.
   *
   * Cropping used to happen on pointerup, which meant the one destructive edit in
   * the editor was also the only one with no chance to look at it first. It is now
   * a proposal: drawn, adjustable by its handles or by sliding it whole, and
   * applied only when the user says so. It lives outside the document because it
   * is not an edit yet, which is also why cancelling it costs no undo step.
   */
  let pendingCrop = null;
  // Set only while flatten() is rendering for export, so the dimming and the
  // handles never reach a saved file.
  let hideChrome = false;
  /**
   * While an export is reading the canvas, nothing may repaint it.
   *
   * PDF encoding walks the canvas one page at a time with an await between each,
   * and a click or a keystroke landing in one of those gaps would repaint the
   * canvas with selection handles or crop dimming on it, which the next page
   * would then photograph. Locking is safer than blocking input: the model still
   * accepts the edit, it is just not drawn until the export lets go.
   *
   * A count, not a flag. Copy is still live while a PDF is encoding, and it takes
   * its own flatten(); with a flag, its restoreSelection() would unlock the canvas
   * halfway through the PDF and hand the remaining pages back to whatever the user
   * did next.
   */
  let locked = 0;

  const notify = () =>
    onChange({
      canUndo: canUndo(doc),
      canRedo: canRedo(doc),
      crop: effectiveCrop(doc),
      edited: isEdited(doc),
      selected: selectedShape(doc),
      selectedCount: selectedIds(doc).length,
      canRaise: wouldReorder(doc.present, selectedIds(doc), 'forward'),
      canLower: wouldReorder(doc.present, selectedIds(doc), 'backward'),
      pendingCrop: pendingCrop ? { ...pendingCrop } : null,
      tool,
      style: currentStyle(),
    });

  // DRAWING

  /**
   * Canvas pixels per screen pixel.
   *
   * The canvas is sized to the crop and then fitted to the window by CSS, so a
   * long capture is displayed at a small fraction of its real size. Anything
   * drawn *about* a shape rather than as part of it is divided by this, so it
   * keeps its size under the pointer at any display scale (D19).
   */
  function screenScale() {
    const box = canvas.getBoundingClientRect();
    return box.width ? canvas.width / box.width : 1;
  }

  /** Arrow and line are the two shapes defined by two endpoints rather than a box. */
  const isLine = (shape) => shape.kind === 'arrow' || shape.kind === 'line';

  function applyDash(shape) {
    ctx.setLineDash(dashPattern(dashOf(shape), shape.width));
  }

  /** One arrowhead, pointing from `from` towards `to`. */
  function head(from, to, shapeWidth, dx, dy) {
    const { head: points } = arrowGeometry(from, to, shapeWidth);
    ctx.beginPath();
    ctx.moveTo(points[0].x + dx, points[0].y + dy);
    ctx.lineTo(points[1].x + dx, points[1].y + dy);
    ctx.lineTo(points[2].x + dx, points[2].y + dy);
    ctx.closePath();
    ctx.fill();
  }

  /** Paint the inside of a box shape, when it has one. */
  function paintFill(shape, path) {
    const colourIn = fillOf(shape);
    if (!colourIn) return;
    ctx.save();
    ctx.globalAlpha = fillAlphaOf(shape);
    ctx.fillStyle = colourIn;
    path();
    ctx.restore();
  }

  /**
   * Replay a list of geometry operations onto the context.
   *
   * The other reader of the same list is `flatten()` in src/lib/geometry.js,
   * which turns it into a polygon for hit testing. Two readers, one description:
   * a shape cannot be drawn as one thing and clicked as another.
   */
  function traceOps(ops, dx, dy) {
    ctx.beginPath();
    for (const op of ops) {
      const code = op[0];
      if (code === 'M') ctx.moveTo(op[1] + dx, op[2] + dy);
      else if (code === 'L') ctx.lineTo(op[1] + dx, op[2] + dy);
      else if (code === 'A') {
        ctx.ellipse(op[1] + dx, op[2] + dy, Math.max(op[3], 0), Math.max(op[4], 0), 0, op[5], op[6], op[7]);
      } else if (code === 'Z') ctx.closePath();
    }
  }

  /** A shape with a closed outline: fill it if it has one, stroke it, then add
      any decoration that belongs to the picture but not to the outline. */
  function drawOutlined(shape, dx, dy) {
    const ops = outlineOps(shape.kind, shape.rect, shape);
    if (!ops) return;
    paintFill(shape, () => {
      traceOps(ops, dx, dy);
      ctx.fill();
    });
    applyDash(shape);
    traceOps(ops, dx, dy);
    ctx.stroke();
    for (const decoration of decorationOps(shape.kind, shape.rect)) {
      traceOps(decoration, dx, dy);
      ctx.stroke();
    }
  }

  /**
   * A loupe: a circular window that magnifies what is under it.
   *
   * It samples the REDACTED base, never the original. A magnifier drawn over a
   * pixelated region would otherwise reproduce the original pixels inside the
   * ring, in the exported file, and hand back exactly the thing the person was
   * trying to hide. The comment on the redaction tool promises the pixels are
   * gone from the output; this is the one feature that could have made that a
   * lie, so it reads from `redactedBase()` and there is a test that draws a
   * loupe over a redaction and asserts the secret does not come back.
   */
  function drawLoupe(shape, dx, dy) {
    const { x, y, w, h } = shape.rect;
    const r = Math.max(Math.min(w, h) / 2, 1);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const half = r / LOUPE_ZOOM;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      redactedBase(),
      cx - half, cy - half, half * 2, half * 2,
      cx - r + dx, cy - r + dy, r * 2, r * 2,
    );
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = strokeOf(shape) ?? 'transparent';
    ctx.lineWidth = shape.width;
    applyDash(shape);
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const decoration of decorationOps('loupe', shape.rect)) {
      ctx.lineWidth = shape.width * 1.6;
      ctx.lineCap = 'round';
      traceOps(decoration, dx, dy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawShape(shape, crop) {
    const dx = -crop.x;
    const dy = -crop.y;

    ctx.save();
    // A redaction is never translucent. Every other shape takes the stroke
    // opacity, and the one that hides something must not be able to be told to
    // hide it only partly: an opacity set for an arrow and inherited by a
    // pixelated block would be a way to read through it.
    ctx.globalAlpha = shape.kind === 'pixelate' ? 1 : strokeAlphaOf(shape);
    // No border colour means nothing is drawn with it. Transparent rather than
    // a guard around every stroke and fill below: canvas ignores an assignment
    // it cannot parse and keeps whatever colour it had, so handing it a null
    // would draw the shape in the last shape's colour rather than not at all.
    const paint = strokeOf(shape) ?? 'transparent';
    ctx.strokeStyle = paint;
    ctx.fillStyle = paint;
    ctx.lineWidth = shape.width;
    ctx.lineCap = dashOf(shape) === 'dotted' ? 'round' : 'round';
    ctx.lineJoin = 'round';

    if (shape.points) {
      // Smoothed through the midpoints of consecutive samples rather than
      // joined corner to corner. The classic trick, and the reason a stroke
      // drawn by hand does not look like a chain of tiny straight lines: each
      // sample becomes the control point of a curve between its neighbours'
      // midpoints, so the line passes near every sample without kinking at any
      // of them. The hit tester still measures against the segments, which is
      // close enough at any stroke width a person would use and keeps one
      // description of where the stroke is.
      const pts = shape.points;
      applyDash(shape);
      ctx.beginPath();

      if (pts.length === 1) {
        // A tap. Deliberately a dot rather than nothing: the reader chose the
        // pen and pressed it somewhere, and a stroke of no length is how you
        // dot a thing you are pointing at.
        ctx.arc(pts[0][0] + dx, pts[0][1] + dy, Math.max(0.5, shape.width / 2), 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      } else {
        ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
        for (let i = 1; i < pts.length - 1; i += 1) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2;
          const my = (pts[i][1] + pts[i + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[i][0] + dx, pts[i][1] + dy, mx + dx, my + dy);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0] + dx, last[1] + dy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    } else if (shape.kind === 'arrow' || shape.kind === 'line') {
      // One geometry per end: the shaft stops short wherever a head is drawn, so
      // the point of the arrow is the point of the line and not a stub past it.
      const atStart = hasEnd(shape, 'start');
      const atEnd = hasEnd(shape, 'end');
      const from = atStart
        ? arrowGeometry(shape.to, shape.from, shape.width).shaft[1]
        : shape.from;
      const to = atEnd ? arrowGeometry(shape.from, shape.to, shape.width).shaft[1] : shape.to;

      applyDash(shape);
      ctx.beginPath();
      ctx.moveTo(from.x + dx, from.y + dy);
      ctx.lineTo(to.x + dx, to.y + dy);
      ctx.stroke();
      ctx.setLineDash([]);

      if (atStart) head(shape.to, shape.from, shape.width, dx, dy);
      if (atEnd) head(shape.from, shape.to, shape.width, dx, dy);
    } else if (shape.kind === 'highlight') {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.fillRect(shape.rect.x + dx, shape.rect.y + dy, shape.rect.w, shape.rect.h);
    } else if (shape.kind === 'pixelate') {
      drawPixelated(shape, dx, dy);
    } else if (shape.kind === 'text') {
      drawText(shape, dx, dy);
    } else if (shape.kind === 'counter') {
      ctx.beginPath();
      ctx.arc(shape.at.x + dx, shape.at.y + dy, shape.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(shape.radius * 1.15)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shape.number), shape.at.x + dx, shape.at.y + dy + 1);
    } else if (shape.kind === 'loupe') {
      drawLoupe(shape, dx, dy);
    } else {
      // Everything else with a closed outline: box, ellipse, rhombus, hexagon,
      // parallelogram, triangle, cylinder, callout. One branch, because the
      // shape is described in src/lib/geometry.js and nowhere else.
      drawOutlined(shape, dx, dy);
    }

    ctx.restore();
  }

  /**
   * Canvas has no underline, so it is drawn: one rule per line, at a tenth of
   * the size below the baseline, thick enough to survive the export.
   */
  function drawText(shape, dx, dy) {
    // The frame first, at the stroke opacity drawShape already set, because the
    // frame is this shape's stroke. Then the glyphs, which carry their own.
    drawTextFrame(shape, dx, dy);
    ctx.globalAlpha = inkAlphaOf(shape);
    ctx.fillStyle = inkOf(shape);
    ctx.font = fontOf(shape);
    // Every line is placed by hand from the block's own left edge, so the canvas
    // alignment is left throughout and `align` is applied as an offset. Letting
    // the canvas align would need a different origin per line and would put the
    // underline in the wrong place, since that is drawn from the same origin.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // The lines as they will be drawn, which is the shape's own lines broken to
    // its wrap width when it has one. A caption written before wrapping existed
    // has no width and gets its own lines back untouched.
    const lines = wrappedLinesOf(shape, (line) => ctx.measureText(line).width);
    const align = alignOf(shape);
    const widths = lines.map((line) => ctx.measureText(line).width);
    // The block a line is aligned inside. With a wrap that is the width that was
    // set, not the longest line: centring inside the longest line would put the
    // words somewhere different every time one of them changed.
    const block = wrapOf(shape) || Math.max(0, ...widths);
    const left = shape.at.x + dx;

    lines.forEach((line, i) => {
      const y = shape.at.y + dy + i * shape.size * TEXT_LINE_RATIO;
      // The last line of a justified block is set flush left, which is what
      // justification means everywhere it is done. Justifying it too would space
      // out a three word closing line across the whole block.
      const spread = align === 'justify' && i < lines.length - 1;
      const x = left + indentFor(align, block, widths[i]);
      const run = spread
        ? drawJustified(line, x, y, block)
        : (ctx.fillText(line, x, y), widths[i]);

      if (shape.underline === true && line.length > 0) {
        ctx.save();
        ctx.strokeStyle = inkOf(shape);
        ctx.lineWidth = Math.max(1, shape.size / 14);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, y + shape.size * 1.06);
        ctx.lineTo(x + run, y + shape.size * 1.06);
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  /**
   * The plate behind a caption and the frame around it.
   *
   * Both are built out of controls that already exist: the plate is the fill
   * colour and fill opacity, the frame is the border colour, the stroke width
   * and the dash. Nothing here is a new concept and nothing needed a new
   * control, which is the whole reason this is fifteen lines.
   *
   * A text label over a busy screenshot is often unreadable, and the plate is
   * the half that fixes that.
   */
  function drawTextFrame(shape, dx, dy) {
    if (!isFramedText(shape)) return;
    const box = boundsOf(shape);
    const ops = outlineOps('rect', box, { corner: textRadius(shape) });
    const stroke = strokeOf(shape);

    paintFill(shape, () => {
      traceOps(ops, dx, dy);
      ctx.fill();
    });

    if (!stroke) return;
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = shape.width;
    applyDash(shape);
    traceOps(ops, dx, dy);
    ctx.stroke();
    ctx.restore();
  }

  /** How far into the block a line of `width` starts, for a given alignment. */
  function indentFor(align, block, width) {
    if (align === 'center') return (block - width) / 2;
    if (align === 'right') return block - width;
    return 0;
  }

  /**
   * Draw one justified line and return the width it actually covered.
   *
   * The gaps between words carry the slack, which is how justification is done:
   * stretching the glyphs themselves would distort the type. A line with one word
   * has nowhere to put the slack, so it is drawn flush left, which is also what a
   * typesetter would do with it.
   */
  function drawJustified(line, x, y, block) {
    const words = line.split(' ').filter((word) => word.length > 0);
    if (words.length < 2) {
      ctx.fillText(line, x, y);
      return ctx.measureText(line).width;
    }
    const ink = words.reduce((total, word) => total + ctx.measureText(word).width, 0);
    const gap = (block - ink) / (words.length - 1);
    let at = x;
    for (const word of words) {
      ctx.fillText(word, at, y);
      at += ctx.measureText(word).width + gap;
    }
    return block;
  }

  /**
   * Redaction: resample the region coarsely from the original and paint it back.
   * The export is flat, so what is saved genuinely has no original underneath ,
   * this is not a blur laid over recoverable pixels in a layered file.
   */
  /**
   * Draw one redaction into any context.
   *
   * Split out from `drawPixelated` so that the redacted base below can be built
   * with exactly the same code path as the screen. If the two ever diverged,
   * the loupe would magnify a redaction that had been computed slightly
   * differently from the one the user is looking at.
   */
  function pixelateInto(target, shape, dx, dy) {
    const { x, y, w, h } = shape.rect;
    if (w < 1 || h < 1) return;

    const cols = Math.max(1, Math.min(PIXELATE_BLOCKS, Math.round(w / 8)));
    const rows = Math.max(1, Math.min(PIXELATE_BLOCKS, Math.round(h / 8)));

    const scratch = document.createElement('canvas');
    scratch.width = cols;
    scratch.height = rows;
    const small = scratch.getContext('2d');
    small.imageSmoothingEnabled = true;
    small.drawImage(base, x, y, w, h, 0, 0, cols, rows);

    target.imageSmoothingEnabled = false;
    target.drawImage(scratch, 0, 0, cols, rows, x + dx, y + dy, w, h);
    target.imageSmoothingEnabled = true;
  }

  function drawPixelated(shape, dx, dy) {
    // Said twice on purpose. drawShape already refuses to make a redaction
    // translucent, and this is the line that would have to be deleted as well
    // before one could be, which is the point of writing it here too.
    ctx.globalAlpha = 1;
    pixelateInto(ctx, shape, dx, dy);
  }

  // THE REDACTED BASE
  //
  // The capture with every redaction already burned in. Only the loupe reads it,
  // and it exists so that magnifying a redacted region cannot un-redact it.
  //
  // Cached, because it is rebuilt from the full size capture and a loupe is
  // redrawn on every frame of a drag. The key is the list of redaction
  // rectangles, so moving, resizing, adding, deleting or undoing a redaction all
  // invalidate it, and nothing else does.
  let redacted = null;
  let redactedKey = '';

  function redactedBase() {
    const marks = doc.present.shapes.filter((shape) => shape.kind === 'pixelate');
    if (marks.length === 0) return base;

    const key = marks.map((s) => `${s.rect.x},${s.rect.y},${s.rect.w},${s.rect.h}`).join('|');
    if (redacted && redactedKey === key) return redacted;

    if (!redacted) {
      redacted = document.createElement('canvas');
      redacted.width = base.width;
      redacted.height = base.height;
    }
    const into = redacted.getContext('2d');
    into.clearRect(0, 0, redacted.width, redacted.height);
    into.drawImage(base, 0, 0);
    for (const mark of marks) pixelateInto(into, mark, 0, 0);
    redactedKey = key;
    return redacted;
  }

  /**
   * Selection outline plus resize handles, drawn on top of everything.
   *
   * Every measurement here is divided by the display scale, so a handle is nine
   * pixels under the pointer whether the capture is shown at 12% or at 400%.
   * Drawing it in canvas pixels, as this used to, made the handles on a long
   * capture one pixel wide and the dashed outline thinner than a pixel, which is
   * to say invisible, even though the hit test compensated and they stayed
   * grabbable. See DECISIONS.md D19.
   */
  /**
   * A quiet outline around the shape the pointer is over.
   *
   * Deliberately lighter than the selection: a solid hairline rather than a
   * dashed box with handles, so the two are never confused. It answers one
   * question, which is "what would I get if I clicked here", and a screenshot
   * dense with annotations is exactly where that question is hard to answer by
   * eye.
   */
  function drawHover(shape, crop) {
    // Chrome is for the person editing, never for the file. `flatten()` drops the
    // selection before it renders, which covered the dashed box and the handles,
    // but nothing cleared the hover, so an export with the pointer resting on a
    // shape baked this outline into the saved PNG and PDF. It went unseen because
    // reaching a toolbar button moves the pointer off the canvas on the way,
    // which fires `pointerleave` and clears the hover; a keyboard export does not.
    // Guarded here rather than at the call site so every future chrome mark
    // inherits it.
    if (hideChrome) return;
    const scale = screenScale();
    ctx.save();
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.55)';
    ctx.lineWidth = 1.5 * scale;
    if (isLine(shape)) {
      // A rectangle around a line is a lie about what is under the pointer: it
      // claims the whole diagonal box, including two large empty corners the
      // click would miss. Trace the segment instead, which is the shape.
      ctx.lineWidth = Math.max(shape.width + 4 * scale, 3 * scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(shape.from.x - crop.x, shape.from.y - crop.y);
      ctx.lineTo(shape.to.x - crop.x, shape.to.y - crop.y);
      ctx.stroke();
    } else {
      const b = boundsOf(shape);
      const pad = 3 * scale;
      ctx.strokeRect(b.x - crop.x - pad, b.y - crop.y - pad, b.w + pad * 2, b.h + pad * 2);
    }
    ctx.restore();
  }

  /**
   * The eraser's reach, drawn where the pointer is.
   *
   * An eraser with no visible edge is a tool you aim by guessing. The radius is
   * `pickTolerance()`, the same number the erase actually uses, so the circle is
   * the tool rather than a decoration near it: if the two ever disagree, the
   * drawing is wrong in a way you can see rather than the behaviour being wrong
   * in a way you cannot.
   *
   * Two strokes, dark over light, because this sits on a photograph of an
   * arbitrary page and a single colour disappears against something.
   */
  function drawEraserRing(point, crop) {
    if (hideChrome) return;
    const scale = screenScale();
    const r = pickTolerance();
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x - crop.x, point.y - crop.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 3 * scale;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.85)';
    ctx.lineWidth = 1.25 * scale;
    ctx.stroke();
    ctx.restore();
  }

  function drawSelection(shape, crop, withHandles) {
    // Belt and braces: `flatten()` also nulls the selection, so this is
    // unreachable today. It stays because "the selection is empty" and "chrome is
    // suppressed" are two different facts, and only one of them is what this
    // function should depend on.
    if (hideChrome) return;
    const scale = screenScale();
    const size = HANDLE_SIZE * scale;

    ctx.save();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5 * scale;

    // A line gets its two endpoints and no box. The dashed rectangle that used
    // to be drawn here connected the endpoints as though the line were a
    // rectangle, which is not what a line is: the box is mostly empty space the
    // shape does not occupy, and on a diagonal arrow it is almost all empty
    // space. The endpoints already say where the shape is and what can be
    // dragged, which is everything the outline was there to say.
    if (!isLine(shape)) {
      const b = boundsOf(shape);
      const pad = 3 * scale;
      ctx.setLineDash(DASH.map((step) => step * scale));
      ctx.strokeRect(b.x - crop.x - pad, b.y - crop.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.setLineDash([]);
    }

    // Handles only when exactly one shape is selected. There are none for a set
    // because scaling a mixed selection means scaling type, stroke widths and
    // counter radii at once, and a group scale that silently changes a stroke
    // width is a different feature with its own decisions. Dashed means "in the
    // selection" whether that is one shape or nine, so nothing new has to be
    // learned to read a multi-selection.
    if (!withHandles) {
      ctx.restore();
      return;
    }

    for (const handle of handlesFor(shape, minEdgeForHandles())) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.rect(handle.x - crop.x - size / 2, handle.y - crop.y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The marquee, alive only while the button is down.
   *
   * The one piece of chrome with a fill. That is deliberate: it is the only mark
   * that describes a region being swept rather than an object that exists, and
   * the translucent wash is what makes it read as a gesture instead of as a
   * rectangle someone drew.
   */
  function drawMarquee(from, to, crop) {
    const rect = normalizeRect(from, to);
    const scale = screenScale();
    ctx.save();
    ctx.fillStyle = 'rgba(99, 102, 241, 0.14)';
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1 * scale;
    ctx.setLineDash([]);
    ctx.fillRect(rect.x - crop.x, rect.y - crop.y, rect.w, rect.h);
    ctx.strokeRect(rect.x - crop.x, rect.y - crop.y, rect.w, rect.h);
    ctx.restore();
  }

  /**
   * The crop region, with everything outside it dimmed.
   *
   * Four bands around the region rather than a full dim and a clearRect: clearing
   * punches a hole through the image as well as the dimming, which is why the
   * version this replaces had to redraw the slice underneath to put it back.
   *
   * Handles and guides are divided by the screen scale (D19), so they stay the
   * same size under the pointer whether the capture is shown at 8% or at 100%.
   */
  function drawCropOverlay(rect, crop, withHandles) {
    const scale = screenScale();
    const x = rect.x - crop.x;
    const y = rect.y - crop.y;
    const right = x + rect.w;
    const bottom = y + rect.h;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, canvas.width, Math.max(0, y));
    ctx.fillRect(0, bottom, canvas.width, Math.max(0, canvas.height - bottom));
    ctx.fillRect(0, y, Math.max(0, x), rect.h);
    ctx.fillRect(right, y, Math.max(0, canvas.width - right), rect.h);

    // Thirds. They are how a person judges a crop and they cost two lines.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    for (let i = 1; i < 3; i += 1) {
      ctx.moveTo(x + (rect.w * i) / 3, y);
      ctx.lineTo(x + (rect.w * i) / 3, bottom);
      ctx.moveTo(x, y + (rect.h * i) / 3);
      ctx.lineTo(right, y + (rect.h * i) / 3);
    }
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * scale;
    ctx.strokeRect(x, y, rect.w, rect.h);

    if (withHandles) {
      const size = HANDLE_SIZE * scale;
      for (const handle of cropHandlesFor(rect)) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.rect(handle.x - crop.x - size / 2, handle.y - crop.y - size / 2, size, size);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function render(preview) {
    if (locked > 0) return;
    const crop = effectiveCrop(doc);
    if (canvas.width !== crop.w || canvas.height !== crop.h) {
      canvas.width = crop.w;
      canvas.height = crop.h;
    }

    ctx.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    for (const shape of doc.present.shapes) {
      if (shape.id !== editingId) drawShape(shape, crop);
    }

    if (preview) {
      if (preview.kind === 'crop') drawCropOverlay(preview.rect, crop, false);
      else drawShape(preview, crop);
    } else if (pendingCrop && !hideChrome) {
      drawCropOverlay(pendingCrop, crop, true);
    }

    if (!preview && !pendingCrop) {
      const chosen = selectedShapes(doc);
      for (const shape of chosen) drawSelection(shape, crop, chosen.length === 1);
    }
    if (drag?.mode === 'marquee' && !hideChrome) drawMarquee(drag.from, drag.to, crop);

    // What a click would pick up, shown before the click. Never on the selected
    // shape, which already has an outline and handles of its own, and never
    // while something is being drawn or a crop is waiting to be answered.
    if (hoverId && !isSelected(doc, hoverId) && !preview && !pendingCrop) {
      const under = doc.present.shapes.find((shape) => shape.id === hoverId);
      if (under) drawHover(under, crop);
    }

    if (tool === 'eraser' && eraserAt && !preview) drawEraserRing(eraserAt, crop);

    notify();
  }

  // INPUT

  function toImage(event) {
    const box = canvas.getBoundingClientRect();
    const crop = effectiveCrop(doc);
    return {
      x: crop.x + ((event.clientX - box.left) / box.width) * crop.w,
      y: crop.y + ((event.clientY - box.top) / box.height) * crop.h,
    };
  }

  /**
   * Slack around a handle, in image pixels. It is the drawn size, so the target
   * matches what the user can see. One helper feeds both, which is the whole
   * point: they used to disagree.
   */
  function pickTolerance() {
    return HANDLE_SIZE * screenScale();
  }

  /**
   * The shortest edge, in image pixels, that can carry the four edge midpoints.
   *
   * A midpoint sits half an edge away from each corner, so the edge needs about
   * three handle widths before the three targets stop overlapping. Like every
   * other measurement about a shape rather than of it, this is in screen terms
   * and converted, because a 100 pixel box is roomy at 100% and cramped at 12%.
   */
  function minEdgeForHandles() {
    return HANDLE_SIZE * 3 * screenScale();
  }

  function buildShape(from, to, shifted) {
    const crop = effectiveCrop(doc);
    const end = shifted && tool !== 'crop' ? constrain(from, to, tool) : to;

    if (tool === 'crop') {
      return { kind: 'crop', rect: clampRect(normalizeRect(from, end), crop) };
    }
    if (BOX_TOOLS.includes(tool)) {
      const shape = {
        id: newId(),
        // Rounded and Stadium are the Box with its corner already chosen, so
        // what gets drawn is a `rect`. Nothing downstream has to learn a kind.
        kind: kindOfTool(tool),
        rect: clampRect(normalizeRect(from, end), crop),
        colour,
        strokeOpacity,
        width,
      };
      // Only the outlined boxes take a fill. A highlighter is already a fill, a
      // redaction has to stay opaque to be a redaction, and a loupe shows what
      // is underneath it.
      if (FILLABLE_TOOLS.includes(tool)) {
        shape.dash = dash;
        if (fill) {
          shape.fill = fill;
          shape.fillOpacity = fillOpacity;
        }
      }
      if (CORNERED_KINDS.includes(kindOfTool(tool)) && corner > 0) shape.corner = corner;
      return shape;
    }
    return {
      id: newId(), kind: kindOfTool(tool), from, to: end, colour, strokeOpacity, width, dash, ends,
    };
  }

  function applyTool(next) {
    // Leaving the crop tool abandons a region that was never confirmed. Keeping
    // it would leave the image dimmed under a tool that cannot act on it.
    if (next !== 'crop') pendingCrop = null;
    tool = next;
    // Leaving the selection tool drops the selection: the handles belong to it,
    // and leaving them drawn under a drawing tool invites clicking them.
    if (next !== 'select') doc = amend(doc, { ...doc.present, selection: [] });
    // The eraser draws its own reach as a ring, so the pointer itself gets out of
    // the way: a crosshair inside the circle is two aiming marks for one tool.
    if (next !== 'eraser') eraserAt = null;
    canvas.style.cursor =
      next === 'select' ? 'default'
        : next === 'text' ? 'text'
          : next === 'eraser' ? 'none'
            : 'crosshair';
    render();
  }

  /**
   * Picking a tool, as an act by the user rather than by the editor.
   *
   * Arrow and line are one shape drawn two ways, and the toolbar stores that fact
   * twice: once as the tool, and once as the arrowheads in the stroke style. They
   * drift. Draw an arrow, take its head off from the stroke panel, then come back
   * and pick Arrow from the Shapes menu: the tool says arrow, the ends still say
   * none, and what gets drawn is a line. The reader asked for an arrow, in the
   * clearest way the interface offers, and got the opposite.
   *
   * So whichever of the two was touched last wins and the other follows. Choosing
   * Arrow puts a head back on if there is none, and choosing Line takes them off.
   * Choosing Arrow when the ends are already start or both leaves them alone: that
   * is still an arrow, and it is a preference the reader set on purpose.
   *
   * `applyTool` stays private for the editor's own moves, such as handing back to
   * the selection tool, which must not restyle anything.
   */
  function chooseTool(next) {
    if (next === 'arrow' && ends === 'none') ends = 'end';
    else if (next === 'line') ends = 'none';
    // Picking Rounded or Stadium is a statement about the corner radius, in the
    // same way that picking Line is a statement about the arrowheads. It is set
    // here rather than at draw time so the corner row in the Stroke popover
    // agrees with the tool the moment the tool is picked, and so that changing
    // it afterwards is still the reader's last word.
    const preset = TOOL_PRESETS[next];
    if (preset) corner = preset.corner;
    applyTool(next);
  }

  /**
   * Hand the finished object back to the user.
   *
   * This is the general convention in drawing and annotation tools: finishing a
   * shape returns to the selection tool with the new shape selected, so it can be
   * moved, resized or restyled without a detour through the toolbar. Staying in
   * the drawing tool means the next click, which is almost always aimed at the
   * thing just drawn, draws a second shape instead.
   *
   * Numbered steps are the exception, on purpose. Their whole point is 1, 2, 3 in
   * sequence, and making someone re-pick the tool between each number would be
   * worse rather than more consistent.
   */
  function handBackToSelection() {
    if (tool === 'counter') return;
    applyTool('select');
  }

  function placePoint(at) {
    if (tool === 'counter') {
      return {
        id: newId(),
        kind: 'counter',
        at,
        radius: counterRadius ?? Math.max(12, width * 4),
        number: nextCounterNumber(doc.present.shapes),
        colour,
        width,
      };
    }
    return null;
  }

  /**
   * Double click a text shape to edit its words.
   *
   * Restyling an existing text shape already worked; changing what it said meant
   * deleting it and typing again. `dblclick` rather than a second pointerdown,
   * because the browser already tracks what counts as a double click and doing
   * it by hand means inventing a timing threshold that will be wrong somewhere.
   */
  canvas.addEventListener('dblclick', (event) => {
    if (editing || pendingCrop) return;
    // Select only. With the text tool live, the first click of a double click has
    // already opened a new box, so re-editing there would fight itself. Finishing
    // a box hands the toolbar back to select anyway, which is where you already
    // are the moment you might want to change what you just typed.
    if (tool !== 'select') return;
    const hit = shapeAt(doc.present.shapes, toImage(event), pickTolerance());
    if (!hit || hit.kind !== 'text') return;
    event.preventDefault();
    startTextEntry(hit.at, hit);
  });

  /**
   * Say what a click would do, before it does it.
   *
   * The cursor is the cheapest affordance a canvas has, and until now it changed
   * only when the tool changed: every shape on the image looked exactly as
   * clickable as the empty pixels beside it. Three answers, in the order the
   * click itself would resolve them.
   *
   * A handle shows the axis it travels on, which is the one thing a resize cursor
   * is for. The body of a shape shows `move`, not the open hand: the hand means
   * "drag the view", which is what it will mean here the day the canvas can be
   * panned (F6), and having it mean two things would make it mean neither.
   * Everywhere else keeps the tool's own cursor.
   */
  function hover(event) {
    const at = toImage(event);

    if (tool === 'crop' && pendingCrop) {
      const handle = cropHandleAt(pendingCrop, at, pickTolerance());
      canvas.style.cursor = handle
        ? handleCursor(handle)
        : insideRect(pendingCrop, at) ? 'move' : 'crosshair';
      return;
    }

    // Only the selection tool picks things up, so only it should suggest that it
    // will. Under a drawing tool the crosshair is the honest answer: a drag there
    // draws a new shape whatever is underneath.
    if (tool !== 'select') {
      setHover(null);
      return;
    }

    const chosen = selectedShape(doc);
    const handle = chosen ? handleAt(chosen, at, pickTolerance(), minEdgeForHandles()) : null;
    if (handle) {
      canvas.style.cursor = handleCursor(handle);
      setHover(null);
      return;
    }

    const under = shapeAt(doc.present.shapes, at, pickTolerance());
    canvas.style.cursor = under ? 'move' : 'default';
    setHover(under ? under.id : null);
  }

  /** Repaint only when the answer changed. Every pointermove would be wasteful. */
  function setHover(id) {
    if (hoverId === id) return;
    hoverId = id;
    render();
  }

  // A pointer that leaves the canvas has nothing under it, and an outline left
  // behind would claim otherwise.
  canvas.addEventListener('pointerleave', () => {
    setHover(null);
    // The ring is where the pointer is, so with the pointer gone there is
    // nowhere for it to be. Left behind it reads as a shape on the picture.
    if (eraserAt) {
      eraserAt = null;
      render();
    }
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || editing) return;
    canvas.setPointerCapture(event.pointerId);
    const point = toImage(event);

    // A pending crop owns the canvas while it exists: a handle resizes it, the
    // inside slides it, and anywhere outside starts a new one, which is what
    // every crop tool does and what stops the region becoming a trap.
    if (tool === 'crop' && pendingCrop) {
      const handle = cropHandleAt(pendingCrop, point, pickTolerance());
      if (handle) {
        drag = { mode: 'crop-resize', handle };
        return;
      }
      if (insideRect(pendingCrop, point)) {
        drag = { mode: 'crop-move', from: point, rect: pendingCrop };
        return;
      }
    }

    if (tool === 'select') {
      const chosen = selectedShape(doc);
      const handle = chosen ? handleAt(chosen, point, pickTolerance(), minEdgeForHandles()) : null;

      if (handle) {
        drag = { mode: 'resize', handle, shape: chosen, before: doc.present };
        return;
      }

      const hit = shapeAt(doc.present.shapes, point, pickTolerance());

      if (!hit) {
        // Empty canvas with the select tool starts a marquee. Shift keeps what
        // is already selected, so a set can be built up in several sweeps.
        if (!event.shiftKey) doc = amend(doc, { ...doc.present, selection: [] });
        drag = {
          mode: 'marquee',
          from: point,
          to: point,
          base: event.shiftKey ? selectedIds(doc) : [],
          before: doc.present,
        };
        render();
        return;
      }

      if (event.shiftKey) {
        // Shift click adds or removes, and never starts a drag: a click that
        // both changed the set and moved it would be very hard to undo.
        doc = amend(doc, {
          ...doc.present,
          selection: toggleSelected(selectedIds(doc), hit.id),
        });
        drag = null;
        render();
        return;
      }

      // Clicking a shape that is already part of a multi-selection keeps the
      // set and moves all of it. Clicking outside the set replaces it. Without
      // that first rule, dragging a group by one of its members would collapse
      // the selection to that member on pointerdown and move only it.
      if (!isSelected(doc, hit.id)) {
        doc = amend(doc, { ...doc.present, selection: [hit.id] });
      }

      const moving = selectedIds(doc);
      drag = {
        mode: 'move',
        shape: hit,
        ids: moving,
        last: point,
        origin: point,
        duplicated: false,
        before: doc.present,
      };
      render();
      return;
    }

    if (POINT_TOOLS.includes(tool)) {
      if (tool === 'text') {
        // The browser's own mousedown handling runs after this listener and moves
        // focus to whatever was clicked. Left alone it takes focus straight back
        // off the box we are about to create, which fires its blur, which commits
        // an empty value and removes it again. From the outside the text tool
        // simply does nothing.
        event.preventDefault();
        startTextEntry(point);
        return;
      }
      const shape = placePoint(point);
      if (shape) {
        doc = commit(doc, {
          ...doc.present,
          shapes: [...doc.present.shapes, shape],
          selection: [shape.id],
        });
        render();
      }
      return;
    }

    if (PATH_TOOLS.includes(tool)) {
      // Thinned at the source. A pointer reports moves far faster than anybody
      // draws, and keeping every one of them would put thousands of points in a
      // shape that reads as smooth at a few dozen.
      drag = { mode: 'pen', points: [[point.x, point.y]] };
      render(penShape(drag.points));
      return;
    }

    if (tool === 'eraser') {
      // One commit for the whole drag, not one per shape. The same rule the
      // arrow keys already follow: a burst of removals is one thing the reader
      // did, so one press of undo has to put all of it back.
      drag = { mode: 'erase', before: doc.present, removed: 0 };
      eraseAt(point);
      return;
    }

    drag = { mode: 'draw', from: point };
  });

  /** The stroke as it stands, for the preview and for the commit. */
  function penShape(points) {
    return {
      id: 'pen-preview',
      kind: 'pen',
      points,
      colour,
      width,
      dash,
      strokeOpacity,
    };
  }

  /** Delete whatever is under the pointer. Idempotent: crossing twice is once. */
  function eraseAt(point) {
    const found = shapeAt(doc.present.shapes, point, pickTolerance());
    if (!found) return;
    doc = amend(doc, {
      ...doc.present,
      shapes: doc.present.shapes.filter((sh) => sh.id !== found.id),
      selection: [],
    });
    drag.removed += 1;
    render();
  }

  canvas.addEventListener('pointermove', (event) => {
    if (tool === 'eraser') {
      eraserAt = toImage(event);
      if (!drag) render();
    }
    if (!drag) {
      hover(event);
      return;
    }
    const point = toImage(event);

    if (drag.mode === 'crop-resize') {
      pendingCrop = resizeCrop(pendingCrop, drag.handle, point, effectiveCrop(doc));
      render();
      return;
    }

    if (drag.mode === 'crop-move') {
      // Measured from where the drag started, not from the last event, so a drag
      // that pushes against the edge and comes back does not leave the region
      // trailing the pointer by however far it was clamped.
      pendingCrop = moveCrop(
        drag.rect, point.x - drag.from.x, point.y - drag.from.y, effectiveCrop(doc),
      );
      render();
      return;
    }

    if (drag.mode === 'pen') {
      const last = drag.points[drag.points.length - 1];
      // Shift straightens, the way it constrains every other drag here: the
      // stroke becomes the line from where it started to where the pointer is.
      if (event.shiftKey) {
        drag.points = [drag.points[0], [point.x, point.y]];
        render(penShape(drag.points));
        return;
      }
      // A sample closer than this to the last kept one describes no new part of
      // the line. Dropping it here rather than at the end is what keeps the
      // in-progress array small on a long slow stroke.
      if (Math.hypot(point.x - last[0], point.y - last[1]) >= PEN_SAMPLE_GAP) {
        drag.points = [...drag.points, [point.x, point.y]];
      }
      render(penShape(drag.points));
      return;
    }

    if (drag.mode === 'erase') {
      eraseAt(point);
      return;
    }

    if (drag.mode === 'draw') {
      drag.to = point;
      render(buildShape(drag.from, point, event.shiftKey));
      return;
    }

    if (drag.mode === 'move') {
      // Alt duplicates. The copy is made on the first move rather than on the
      // press, so an Alt click that never travels does not litter the document
      // with a shape sitting exactly on top of another one.
      if (event.altKey && !drag.duplicated) {
        const copies = selectedShapes(doc).map((shape) => ({ ...shape, id: newId() }));
        doc = amend(doc, {
          ...doc.present,
          shapes: [...doc.present.shapes, ...copies],
          selection: copies.map((c) => c.id),
        });
        drag.ids = copies.map((c) => c.id);
        drag.duplicated = true;
        // Carry on dragging the copy, leaving the original where it was, which
        // is what every editor that offers this does.
        drag.shape = copies.find((c) => c.kind === drag.shape.kind) ?? copies[0];
      }
      const dx = point.x - drag.last.x;
      const dy = point.y - drag.last.y;
      drag.last = point;
      doc = amend(doc, moveShapes(doc.present, drag.ids, dx, dy));
      drag.shape = doc.present.shapes.find((sh) => sh.id === drag.shape.id) ?? drag.shape;
      render();
      return;
    }

    if (drag.mode === 'marquee') {
      drag.to = point;
      const rect = normalizeRect(drag.from, drag.to);
      const caught = shapesInMarquee(doc.present.shapes, rect);
      doc = amend(doc, {
        ...doc.present,
        selection: [...new Set([...drag.base, ...caught])],
      });
      render();
      return;
    }

    if (drag.mode === 'resize') {
      // Shift constrains, exactly as it already does while drawing. The helper
      // for it has existed since the beginning and was wired only to buildShape,
      // so the resize path never saw the modifier at all.
      //
      // A corner handle squares a box and steps a line to 45 degrees. An edge
      // handle moves one edge along one axis, which is already constrained, and
      // a text corner drag is proportional by construction, so both ignore it.
      const target = event.shiftKey && CORNER_HANDLES.includes(drag.handle) && drag.shape.kind !== 'text'
        ? constrain(anchorFor(drag.shape, drag.handle), point, drag.shape.kind)
        : point;
      const resized = resizeShape(drag.shape, drag.handle, target);
      // Scaling text changes the point size, and only the canvas knows how wide
      // the words are at the new size. `resizeShape` scales the old box as an
      // estimate; this replaces the estimate with the measurement, so the
      // selection outline and the handles track the glyphs rather than drifting
      // a little further from them with every frame of the drag.
      doc = amend(doc, replaceShape(
        doc.present,
        resized.kind === 'text' ? remeasure(resized) : resized,
      ));
      render();
    }
  });

  /** The corner a resize pivots about, which is the one opposite the handle. */
  function anchorFor(shape, handleId) {
    const b = boundsOf(shape);
    return {
      nw: { x: b.x + b.w, y: b.y + b.h },
      ne: { x: b.x, y: b.y + b.h },
      se: { x: b.x, y: b.y },
      sw: { x: b.x + b.w, y: b.y },
    }[handleId] ?? { x: b.x, y: b.y };
  }

  function endDrag(event) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    hoverId = null;

    if (finished.mode === 'pen') {
      // Simplified once, when the stroke ends, rather than on every sample:
      // running it live would fight the thinning above and cost work on a shape
      // that is about to change again anyway.
      const points = simplifyPath(finished.points, PEN_TOLERANCE);
      doc = commit(doc, {
        ...doc.present,
        shapes: [...doc.present.shapes, { ...penShape(points), id: newId() }],
        selection: [],
      });
      render();
      return;
    }

    if (finished.mode === 'erase') {
      // Nothing was under the pointer for the whole drag, so there is nothing
      // to undo and no step worth putting on the stack.
      if (finished.removed === 0) {
        render();
        return;
      }
      // One step for the drag. `commit` is given the state as it was before the
      // drag started, so the whole burst collapses into a single undo.
      const after = doc.present;
      doc = commit({ ...doc, present: finished.before }, after);
      render();
      return;
    }

    if (finished.mode === 'draw') {
      const to = finished.to ?? toImage(event);
      const shape = buildShape(finished.from, to, event.shiftKey);
      const usable =
        shape.kind === 'crop' ? isUsableCrop(shape.rect) : isUsableDrag(finished.from, to);

      if (!usable) {
        render();
        return;
      }

      if (shape.kind === 'crop') {
        // Drawn, not applied. The confirm bar in result.js is what applies it.
        pendingCrop = shape.rect;
        render();
        return;
      }

      doc = commit(doc, {
        ...doc.present,
        shapes: [...doc.present.shapes, shape],
        selection: [shape.id],
      });
      handBackToSelection();
      render();
      return;
    }

    // Adjusting a pending crop is not an edit, so it leaves no undo step behind.
    if (finished.mode === 'crop-resize' || finished.mode === 'crop-move') {
      render();
      return;
    }

    // Nor is changing what is selected. A marquee moved nothing and drew
    // nothing; it only decided what the next command will act on.
    if (finished.mode === 'marquee') {
      render();
      return;
    }

    // A move or resize became final: make the state before it undoable.
    //
    // Unless nothing actually moved. Selecting a shape is a press and a release
    // on it, which is a move drag of zero distance, so every click on the canvas
    // was pushing an undo step that undid nothing visible. Click three shapes and
    // the next three presses of Cmd+Z appear to do nothing at all, which reads as
    // undo being broken rather than as the history being full of no-ops.
    if (!selectionChanged(finished.before, doc.present, finished.ids ?? [finished.shape?.id])) {
      render();
      return;
    }
    doc = { ...doc, past: [...doc.past, finished.before].slice(-60), future: [] };
    render();
  }

  /**
   * Did the drag leave the shape any different?
   *
   * Shapes are plain data, so comparing their serialisations is both correct and
   * obvious. It runs once per pointerup on one small object, which is nowhere
   * near often enough to be worth anything cleverer.
   */
  function selectionChanged(before, after, ids) {
    const wanted = (ids ?? []).filter(Boolean);
    if (wanted.length === 0) return true;
    // Alt duplicating adds shapes, which is a change however little anything
    // moved, so a difference in the count settles it before any comparison.
    if (before.shapes.length !== after.shapes.length) return true;
    const find = (present, id) => present.shapes.find((shape) => shape.id === id);
    return wanted.some((id) => JSON.stringify(find(before, id)) !== JSON.stringify(find(after, id)));
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => {
    drag = null;
    render();
  });

  // TEXT ENTRY

  /** Re-measure a text shape against the real canvas. Only it knows the width. */
  function remeasure(shape) {
    ctx.save();
    ctx.font = fontOf(shape);
    const box = measureText(shape, (line) => ctx.measureText(line).width);
    ctx.restore();
    return { ...shape, ...box };
  }

  /**
   * The inline text box.
   *
   * A `textarea`, not an `input`, so a caption can be more than one line. That
   * changes what Enter means: it inserts a newline, and the box is committed by
   * clicking away or by pressing Escape. Escape finishing rather than abandoning
   * is the convention in every canvas editor that has multi-line text, for the
   * plain reason that Enter is no longer available to do it. Nothing is lost by
   * it either: a commit is one undo step, and an empty box commits nothing.
   *
   * @param {{x:number, y:number}} at where the block's top left corner sits
   * @param {object} [existing] a text shape being re-edited, replaced on commit
   */
  function startTextEntry(at, existing) {
    const box = canvas.getBoundingClientRect();
    const crop = effectiveCrop(doc);
    const shown = box.width / crop.w;
    const style = existing
      ? {
        size: existing.size,
        family: existing.family ?? text.family,
        bold: existing.bold !== false,
        italic: existing.italic === true,
        underline: existing.underline === true,
        align: alignOf(existing),
        ink: inkOf(existing),
        colour: existing.colour ?? null,
        strokeOpacity: existing.strokeOpacity ?? text.strokeOpacity,
        fill: existing.fill ?? null,
        fillOpacity: existing.fillOpacity,
        inkOpacity: existing.inkOpacity ?? text.inkOpacity,
        wrap: wrapOf(existing) || undefined,
        width: existing.width ?? text.width,
      }
      : { ...text };
    const size = style.size;

    const input = document.createElement('textarea');
    input.className = 'text-entry';
    input.rows = 1;
    input.spellcheck = false;
    input.value = existing ? String(existing.text) : '';
    input.style.left = `${box.left + window.scrollX + (at.x - crop.x) * shown}px`;
    input.style.top = `${box.top + window.scrollY + (at.y - crop.y) * shown}px`;
    // What is typed should look like what will be drawn, so the entry box takes
    // the same family, weight, slant and alignment, scaled to however the canvas
    // is shown. `justify` is a real CSS value, so the preview holds there too.
    input.style.font = fontOf({ ...style, size: Math.max(12, size * shown) });
    input.style.lineHeight = String(TEXT_LINE_RATIO);
    input.style.textAlign = style.align;
    // What is typed should look like what will be drawn, which is the property
    // this whole function exists to hold. With a wrap that means the same width
    // and the same breaking, so `pre` becomes `pre-wrap`.
    const wrap = wrapOf(style);
    if (wrap) {
      input.style.width = `${Math.max(40, wrap * shown)}px`;
      input.style.whiteSpace = 'pre-wrap';
      input.style.minWidth = '0';
    }
    // The glyph colour, not the frame colour: the box you type into should
    // look like the words it will become.
    input.style.color = style.ink;
    if (style.underline) input.style.textDecoration = 'underline';
    document.body.append(input);

    // Grow with the content. A textarea does not do this on its own, and a box
    // that hides the line you are typing is worse than the single line it
    // replaced. Height is reset first so deleting a line shrinks it back.
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    };
    grow();

    editing = input;
    // The shape being re-edited is hidden while its own text sits over it, so
    // the reader is not looking at two copies half a pixel apart.
    editingId = existing ? existing.id : null;
    if (editingId) render();

    // Focus on the next frame, once the browser has finished its own handling of
    // the click that created this. Focusing inside the same task is what let the
    // default action take focus away again.
    let focused = false;
    requestAnimationFrame(() => {
      focused = true;
      input.focus();
      input.select();
    });

    const finish = () => {
      if (!editing) return;
      editing = null;
      editingId = null;
      // Trailing blank lines are almost always a stray Enter, and they would
      // silently inflate the block's height and therefore its selection box.
      const value = input.value.replace(/\s+$/, '');
      input.remove();

      // Nothing typed. For a new box that means no shape, and for one being
      // re-edited it means the reader emptied it, which is a delete.
      if (!value) {
        if (existing) {
          doc = commit(doc, removeShape(doc.present, existing.id));
          handBackToSelection();
        }
        render();
        return;
      }

      const shape = remeasure({
        ...(existing ?? {}),
        id: existing ? existing.id : newId(),
        kind: 'text',
        at,
        text: value,
        size,
        ink: style.ink,
        inkOpacity: style.inkOpacity ?? 1,
        // Only ever carried, never invented. A new caption has no width until
        // someone drags a side handle to give it one.
        ...(style.wrap ? { wrap: style.wrap } : {}),
        colour: style.colour,
        strokeOpacity: style.strokeOpacity ?? 1,
        fill: style.fill,
        fillOpacity: style.fillOpacity ?? fillOpacity,
        // The frame's thickness, not the stroke width arrows and boxes share.
        width: style.width ?? width,
        family: style.family,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        align: style.align,
      });

      doc = commit(doc, existing
        ? { ...replaceShape(doc.present, shape), selection: [shape.id] }
        : { ...doc.present, shapes: [...doc.present.shapes, shape], selection: [shape.id] });
      handBackToSelection();
      render();
    };

    input.addEventListener('input', grow);
    // A blur before the box has been focused is the browser settling the click,
    // not the user leaving. Committing there would delete the box immediately.
    input.addEventListener('blur', () => {
      if (focused) finish();
    });
    input.addEventListener('keydown', (event) => {
      // Enter is a newline now. Escape finishes, and so does the accelerator
      // people reach for out of habit from single line boxes.
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        finish();
      }
      event.stopPropagation();
    });
  }

  // API

  /**
   * Apply a style patch to everything selected.
   *
   * `applies` decides, per shape, whether the patch means anything for it. A
   * counter has no dash and a highlighter has no stroke width, and a mixed
   * selection should leave those members alone rather than giving them a
   * property they never read. Callers that already know the patch is universal,
   * such as a colour, pass nothing.
   */
  function restyleSelection(patch, applies = null) {
    const chosen = selectedShapes(doc);
    const targets = applies ? chosen.filter(applies) : chosen;
    if (targets.length === 0) return false;
    let present = doc.present;
    for (const shape of targets) present = replaceShape(present, { ...shape, ...patch });
    doc = commit(doc, present);
    render();
    return true;
  }

  /**
   * What the toolbar glyphs should show. A selected shape wins over the pending
   * style, because the buttons act on it. It is the usual rule in an inspector:
   * the border swatch shows the selected object's border, not the last one set.
   */
  /**
   * The value every shape in a set agrees on, or undefined when they differ.
   *
   * Members that do not carry the property at all are skipped rather than
   * counted as disagreeing: a highlighter has no dash, and a set containing one
   * should still show the dash the other members share.
   */
  function agreed(shapes, read) {
    let found;
    let seen = false;
    for (const shape of shapes) {
      const value = read(shape);
      if (value === undefined || value === null) continue;
      if (!seen) {
        found = value;
        seen = true;
      } else if (value !== found) {
        return undefined;
      }
    }
    return seen ? found : undefined;
  }

  /** The diameter the next numbered step will be drawn at, in image pixels. */
  function counterSize() {
    return (counterRadius ?? Math.max(12, width * 4)) * 2;
  }

  function currentStyle() {
    const chosen = selectedShape(doc);
    if (!chosen) {
      const many = selectedShapes(doc);
      // With several selected there is no single answer, so the rule is: show
      // the value where every member agrees, and fall back to the pending style
      // where they do not. Never blank and never an indeterminate state,
      // because the swatch is also the control that SETS the value, and a
      // control showing nothing is a control you cannot predict.
      return {
        colour: agreed(many, (sh) => sh.colour) ?? colour,
        width: agreed(many, (sh) => sh.width) ?? width,
        dash: agreed(many, (sh) => (sh.dash === undefined ? undefined : dashOf(sh))) ?? dash,
        ends: agreed(many, (sh) => (sh.ends === undefined ? undefined : endsOf(sh))) ?? ends,
        corner: agreed(many, (sh) => sh.corner) ?? corner,
        // Fill is the exception to `agreed` skipping empty values: null here
        // means "no fill", which is a choice rather than an absence, so a set
        // of one filled and one unfilled shape DISAGREES and must fall back.
        // Letting `agreed` skip the null would have reported the filled one's
        // colour and put it in a swatch that also sets the value.
        fill: many.length > 0
          ? (many.every((sh) => fillOf(sh) === fillOf(many[0])) ? fillOf(many[0]) : fill)
          : fill,
        fillOpacity: agreed(many, (sh) => sh.fillOpacity) ?? fillOpacity,
        strokeOpacity: agreed(many, (sh) => sh.strokeOpacity) ?? strokeOpacity,
        selectedKind: agreed(many, (sh) => sh.kind) ?? null,
        counterSize: (agreed(many, (sh) => (sh.kind === 'counter' ? sh.radius : undefined)) ?? 0) * 2
          || counterSize(),
        text: { ...text },
      };
    }
    return {
      colour: chosen.colour ?? colour,
      width: chosen.width ?? width,
      dash: dashOf(chosen),
      ends: chosen.kind === 'arrow' || chosen.kind === 'line' ? endsOf(chosen) : ends,
      corner: CORNERED_KINDS.includes(chosen.kind) ? cornerOf(chosen) : corner,
      // Which kind is selected, so the toolbar can grey out a control that
      // means nothing for it without reaching into the document.
      selectedKind: chosen.kind,
      counterSize: chosen.kind === 'counter' ? chosen.radius * 2 : counterSize(),
      fill: fillOf(chosen),
      fillOpacity: fillOf(chosen) ? fillAlphaOf(chosen) : fillOpacity,
      strokeOpacity: strokeAlphaOf(chosen),
      text: chosen.kind === 'text'
        ? {
          size: chosen.size,
          family: chosen.family ?? text.family,
          bold: chosen.bold !== false,
          italic: chosen.italic === true,
          underline: chosen.underline === true,
          align: alignOf(chosen),
          ink: inkOf(chosen),
          inkOpacity: inkAlphaOf(chosen),
          // The frame and the plate, read off the shape rather than off the
          // pending style, for the same reason every other swatch does it: the
          // control that shows a value is also the control that sets it.
          colour: strokeOf(chosen),
          strokeOpacity: strokeAlphaOf(chosen),
          // The plate keeps a colour even at zero opacity, so the slider on its
          // own is enough to bring it back. Falling back to the pending colour
          // rather than to null is what makes that true for a caption drawn
          // before the plate had a colour of its own.
          fill: fillOf(chosen) ?? text.fill,
          fillOpacity: fillOf(chosen) ? fillAlphaOf(chosen) : 0,
          width: chosen.width ?? text.width,
        }
        : { ...text },
    };
  }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  return {
    render: () => render(),
    /**
     * Abandon a drag that is under way, putting the shape back where it started.
     *
     * A move or a resize is committed on pointerup, so until then the shape is
     * only amended and the state before it is still in `drag.before`. Escape is
     * the universal "I did not mean this" and there was no way to say it: the
     * only exit from a misjudged drag was to finish it and then undo.
     *
     * @returns {boolean} whether there was anything to cancel
     */
    cancelDrag() {
      if (!drag) return false;
      const finished = drag;
      drag = null;
      hoverId = null;
      if (finished.mode === 'move' || finished.mode === 'resize' || finished.mode === 'marquee') {
        doc = amend(doc, finished.before);
      }
      render();
      return true;
    },
    setTool: chooseTool,
    setColour(next) {
      colour = next;
      restyleSelection({ colour: next });
      notify();
    },
    setWidth(next) {
      width = clamp(Math.round(next), MIN_STROKE, MAX_STROKE);
      restyleSelection({ width });
      notify();
    },
    /**
     * The size of a numbered step, as a diameter in image pixels.
     *
     * A step was sized from the stroke width and nothing else, so it could only
     * be made bigger by drawing thicker lines, and once placed it could not be
     * changed at all. Corner handles came first; this is the number, for the
     * reader who wants the same size twice rather than the same size roughly.
     *
     * Applies to every selected step and becomes the size of the next one, which
     * is the rule every other control in this toolbar follows.
     */
    setCounterSize(next) {
      const radius = clamp(Math.round(next / 2), MIN_COUNTER_RADIUS, MAX_COUNTER_RADIUS);
      counterRadius = radius;
      restyleSelection({ radius }, (shape) => shape.kind === 'counter');
      render();
      notify();
    },
    setDash(next) {
      dash = next;
      restyleSelection({ dash: next });
      notify();
    },
    setEnds(next) {
      ends = next;
      // The other half of the reconciliation in chooseTool. Taking the heads off
      // means the reader is drawing lines, and putting one back means arrows, so
      // the tool follows and the Shapes glyph never disagrees with what the next
      // drag will actually draw.
      //
      // Assigned rather than pushed through applyTool: that drops the selection,
      // and the shape being restyled two lines below is exactly the selection.
      // Arrow and line share a cursor and neither touches a pending crop, so
      // there is nothing else for applyTool to do here.
      if (tool === 'arrow' && next === 'none') tool = 'line';
      else if (tool === 'line' && next !== 'none') tool = 'arrow';

      // Only a line carries ends. Setting it with a box selected changes what
      // the next line will look like and leaves the box alone.
      restyleSelection({ ends: next }, (shape) => shape.kind === 'arrow' || shape.kind === 'line');
      render();
      notify();
    },
    /**
     * Corner radius, in image pixels. Zero is square.
     *
     * A property rather than three tools. Rounded rectangle and stadium were
     * going to be two more entries in a popover that is already twelve, and at
     * nineteen pixels a square corner and a 1.5 pixel radius are the same
     * picture, so the icons would have been indistinguishable from the Box.
     */
    setCorner(next) {
      corner = Math.max(0, Number(next) || 0);
      restyleSelection({ corner }, (shape) => CORNERED_KINDS.includes(shape.kind));
      render();
      notify();
    },
    /** `null` means no fill, which is a value rather than an absence. */
    setFill(next) {
      fill = next;
      // Text is fillable too: the fill is the plate behind the words, which is
      // what makes a caption readable over a busy screenshot.
      restyleSelection(
        next ? { fill: next, fillOpacity } : { fill: null },
        (shape) => FILLABLE_TOOLS.includes(shape.kind) || shape.kind === 'text',
      );
      notify();
    },
    setFillOpacity(next) {
      fillOpacity = clamp(next, 0, 1);
      const chosen = selectedShape(doc);
      restyleSelection({ fillOpacity }, (shape) => fillOf(shape) !== null);
      notify();
    },
    /**
     * How solid the stroke is, on everything that has one.
     *
     * A redaction is excluded, and that is not tidiness. Every other shape here
     * is a mark drawn over the picture, and this one exists to remove part of
     * the picture: an opacity it could take would be a way to read through it.
     */
    setStrokeOpacity(next) {
      strokeOpacity = clamp(next, 0, 1);
      restyleSelection({ strokeOpacity }, (shape) => shape.kind !== 'pixelate');
      notify();
    },
    setTextStyle(patch) {
      if (Number.isFinite(patch.size)) {
        patch.size = clamp(Math.round(patch.size), MIN_TEXT_SIZE, MAX_TEXT_SIZE);
      }
      for (const key of ['inkOpacity', 'strokeOpacity', 'fillOpacity']) {
        if (Number.isFinite(patch[key])) patch = { ...patch, [key]: clamp(patch[key], 0, 1) };
      }
      // A plate with no colour cannot be brought back by its own slider, and
      // asking for one is what raising that slider means. So it takes the colour
      // the well beside it is already showing, which is the colour the reader
      // would have got if they had picked one first.
      if (Number.isFinite(patch.fillOpacity) && patch.fillOpacity > 0) {
        const selected = selectedShape(doc);
        const has = selected && selected.kind === 'text' ? fillOf(selected) : text.fill;
        if (!has) patch = { ...patch, fill: text.fill ?? '#ffffff' };
      }
      text = { ...text, ...patch };
      const chosen = selectedShape(doc);
      if (chosen && chosen.kind === 'text') {
        // The stored box is what hit testing, the selection outline and the
        // resize handles all read, so it is re-measured whenever anything about
        // the type changes, the words included.
        doc = commit(doc, replaceShape(doc.present, remeasure({ ...chosen, ...patch })));
        render();
      }
      notify();
    },
    /**
     * Move the selection through the paint order.
     *
     * One undo step, however many shapes moved, because history is whole
     * document snapshots. Returns false when nothing could move, which is what
     * keeps a menu item that is already at the front from writing an undo step
     * that undoes nothing.
     *
     * @param {'front'|'back'|'forward'|'backward'} where
     */
    reorder(where) {
      const ids = selectedIds(doc);
      if (ids.length === 0) return false;
      if (!wouldReorder(doc.present, ids, where)) return false;
      doc = commit(doc, reorderShapes(doc.present, ids, where));
      render();
      notify();
      return true;
    },
    /**
     * What a right click is aimed at.
     *
     * A right click on a shape that is not selected selects it, which is what
     * every editor does: the menu that follows has to act on what the pointer
     * is over, not on whatever happened to be selected before. A right click on
     * a shape that is already part of a selection leaves the whole selection
     * alone, so a menu can act on all of it.
     *
     * A click on empty canvas is not a target at all, and the caller lets the
     * browser's own menu through there. Chrome offers "Save image as" on a
     * canvas, and taking that away to show a menu with everything disabled
     * would be a straight loss.
     *
     * @returns {boolean} whether there is now something for a menu to act on
     */
    menuTarget(event) {
      if (editing || pendingCrop) return false;
      const hit = shapeAt(doc.present.shapes, toImage(event), pickTolerance());
      if (!hit) return false;
      if (!isSelected(doc, hit.id)) {
        // The selection tool owns the handles, so a menu that offers to move a
        // shape has to leave the reader able to grab it afterwards.
        chooseTool('select');
        doc = amend(doc, { ...doc.present, selection: [hit.id] });
        render();
        notify();
      }
      return true;
    },
    deleteSelection() {
      const ids = selectedIds(doc);
      if (ids.length === 0) return false;
      // One step, however many shapes. History is whole document snapshots, so
      // this needs no new machinery to be atomic.
      doc = commit(doc, removeShapes(doc.present, ids));
      render();
      return true;
    },
    /**
     * Move the selection with the arrow keys.
     *
     * One undo step per burst, not per key press. Holding an arrow key fires
     * `keydown` at the operating system's repeat rate, and one step per repeat
     * would mean thirty presses of undo to put back a nudge that took a second.
     * The burst is closed by `endNudge`, which the key release calls.
     *
     * This is also the first real progress on LIMITATIONS L14, the editor being
     * unusable without a pointer.
     */
    nudge(dx, dy) {
      const ids = selectedIds(doc);
      if (ids.length === 0) return false;
      if (!nudging) {
        nudging = doc.present;
        doc = commit(doc, doc.present);
      }
      doc = amend(doc, moveShapes(doc.present, ids, dx, dy));
      render();
      notify();
      return true;
    },
    /** Close a nudge burst, so the next one is a separate undo step. */
    endNudge() {
      if (!nudging) return;
      // Nothing actually moved, so drop the step this burst opened rather than
      // leaving an undo that undoes nothing.
      if (JSON.stringify(nudging.shapes) === JSON.stringify(doc.present.shapes)) {
        doc = { ...doc, past: doc.past.slice(0, -1) };
      }
      nudging = null;
      notify();
    },
    selectAll() {
      const ids = doc.present.shapes.map((shape) => shape.id);
      if (ids.length === 0) return false;
      chooseTool('select');
      doc = amend(doc, { ...doc.present, selection: ids });
      render();
      notify();
      return true;
    },
    deselect() {
      doc = amend(doc, { ...doc.present, selection: [] });
      render();
    },

    // CROP, CONFIRMED

    /** Apply the pending crop. Returns the rectangle applied, or null. */
    applyCrop() {
      if (!pendingCrop) return null;
      const rect = pendingCrop;
      pendingCrop = null;
      doc = commit(doc, { ...doc.present, crop: rect, selection: [] });
      // Handed back the way a finished shape is: the crop is done, and the next
      // thing anyone does is look at the result.
      applyTool('select');
      return rect;
    },

    /** Abandon it. No undo step, because nothing was ever committed. */
    cancelCrop() {
      if (!pendingCrop) return false;
      pendingCrop = null;
      canvas.style.cursor = 'crosshair';
      render();
      return true;
    },

    /**
     * Where the pending region is on the user's screen, in client coordinates.
     *
     * The confirm bar is a real element positioned against the viewport rather
     * than something drawn on the canvas, so that it can follow the region while
     * a long capture is scrolled, and so that it is a real button with focus,
     * hover and a name. This is the only thing it needs from the canvas.
     */
    cropRectOnScreen() {
      if (!pendingCrop) return null;
      const box = canvas.getBoundingClientRect();
      const crop = effectiveCrop(doc);
      const shown = crop.w ? box.width / crop.w : 1;
      return {
        x: box.left + (pendingCrop.x - crop.x) * shown,
        y: box.top + (pendingCrop.y - crop.y) * shown,
        w: pendingCrop.w * shown,
        h: pendingCrop.h * shown,
      };
    },
    undo() {
      doc = undo(doc);
      render();
    },
    redo() {
      doc = redo(doc);
      render();
    },
    reset() {
      doc = reset(doc);
      render();
    },
    get document() {
      return doc;
    },
    get state() {
      // `selectedKind` so the toolbar can disable a control that means nothing
      // for what is selected, without reaching into the document itself.
      return {
        tool,
        edited: isEdited(doc),
        selectedCount: selectedIds(doc).length,
        canRaise: wouldReorder(doc.present, selectedIds(doc), 'forward'),
        canLower: wouldReorder(doc.present, selectedIds(doc), 'backward'),
        ...currentStyle(),
      };
    },
    /**
     * Re-seed the pending style wholesale.
     *
     * Used by Reset on an untouched capture. It sets what the *next* shape will
     * look like and never restyles anything already drawn, which is why it does
     * not go through the individual setters: those deliberately push the new
     * value onto the selected shape as well.
     */
    applyStyle(next) {
      colour = next.colour ?? colour;
      width = clamp(Math.round(next.strokeWidth ?? width), MIN_STROKE, MAX_STROKE);
      dash = next.dash ?? dash;
      ends = next.lineEnds ?? ends;
      fill = next.fill ?? null;
      corner = Math.max(0, Number(next.corner) || 0);
      fillOpacity = Number.isFinite(next.fillOpacity) ? next.fillOpacity : fillOpacity;
      text = {
        size: clamp(Math.round(next.textSize ?? text.size), MIN_TEXT_SIZE, MAX_TEXT_SIZE),
        family: next.textFamily ?? text.family,
        bold: next.textBold !== false,
        italic: next.textItalic === true,
        underline: next.textUnderline === true,
        align: next.textAlign ?? text.align,
        ink: next.textColour ?? text.ink,
        colour: next.textFrameColour ?? null,
        fill: next.textFramePlate ?? null,
        width: clamp(Math.round(next.textFrameWidth ?? text.width), MIN_STROKE, MAX_STROKE),
      };
      render();
    },
    /** Draw without the selection chrome, for export. */
    /**
     * The canvas with nothing on it but the image and the annotations.
     *
     * Leaves the canvas locked. Every caller pairs this with restoreSelection()
     * in a finally, and the lock is what guarantees the canvas still holds these
     * exact pixels by the time a multi-page encode reaches its last page.
     */
    flatten() {
      const chosen = selectedIds(doc);
      // Both kinds of chrome have to go: the selection handles, and the crop
      // dimming, which would otherwise be baked into the exported file as a
      // black border round the region the user had not applied yet.
      hideChrome = true;
      doc = amend(doc, { ...doc.present, selection: [] });
      render();
      hideChrome = false;
      doc = amend(doc, { ...doc.present, selection: chosen });
      locked += 1;
      return canvas;
    },
    /** Release the lock flatten() took, and draw whatever changed meanwhile. */
    restoreSelection() {
      locked = Math.max(0, locked - 1);
      render();
    },
  };
}
