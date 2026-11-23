import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../graphtec/job.mjs';
const capture = () => ({
  boundsMm: { x: 10, y: 20, width: 100, height: 80 },
  paths: [{ sourceId: 'curve-1', closed: true, points: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 100 }] }],
  source: { documentId: 'document-1', pageIndex: 1 },
});
const options = { sheetWidthMm: 200, sheetHeightMm: 200 };
const make = () => api.createJob(capture(), options);
const clone = value => structuredClone(value);

test('job module exposes geometry creation without a native host', () => {
  assert.equal(typeof api.createJob, 'function');
});

test('centers full-size artwork within usable media and labels feed-axis corners', () => {
  const input = capture();
  const before = clone(input);
  const job = api.createJob(input, options);
  assert.deepEqual(job.registration.frame, { left: 30, bottom: 30, right: 170, top: 150 });
  assert.deepEqual(job.artworkBounds, { x: 50, y: 50, width: 100, height: 80 });
  assert.deepEqual(job.placement, { dxMm: 40, dyMm: 30 });
  assert.deepEqual(job.registration.points, [
    { label: 'P1', x: 170, y: 30 }, { label: 'P2', x: 170, y: 150 },
    { label: 'P3', x: 30, y: 30 }, { label: 'P4', x: 30, y: 150 },
  ]);
  assert.deepEqual(job.paths[0].points, [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 130 }]);
  assert.deepEqual(job.registration.blankingRects[0], { x: 153.75, y: 23.75, width: 22.5, height: 22.5 });
  assert.deepEqual(input, before);
  assert.equal(api.validateJob(job), job);
});

test('defaults to an 18 by 24 inch sheet and refuses scale-to-fit', () => {
  const job = api.createJob(capture());
  assert.deepEqual(job.sheet, { widthMm: 457.2, heightMm: 609.6 });
  assert.equal(job.registration.type, 'type2');
  assert.equal(job.registration.lengthMm, 10);
  assert.equal(job.registration.thicknessMm, 0.5);
  assert.equal(job.registration.gapMm, 20);
  assert.throws(() => api.createJob(capture(), { sheetWidthMm: 150, sheetHeightMm: 150 }), /fit|margin/i);
  assert.throws(() => api.createJob(capture(), { gapMm: 16 }), /clear|gap/i);
  for (const patch of [{ lengthMm: 4 }, { lengthMm: 21 }, { thicknessMm: 0.29 }, { thicknessMm: 1.01 }]) {
    assert.throws(() => api.createJob(capture(), patch), /length|thickness/i);
  }
});

test('fits exactly at conservative outer-stroke margins and rejects smaller sheets', () => {
  const job = api.createJob(capture(), { sheetWidthMm: 170.5, sheetHeightMm: 174.5 });
  assert.deepEqual(job.registration.frame, { left: 15.25, bottom: 17.25, right: 155.25, top: 137.25 });
  assert.throws(() => api.createJob(capture(), { sheetWidthMm: 170.499, sheetHeightMm: 174.5 }), /fit|margin/i);
  assert.throws(() => api.createJob(capture(), { sheetWidthMm: 170.5, sheetHeightMm: 174.499 }), /fit|margin/i);
});

test('rejects open, empty, degenerate, nonfinite and out-of-artwork paths', () => {
  const mutations = [
    c => { c.paths = []; },
    c => { c.paths[0].closed = false; },
    c => { c.paths[0].points = []; },
    c => { c.paths[0].points[1].x = NaN; },
    c => { c.paths[0].points[1].x = 111; },
    c => { c.paths[0].points = [{ x: 10, y: 20 }, { x: 20, y: 20 }, { x: 30, y: 20 }]; },
    c => { c.boundsMm.width = Infinity; },
  ];
  for (const mutate of mutations) {
    const c = capture(); mutate(c);
    assert.throws(() => api.createJob(c, options));
  }
});

test('validates job files independently and rejects identity or layout drift', () => {
  const mutations = [
    j => { j.registration.type = 'type1'; },
    j => { j.registration.points.reverse(); },
    j => { j.registration.points[0].x += 0.01; },
    j => { j.registration.blankingRects[0].width -= 1; },
    j => { j.registration.frame.left += 1; },
    j => { j.artworkBounds.width += 1; },
    j => { j.sheet.widthMm = 10; },
    j => { j.paths[0].points[0].y = 0; },
    j => { j.paths[0].points[0].extra = 'ignored'; },
    j => { j.paths[0].closed = false; },
    j => { j.model = 'FC9000'; },
    j => { j.unexpected = 1; },
    j => { j.source.pageIndex = -1; },
    j => { j.placement.dxMm = Infinity; },
  ];
  for (const mutate of mutations) {
    const job = clone(make()); mutate(job);
    assert.throws(() => api.validateJob(job));
  }
});

test('bounds untrusted job size, object depth, paths and points before encoding', () => {
  const tooManyPaths = clone(make());
  tooManyPaths.paths = Array.from({ length: 101 }, () => clone(tooManyPaths.paths[0]));
  assert.throws(() => api.validateJob(tooManyPaths), /100|paths/i);
  const tooManyPoints = clone(make());
  tooManyPoints.paths[0].points = Array.from({ length: 4001 }, (_, i) => ({ x: i % 2 ? 50 : 150, y: i % 3 ? 50 : 130 }));
  assert.throws(() => api.validateJob(tooManyPoints), /4000|points/i);
  const huge = clone(make()); huge.source.extra = 'x'.repeat(2 * 1024 * 1024);
  assert.throws(() => api.validateJob(huge), /size|large|limit|string/i);
  const deep = clone(make()); deep.source.extra = {};
  let current = deep.source.extra;
  for (let i = 0; i < 30; i++) { current.next = {}; current = current.next; }
  assert.throws(() => api.validateJob(deep), /depth|nested/i);
});

test('emits only ETX-terminated M and D geometry with the CE8000 axis mapping', () => {
  const encoded = api.encodeGPGL(make());
  assert.equal(encoded.data.toString('ascii'), 'M800,4800\x03D800,800\x03D4000,800\x03D800,4800\x03M800,4800\x03');
  assert.equal(encoded.bytes, encoded.data.length);
  assert.equal(encoded.pathCount, 1);
  assert.equal(encoded.pointCount, 3);
  for (const stepMm of [0.1, 0.05, 0.025, 0.01]) {
    const output = api.encodeGPGL(make(), { stepMm });
    assert.match(output.data.toString('ascii'), /^[MD\d,\x03]+$/);
    assert.ok(output.data.toString('ascii').startsWith(`M${20 / stepMm},${120 / stepMm}\x03`));
  }
  assert.throws(() => api.encodeGPGL(make(), { stepMm: 0.02 }), /step/i);
});

test('closes each path once and quantizes fractional coordinates to panel resolution', () => {
  const job = make();
  job.paths[0].points[1] = { x: 149.987, y: 50.013 };
  job.paths[0].points.push(clone(job.paths[0].points[0]));
  const output = api.encodeGPGL(job, { stepMm: 0.025 }).data.toString('ascii');
  assert.match(output, /D801,801\x03/);
  assert.equal(output.match(/D800,4800\x03/g).length, 1);
});

test('refuses geometry that collapses at the selected panel step', () => {
  const c = capture();
  c.paths[0].points = [{ x: 10, y: 20 }, { x: 10.001, y: 20 }, { x: 10, y: 20.001 }];
  const job = api.createJob(c, options);
  assert.throws(() => api.encodeGPGL(job), /degenerate|step/i);
});

test('accepts the point limit and bounds serialized bytes independently of string lengths', () => {
  const c = capture();
  c.paths[0].points = Array.from({ length: 4000 }, (_, i) => ({ x: 60 + 30 * Math.cos(i * Math.PI / 2000), y: 60 + 30 * Math.sin(i * Math.PI / 2000) }));
  const job = api.createJob(c, options);
  assert.equal(api.encodeGPGL(job).pointCount, 4000);
  job.source.detail = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`item${i}`, 'x'.repeat(60_000)]));
  assert.throws(() => api.validateJob(job), /size|MiB/i);
});

test('rejects control characters that would create an invalid SVG title', () => {
  assert.throws(() => api.createJob(capture(), { ...options, name: 'job\u0000name' }), /name|character/i);
});

test('permits finite source timestamps while bounding sparse metadata arrays', () => {
  const c = capture();
  c.source.capturedAt = 1_800_000_000_000;
  assert.equal(api.createJob(c, options).source.capturedAt, 1_800_000_000_000);
  const job = make(); job.source.extra = new Array(5000);
  assert.throws(() => api.validateJob(job), /array|4000/i);
});

test('renders inward marks, physical sheet proportions and inert preview labels', () => {
  const job = api.createJob(capture(), { ...options, name: '<script>&"unsafe' });
  const svg = api.renderJobSVG(job);
  assert.match(svg, /viewBox="0 0 200 200"/);
  assert.match(svg, /stroke="black"/);
  assert.match(svg, /stroke="red"/);
  assert.match(svg, /fill="white"/);
  assert.match(svg, /M 160 30 L 170 30 L 170 40/);
  assert.match(svg, /P1/);
  assert.match(svg, /Feed/);
  assert.match(svg, /&lt;script&gt;&amp;&quot;unsafe/);
  assert.doesNotMatch(svg, /<script|href=|url\(|onload=/i);
});
