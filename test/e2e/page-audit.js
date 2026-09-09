// Rendered-page checks: text contrast against what is actually behind it,
// content wider than the window that is not inside a scroll container, broken
// images, and heading order. Run against the extension's own pages by
// test/e2e/run.mjs, and against the marketing site by hand.
//
// It exists because three separate CSS specificity collisions shipped in one
// day, each of them invisible to a test that asserted a property rather than
// asking the browser what it drew.

(() => {
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const lum = ([r,g,b]) => 0.2126*srgb(r)+0.7152*srgb(g)+0.0722*srgb(b);
  // rgb() gives 0..255, color(srgb ...) gives 0..1. Reading the second as the
  // first made every translucent surface look black and produced false failures.
  const parse = (s) => {
    const n = (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    if (n.length !== 3) return [];
    return s.includes('color(') ? n.map((v) => Math.round(v * 255)) : n;
  };
  function bgOf(el) {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const p = parse(c);
      if (c && !c.includes('rgba(0, 0, 0, 0)') && p.length === 3) return p;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || [255,255,255];
  }
  const ratio = (a,b) => { const l1=lum(a), l2=lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };

  const lowContrast = [];
  for (const el of document.querySelectorAll('a,button,p,li,h1,h2,h3,h4,span,td,th,summary,label,output,code')) {
    const text = (el.innerText||'').trim();
    if (!text || el.children.length > 0 && !['A','BUTTON','SUMMARY','LABEL'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    const fg = parse(cs.color); if (fg.length !== 3) continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bgOf(el));
    if (r < need) lowContrast.push({ tag: el.tagName, cls: el.className || el.id, text: text.slice(0,32), ratio: Math.round(r*100)/100, need });
  }

  const cw = document.documentElement.clientWidth;
  // Something wider than the window is only a bug when nothing above it scrolls.
  // Wide tables and code blocks are meant to overflow their own scroll container.
  const scrolls = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
    }
    return false;
  };
  const overflow = [...document.querySelectorAll('body *')]
    .filter(e => e.getBoundingClientRect().right > cw + 1
      && getComputedStyle(e).position !== 'fixed'
      && !scrolls(e))
    .map(e => e.tagName + '.' + (e.id || e.className));

  const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map(h => Number(h.tagName[1]));
  let skips = [];
  headings.forEach((h,i) => { if (i && h > headings[i-1] + 1) skips.push(headings[i-1] + '->' + h); });

  return JSON.stringify({
    lowContrast: lowContrast.slice(0, 12),
    lowContrastCount: lowContrast.length,
    overflow: overflow.slice(0, 6),
    hscroll: document.documentElement.scrollWidth > cw,
    headingSkips: skips,
    brokenImages: [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src),
    missingAlt: [...document.images].filter(i => i.alt === null || i.alt === undefined).length,
    h1count: document.querySelectorAll('h1').length,
    lang: document.documentElement.lang,
    title: document.title.length,
    metaDesc: (document.querySelector('meta[name=description]')||{}).content?.length || 0,
  }, null, 1);
})()
