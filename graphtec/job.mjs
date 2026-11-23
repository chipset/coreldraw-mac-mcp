// CE8000 manual 5-3, 5-5 and 5-6: Type 2 corner centerlines, 6 mm
// scan clearance, and conservative margins measured from the outer stroke.
const EPS = 1e-7;
const MAX_COORD = 1_000_000;
const MAX_BYTES = 2 * 1024 * 1024;
const STEPS = [0.1, 0.05, 0.025, 0.01];
const clean = value => Number(value.toFixed(9));
const fail = message => { throw new Error(`Invalid Graphtec job: ${message}`); };
const same = (a, b) => Math.abs(a - b) <= EPS;

function record(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some(key => !fields.includes(key))) fail(`${label} has an unsupported field`);
}

function number(value, label, min = -MAX_COORD, max = MAX_COORD) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be finite and between ${min} and ${max}`);
  return value;
}

function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must be a nonempty string of at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${label} contains unsupported control characters`);
}

// Bound traversal before JSON.stringify, including deeply nested or cyclic inputs.
function checkJSON(value) {
  let fields = 0;
  const active = new Set();
  function visit(item, depth) {
    if (depth > 12) fail('JSON nesting depth exceeds limit');
    if (++fields > 60_000) fail('JSON field count exceeds limit');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (item.length > 65_536) fail('JSON string exceeds size limit'); return; }
    if (typeof item === 'number') { number(item, 'JSON number', -Number.MAX_VALUE, Number.MAX_VALUE); return; }
    if (typeof item !== 'object') fail('only JSON values are supported');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) fail('only plain JSON objects are supported');
    if (active.has(item)) fail('cyclic JSON is unsupported');
    active.add(item);
    if (Array.isArray(item) && item.length > 4000) fail('JSON array limit 4000 exceeded');
    const keys = Object.keys(item);
    if (keys.length > (Array.isArray(item) ? 4000 : 64)) fail('JSON array limit 4000 or object field limit 64 exceeded');
    if (Object.getOwnPropertySymbols(item).length) fail('only JSON fields are supported');
    for (const key of keys) {
      if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsupported JSON field');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || descriptor.get || descriptor.set) fail('JSON accessors are unsupported');
      visit(descriptor.value, depth + 1);
    }
    active.delete(item);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) fail('serialized job size exceeds 2 MiB');
}

function bounds(value, label) {
  record(value, ['x', 'y', 'width', 'height'], label);
  number(value.x, `${label}.x`); number(value.y, `${label}.y`);
  number(value.width, `${label}.width`, EPS, 50_000);
  number(value.height, `${label}.height`, EPS, 50_000);
  number(value.x + value.width, `${label} right`);
  number(value.y + value.height, `${label} top`);
}

function source(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('source must be an object');
  text(value.documentId, 'source.documentId');
  number(value.pageIndex, 'source.pageIndex', 0, 100_000);
  if (!Number.isInteger(value.pageIndex)) fail('source.pageIndex must be an integer');
  checkJSON(value);
}

function settings(value) {
  number(value.lengthMm, 'registration length', 5, 20);
  number(value.thicknessMm, 'registration thickness', 0.3, 1);
  number(value.gapMm, 'registration gap', 0, 1000);
  if (value.gapMm + EPS < value.lengthMm + value.thicknessMm / 2 + 6) fail('registration gap does not leave 6 mm scan clearance');
}

function layout(sheet, art, registration) {
  const half = registration.thicknessMm / 2;
  const width = art.width + 2 * registration.gapMm;
  const height = art.height + 2 * registration.gapMm;
  if (width > sheet.widthMm - 30 - 2 * half + EPS || height > sheet.heightMm - 54 - 2 * half + EPS) fail('artwork and registration frame do not fit sheet margins; scaling is not permitted');
  const left = clean((sheet.widthMm - width) / 2);
  const bottom = clean((sheet.heightMm - 20 - height) / 2);
  return { left, bottom, right: clean(left + width), top: clean(bottom + height) };
}

function pointsFor(frame) {
  return [
    { label: 'P1', x: frame.right, y: frame.bottom },
    { label: 'P2', x: frame.right, y: frame.top },
    { label: 'P3', x: frame.left, y: frame.bottom },
    { label: 'P4', x: frame.left, y: frame.top },
  ];
}

function markVertices(point, length) {
  const right = point.label === 'P1' || point.label === 'P2';
  const top = point.label === 'P2' || point.label === 'P4';
  return [
    { x: clean(point.x + (right ? -length : length)), y: point.y },
    { x: point.x, y: point.y },
    { x: point.x, y: clean(point.y + (top ? -length : length)) },
  ];
}

function blankingFor(points, registration) {
  const padding = registration.thicknessMm / 2 + 6;
  return points.map(point => {
    const vertices = markVertices(point, registration.lengthMm);
    return {
      x: clean(Math.min(...vertices.map(p => p.x)) - padding),
      y: clean(Math.min(...vertices.map(p => p.y)) - padding),
      width: clean(registration.lengthMm + 2 * padding),
      height: clean(registration.lengthMm + 2 * padding),
    };
  });
}

function assertExpected(actual, expected, label) {
  record(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value === 'number') {
      number(actual[key], `${label}.${key}`);
      if (!same(actual[key], value)) fail(`${label}.${key} does not match registration geometry`);
    } else if (actual[key] !== value) fail(`${label}.${key} does not match registration identity`);
  }
}

function nondegenerate(points) {
  const a = points[0];
  const b = points.find(p => !same(p.x, a.x) || !same(p.y, a.y));
  return b && points.some(p => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > EPS);
}

function paths(value, art, frame) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail('cut paths must contain 1 to 100 paths');
  let count = 0;
  for (const path of value) {
    record(path, ['sourceId', 'closed', 'points'], 'cut path');
    text(path.sourceId, 'cut path sourceId');
    if (path.closed !== true) fail('every cut path must be closed');
    if (!Array.isArray(path.points) || path.points.length < 3) fail('cut path requires at least three points');
    count += path.points.length;
    if (count > 4000) fail('cut paths exceed 4000 points');
    for (const point of path.points) {
      record(point, ['x', 'y'], 'cut point');
      number(point.x, 'cut point x'); number(point.y, 'cut point y');
      if (point.x < art.x - EPS || point.x > art.x + art.width + EPS || point.y < art.y - EPS || point.y > art.y + art.height + EPS) fail('cut point lies outside artwork bounds');
      if (frame && (point.x < frame.left - EPS || point.x > frame.right + EPS || point.y < frame.bottom - EPS || point.y > frame.top + EPS)) fail('cut point lies outside registration frame');
    }
    if (!nondegenerate(path.points)) fail('cut path is degenerate');
  }
  return count;
}

export function createJob(capture, options = {}) {
  if (!capture || typeof capture !== 'object') fail('capture must be an object');
  record(options, ['sheetWidthMm', 'sheetHeightMm', 'lengthMm', 'thicknessMm', 'gapMm', 'name'], 'options');
  bounds(capture.boundsMm, 'capture bounds');
  paths(capture.paths, capture.boundsMm);
  source(capture.source);
  const sheet = { widthMm: options.sheetWidthMm ?? 457.2, heightMm: options.sheetHeightMm ?? 609.6 };
  number(sheet.widthMm, 'sheet width', 1, 50_000); number(sheet.heightMm, 'sheet height', 1, 50_000);
  const registration = { type: 'type2', lengthMm: options.lengthMm ?? 10, thicknessMm: options.thicknessMm ?? 0.5, gapMm: options.gapMm ?? 20 };
  settings(registration);
  registration.frame = layout(sheet, capture.boundsMm, registration);
  registration.points = pointsFor(registration.frame);
  registration.blankingRects = blankingFor(registration.points, registration);
  const artworkBounds = {
    x: clean(registration.frame.left + registration.gapMm), y: clean(registration.frame.bottom + registration.gapMm),
    width: capture.boundsMm.width, height: capture.boundsMm.height,
  };
  const placement = { dxMm: clean(artworkBounds.x - capture.boundsMm.x), dyMm: clean(artworkBounds.y - capture.boundsMm.y) };
  const job = {
    format: 'graphtec-print-cut', version: 1, name: options.name ?? 'Graphtec print-and-cut', model: 'CE8000',
    sheet, registration, placement, artworkBounds,
    paths: capture.paths.map(path => ({ sourceId: path.sourceId, closed: true, points: path.points.map(p => ({ x: clean(p.x + placement.dxMm), y: clean(p.y + placement.dyMm) })) })),
    source: structuredClone(capture.source),
  };
  return validateJob(job);
}

export function validateJob(job) {
  checkJSON(job);
  record(job, ['format', 'version', 'name', 'model', 'sheet', 'registration', 'placement', 'artworkBounds', 'paths', 'source'], 'job');
  if (job.format !== 'graphtec-print-cut' || job.version !== 1 || job.model !== 'CE8000') fail('unsupported format, version or cutter model');
  text(job.name, 'job name');
  record(job.sheet, ['widthMm', 'heightMm'], 'sheet');
  number(job.sheet.widthMm, 'sheet width', 1, 50_000); number(job.sheet.heightMm, 'sheet height', 1, 50_000);
  const r = job.registration;
  record(r, ['type', 'lengthMm', 'thicknessMm', 'gapMm', 'frame', 'points', 'blankingRects'], 'registration');
  if (r.type !== 'type2') fail('only Type 2 registration marks are supported');
  settings(r);
  bounds(job.artworkBounds, 'artwork bounds');
  const expectedFrame = layout(job.sheet, job.artworkBounds, r);
  assertExpected(r.frame, expectedFrame, 'registration frame');
  assertExpected(job.artworkBounds, {
    x: clean(expectedFrame.left + r.gapMm), y: clean(expectedFrame.bottom + r.gapMm),
    width: job.artworkBounds.width, height: job.artworkBounds.height,
  }, 'artwork bounds');
  const expectedPoints = pointsFor(expectedFrame);
  if (!Array.isArray(r.points) || r.points.length !== 4) fail('registration requires exactly four points');
  r.points.forEach((point, i) => assertExpected(point, expectedPoints[i], `registration point ${i + 1}`));
  const expectedBlanks = blankingFor(expectedPoints, r);
  if (!Array.isArray(r.blankingRects) || r.blankingRects.length !== 4) fail('registration requires exactly four blanking rectangles');
  r.blankingRects.forEach((rectangle, i) => assertExpected(rectangle, expectedBlanks[i], `blanking rectangle ${i + 1}`));
  record(job.placement, ['dxMm', 'dyMm'], 'placement');
  number(job.placement.dxMm, 'placement dx'); number(job.placement.dyMm, 'placement dy');
  paths(job.paths, job.artworkBounds, r.frame);
  source(job.source);
  return job;
}

export function encodeGPGL(job, { stepMm = 0.025 } = {}) {
  validateJob(job);
  if (!STEPS.includes(stepMm)) fail('panel step must be 0.1, 0.05, 0.025 or 0.01 mm');
  const origin = job.registration.points[0];
  const commands = [];
  let pointCount = 0;
  for (const path of job.paths) {
    pointCount += path.points.length;
    const vertices = path.points.map(p => ({ x: Math.round((p.y - origin.y) / stepMm), y: Math.round((origin.x - p.x) / stepMm) }));
    while (vertices.length > 1 && vertices.at(-1).x === vertices[0].x && vertices.at(-1).y === vertices[0].y) vertices.pop();
    if (!nondegenerate(vertices)) fail('cut path becomes degenerate at the selected panel step');
    const pair = p => `${p.x},${p.y}\x03`;
    commands.push(`M${pair(vertices[0])}`);
    for (const point of vertices.slice(1)) commands.push(`D${pair(point)}`);
    commands.push(`D${pair(vertices[0])}`, `M${pair(vertices[0])}`);
  }
  const data = Buffer.from(commands.join(''), 'ascii');
  return { data, bytes: data.length, pointCount, pathCount: job.paths.length, stepMm, nominalFeedMm: clean(job.registration.frame.top - job.registration.frame.bottom), nominalCrossfeedMm: clean(job.registration.frame.right - job.registration.frame.left) };
}

export function renderJobSVG(job) {
  validateJob(job);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const height = job.sheet.heightMm;
  const pathData = vertices => vertices.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
  const blanks = job.registration.blankingRects.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="white"/>`).join('');
  const cuts = job.paths.map(p => `<path d="${pathData(p.points)} Z" fill="none" stroke="red" stroke-width="0.25"/>`).join('');
  const marks = job.registration.points.map(p => `<path d="${pathData(markVertices(p, job.registration.lengthMm))}" fill="none" stroke="black" stroke-width="${job.registration.thicknessMm}" stroke-linecap="butt" stroke-linejoin="miter"/>`).join('');
  const labels = job.registration.points.map(p => `<text x="${p.x}" y="${clean(height - p.y + (p.label === 'P1' || p.label === 'P3' ? 7 : -4))}" text-anchor="middle" font-size="4">${p.label}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${job.sheet.widthMm}mm" height="${height}mm" viewBox="0 0 ${job.sheet.widthMm} ${height}" role="img" aria-label="${escape(job.name)}"><title>${escape(job.name)}</title><rect width="100%" height="100%" fill="white" stroke="#999" stroke-width="0.3"/><g transform="translate(0 ${height}) scale(1 -1)">${cuts}${blanks}${marks}</g><g fill="#333" font-family="sans-serif">${labels}<path d="M 7 22 L 7 40 M 4 36 L 7 40 L 10 36" fill="none" stroke="#333" stroke-width="0.5"/><text x="12" y="33" font-size="4">Feed</text></g></svg>`;
}
