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
  BOX_TOOLS,
  POINT_TOOLS,
  DEFAULT_FILL_OPACITY,
  MAX_STROKE,
  MAX_TEXT_SIZE,
  MIN_STROKE,
  MIN_TEXT_SIZE,
  TEXT_LINE_RATIO,
  alignOf,
  amend,
  arrowGeometry,
  boundsOf,
  canRedo,
  canUndo,
  clampRect,
  commit,
  constrain,
  createDocument,
  cropHandleAt,
  cropHandlesFor,
  dashOf,
  handleCursor,
  dashPattern,
  effectiveCrop,
  fillAlphaOf,
  fillOf,
  endsOf,
  fontOf,
  hasEnd,
  handleAt,
  handlesFor,
  insideRect,
  isEdited,
  isUsableCrop,
  isUsableDrag,
  linesOf,
  measureText,
  moveCrop,
  moveShape,
  newId,
  nextCounterNumber,
  normalizeRect,
  redo,
  removeShape,
  replaceShape,
  reset,
  resizeCrop,
  resizeShape,
  selectedShape,
  shapeAt,
  undo,
} from '../lib/edit.js';

const DASH = [8, 6];
const HANDLE_SIZE = 9;
const HIGHLIGHT_ALPHA = 0.35;
const PIXELATE_BLOCKS = 14;

export function createEditor({ base, canvas, onChange, initial = {} }) {
  const ctx = canvas.getContext('2d');

  let doc = createDocument(base.width, base.height);
  let tool = initial.tool ?? 'arrow';
  let colour = initial.colour ?? '#ef4444';
  let width = initial.strokeWidth ?? 4;
  // Style that new shapes inherit. Each is also editable on the selected shape,
  // which is why every one of them lives here rather than only on the shape.
  let dash = initial.dash ?? 'solid';
  let ends = initial.lineEnds ?? 'end';
  let fill = initial.fill ?? null;
  let fillOpacity = initial.fillOpacity ?? DEFAULT_FILL_OPACITY;
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
    colour: initial.textColour ?? initial.colour ?? '#ef4444',
  };

  let drag = null;
  let editing = null;
  // The shape currently open in the text box, hidden from the canvas while its
  // own words sit over it. Null while a new box is being typed into.
  let editingId = null;
  // The shape under the pointer, outlined so a click is never a guess about what
  // it will land on. Held as an id rather than a shape so a stale object cannot
  // be drawn after an edit replaced it.
  let hoverId = null;

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

  function drawShape(shape, crop) {
    const dx = -crop.x;
    const dy = -crop.y;

    ctx.save();
    ctx.strokeStyle = shape.colour;
    ctx.fillStyle = shape.colour;
    ctx.lineWidth = shape.width;
    ctx.lineCap = dashOf(shape) === 'dotted' ? 'round' : 'round';
    ctx.lineJoin = 'round';

    if (shape.kind === 'arrow' || shape.kind === 'line') {
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
    } else if (shape.kind === 'rect') {
      const { x, y, w, h } = shape.rect;
      paintFill(shape, () => ctx.fillRect(x + dx, y + dy, w, h));
      applyDash(shape);
      ctx.strokeRect(x + dx, y + dy, w, h);
    } else if (shape.kind === 'ellipse') {
      const cx = shape.rect.x + shape.rect.w / 2 + dx;
      const cy = shape.rect.y + shape.rect.h / 2 + dy;
      const rx = Math.max(1, shape.rect.w / 2);
      const ry = Math.max(1, shape.rect.h / 2);
      const trace = () => {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      };
      paintFill(shape, () => {
        trace();
        ctx.fill();
      });
      applyDash(shape);
      trace();
      ctx.stroke();
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
    }

    ctx.restore();
  }

  /**
   * Canvas has no underline, so it is drawn: one rule per line, at a tenth of
   * the size below the baseline, thick enough to survive the export.
   */
  function drawText(shape, dx, dy) {
    ctx.font = fontOf(shape);
    // Every line is placed by hand from the block's own left edge, so the canvas
    // alignment is left throughout and `align` is applied as an offset. Letting
    // the canvas align would need a different origin per line and would put the
    // underline in the wrong place, since that is drawn from the same origin.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const lines = linesOf(shape);
    const align = alignOf(shape);
    const widths = lines.map((line) => ctx.measureText(line).width);
    const block = Math.max(0, ...widths);
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
        ctx.strokeStyle = shape.colour;
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
  function drawPixelated(shape, dx, dy) {
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

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, cols, rows, x + dx, y + dy, w, h);
    ctx.imageSmoothingEnabled = true;
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
    const b = boundsOf(shape);
    const scale = screenScale();
    const pad = 3 * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.55)';
    ctx.lineWidth = 1.5 * scale;
    ctx.strokeRect(b.x - crop.x - pad, b.y - crop.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.restore();
  }

  function drawSelection(shape, crop) {
    const b = boundsOf(shape);
    const scale = screenScale();
    const size = HANDLE_SIZE * scale;

    ctx.save();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5 * scale;
    ctx.setLineDash(DASH.map((step) => step * scale));
    const pad = 3 * scale;
    ctx.strokeRect(b.x - crop.x - pad, b.y - crop.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);

    for (const handle of handlesFor(shape)) {
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

    const chosen = selectedShape(doc);
    if (chosen && !preview && !pendingCrop) drawSelection(chosen, crop);

    // What a click would pick up, shown before the click. Never on the selected
    // shape, which already has an outline and handles of its own, and never
    // while something is being drawn or a crop is waiting to be answered.
    if (hoverId && hoverId !== chosen?.id && !preview && !pendingCrop) {
      const under = doc.present.shapes.find((shape) => shape.id === hoverId);
      if (under) drawHover(under, crop);
    }

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

  function buildShape(from, to, shifted) {
    const crop = effectiveCrop(doc);
    const end = shifted && tool !== 'crop' ? constrain(from, to, tool) : to;

    if (tool === 'crop') {
      return { kind: 'crop', rect: clampRect(normalizeRect(from, end), crop) };
    }
    if (BOX_TOOLS.includes(tool)) {
      const shape = {
        id: newId(), kind: tool, rect: clampRect(normalizeRect(from, end), crop), colour, width,
      };
      // Only the outlined boxes take a fill. A highlighter is already a fill and
      // a redaction has to stay opaque to be a redaction.
      if (tool === 'rect' || tool === 'ellipse') {
        shape.dash = dash;
        if (fill) {
          shape.fill = fill;
          shape.fillOpacity = fillOpacity;
        }
      }
      return shape;
    }
    return { id: newId(), kind: tool, from, to: end, colour, width, dash, ends };
  }

  function applyTool(next) {
    // Leaving the crop tool abandons a region that was never confirmed. Keeping
    // it would leave the image dimmed under a tool that cannot act on it.
    if (next !== 'crop') pendingCrop = null;
    tool = next;
    // Leaving the selection tool drops the selection: the handles belong to it,
    // and leaving them drawn under a drawing tool invites clicking them.
    if (next !== 'select') doc = amend(doc, { ...doc.present, selected: null });
    canvas.style.cursor = next === 'select' ? 'default' : next === 'text' ? 'text' : 'crosshair';
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
        radius: Math.max(12, width * 4),
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
    const hit = shapeAt(doc.present.shapes, toImage(event));
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
    const handle = chosen ? handleAt(chosen, at, pickTolerance()) : null;
    if (handle) {
      canvas.style.cursor = handleCursor(handle);
      setHover(null);
      return;
    }

    const under = shapeAt(doc.present.shapes, at);
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
  canvas.addEventListener('pointerleave', () => setHover(null));

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
      const handle = chosen ? handleAt(chosen, point, pickTolerance()) : null;

      if (handle) {
        drag = { mode: 'resize', handle, shape: chosen, before: doc.present };
        return;
      }

      const hit = shapeAt(doc.present.shapes, point);
      doc = amend(doc, { ...doc.present, selected: hit ? hit.id : null });
      drag = hit ? { mode: 'move', shape: hit, last: point, before: doc.present } : null;
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
          selected: shape.id,
        });
        render();
      }
      return;
    }

    drag = { mode: 'draw', from: point };
  });

  canvas.addEventListener('pointermove', (event) => {
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

    if (drag.mode === 'draw') {
      drag.to = point;
      render(buildShape(drag.from, point, event.shiftKey));
      return;
    }

    if (drag.mode === 'move') {
      const moved = moveShape(drag.shape, point.x - drag.last.x, point.y - drag.last.y);
      drag.shape = moved;
      drag.last = point;
      doc = amend(doc, replaceShape(doc.present, moved));
      render();
      return;
    }

    if (drag.mode === 'resize') {
      const resized = resizeShape(drag.shape, drag.handle, point);
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

  function endDrag(event) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    hoverId = null;

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
        selected: shape.id,
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

    // A move or resize became final: make the state before it undoable.
    //
    // Unless nothing actually moved. Selecting a shape is a press and a release
    // on it, which is a move drag of zero distance, so every click on the canvas
    // was pushing an undo step that undid nothing visible. Click three shapes and
    // the next three presses of Cmd+Z appear to do nothing at all, which reads as
    // undo being broken rather than as the history being full of no-ops.
    if (!shapeChanged(finished.before, doc.present, finished.shape?.id)) {
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
  function shapeChanged(before, after, id) {
    if (!id) return true;
    const find = (present) => present.shapes.find((shape) => shape.id === id);
    return JSON.stringify(find(before)) !== JSON.stringify(find(after));
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
        colour: existing.colour ?? text.colour,
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
    input.style.color = style.colour;
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
        colour: style.colour,
        width,
        family: style.family,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        align: style.align,
      });

      doc = commit(doc, existing
        ? { ...replaceShape(doc.present, shape), selected: shape.id }
        : { ...doc.present, shapes: [...doc.present.shapes, shape], selected: shape.id });
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

  function restyleSelection(patch) {
    const chosen = selectedShape(doc);
    if (!chosen) return false;
    doc = commit(doc, replaceShape(doc.present, { ...chosen, ...patch }));
    render();
    return true;
  }

  /**
   * What the toolbar glyphs should show. A selected shape wins over the pending
   * style, because the buttons act on it. It is the usual rule in an inspector:
   * the border swatch shows the selected object's border, not the last one set.
   */
  function currentStyle() {
    const chosen = selectedShape(doc);
    if (!chosen) {
      return { colour, width, dash, ends, fill, fillOpacity, text: { ...text } };
    }
    return {
      colour: chosen.colour ?? colour,
      width: chosen.width ?? width,
      dash: dashOf(chosen),
      ends: chosen.kind === 'arrow' || chosen.kind === 'line' ? endsOf(chosen) : ends,
      fill: fillOf(chosen),
      fillOpacity: fillOf(chosen) ? fillAlphaOf(chosen) : fillOpacity,
      text: chosen.kind === 'text'
        ? {
          size: chosen.size,
          family: chosen.family ?? text.family,
          bold: chosen.bold !== false,
          italic: chosen.italic === true,
          underline: chosen.underline === true,
          align: alignOf(chosen),
          colour: chosen.colour ?? text.colour,
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
      if (finished.mode === 'move' || finished.mode === 'resize') {
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
      const chosen = selectedShape(doc);
      if (chosen && (chosen.kind === 'arrow' || chosen.kind === 'line')) {
        restyleSelection({ ends: next });
      }
      render();
      notify();
    },
    /** `null` means no fill, which is a value rather than an absence. */
    setFill(next) {
      fill = next;
      const chosen = selectedShape(doc);
      if (chosen && (chosen.kind === 'rect' || chosen.kind === 'ellipse')) {
        restyleSelection(next ? { fill: next, fillOpacity } : { fill: null });
      }
      notify();
    },
    setFillOpacity(next) {
      fillOpacity = clamp(next, 0, 1);
      const chosen = selectedShape(doc);
      if (chosen && fillOf(chosen)) restyleSelection({ fillOpacity });
      notify();
    },
    setTextStyle(patch) {
      if (Number.isFinite(patch.size)) {
        patch.size = clamp(Math.round(patch.size), MIN_TEXT_SIZE, MAX_TEXT_SIZE);
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
    deleteSelection() {
      const chosen = selectedShape(doc);
      if (!chosen) return false;
      doc = commit(doc, removeShape(doc.present, chosen.id));
      render();
      return true;
    },
    deselect() {
      doc = amend(doc, { ...doc.present, selected: null });
      render();
    },

    // CROP, CONFIRMED

    /** Apply the pending crop. Returns the rectangle applied, or null. */
    applyCrop() {
      if (!pendingCrop) return null;
      const rect = pendingCrop;
      pendingCrop = null;
      doc = commit(doc, { ...doc.present, crop: rect, selected: null });
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
      return { tool, edited: isEdited(doc), ...currentStyle() };
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
      fillOpacity = Number.isFinite(next.fillOpacity) ? next.fillOpacity : fillOpacity;
      text = {
        size: clamp(Math.round(next.textSize ?? text.size), MIN_TEXT_SIZE, MAX_TEXT_SIZE),
        family: next.textFamily ?? text.family,
        bold: next.textBold !== false,
        italic: next.textItalic === true,
        underline: next.textUnderline === true,
        align: next.textAlign ?? text.align,
        colour: next.textColour ?? text.colour,
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
      const chosen = doc.present.selected;
      // Both kinds of chrome have to go: the selection handles, and the crop
      // dimming, which would otherwise be baked into the exported file as a
      // black border round the region the user had not applied yet.
      hideChrome = true;
      doc = amend(doc, { ...doc.present, selected: null });
      render();
      hideChrome = false;
      doc = amend(doc, { ...doc.present, selected: chosen });
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
