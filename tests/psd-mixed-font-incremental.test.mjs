import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as incremental from '../code/06_psd_incremental.mjs';

// This build fragment starts by closing an object from the preceding fragment.
const source = fs.readFileSync(new URL('../code/05_utils.js', import.meta.url), 'utf8').replace(/^\s*};\s*}/, '');
const mixed = Symbol('figma.mixed');
const primary = { family: 'GROBOLD', style: 'Regular' };
const secondary = { family: 'Noto Sans SC', style: 'Regular' };

function metadataNode(properties = {}) {
  const data = new Map();
  return {
    ...properties, data,
    setSharedPluginData(namespace, key, value) { data.set(key, value); },
    getSharedPluginData(namespace, key) { return data.get(key) || ''; },
  };
}

function textNode() {
  let chars = '';
  let defaultFont = { family: 'Inter', style: 'Regular' };
  let fonts = [];
  const node = metadataNode({
    id: '1:101', type: 'TEXT', x: 0, y: 0, width: 200, height: 40,
    fontSize: 40, rotation: 0, visible: true, opacity: 1, blendMode: 'NORMAL',
    constraints: { horizontal: 'MIN', vertical: 'MIN' }, fills: [], strokes: [], effects: [],
    textAutoResize: 'NONE',
    setRangeFontName(start, end, font) {
      for (let index = start; index < end; index++) fonts[index] = { ...font };
    },
    getRangeFontName(start, end) {
      const keys = new Set(fonts.slice(start, end).map(font => JSON.stringify(font)));
      return keys.size === 1 ? { ...fonts[start] } : mixed;
    },
    getStyledTextSegments() {
      const runs = [];
      for (let index = 0; index < chars.length; index++) {
        const last = runs.at(-1);
        if (last && JSON.stringify(last.fontName) === JSON.stringify(fonts[index])) last.end++;
        else runs.push({ start: index, end: index + 1, fontName: { ...fonts[index] } });
      }
      return runs;
    },
  });
  Object.defineProperties(node, {
    fontName: {
      get: () => fonts.length ? node.getRangeFontName(0, chars.length) : defaultFont,
      set: value => { defaultFont = { ...value }; fonts = Array.from(chars, () => ({ ...value })); },
    },
    characters: {
      get: () => chars,
      set: value => { chars = value; fonts = Array.from({ length: chars.length }, () => ({ ...defaultFont })); },
    },
    absoluteTransform: { get: () => [[1, 0, node.x], [0, 1, node.y]] },
  });
  return node;
}

async function fixture() {
  const root = metadataNode({
    id: '1:1', children: [], absoluteTransform: [[1, 0, 0], [0, 1, 0]],
    appendChild(node) { this.children.push(node); node.parent = this; },
  });
  for (const [key, value] of Object.entries({
    psdImportSchemaVersion: '3', psdCanvasWidth: '1000', psdCanvasHeight: '600', psdSourceFileName: 'fixture.psd',
  })) root.data.set(key, value);
  const api = vm.createContext({
    ...incremental,
    McpMetadataNamespace: 'test',
    figma: { mixed, createText: textNode, loadFontAsync: async () => {} },
  });
  vm.runInContext(source, api);
  const textState = {
    version: 3, layerId: '101', mode: 'text',
    geometry: { x: 10, y: 20, width: 200, height: 40, rotation: null },
    display: { visible: true, opacity: 1, blendMode: 'NORMAL', constraints: { horizontal: 'MIN', vertical: 'MIN' } },
    content: { contentHash: 'same-text' },
    text: {
      characters: 'A中文', fontFamily: primary.family, fontFallback: [primary],
      fontSize: 40, effectiveFontSize: 40, leading: 0, lineHeightMode: 'AUTO',
      textAlignHorizontal: 'LEFT', fillColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 }, stroke: null, dropShadow: null,
    },
    nineSlice: null, unsupported: [],
  };
  const textLayer = api.normalizeLayer({
    idx: 1, layerId: '101', name: 'mixed label', mode: 'text', textRole: 'ordinary',
    chars: 'A中文', x: 10, y: 20, w: 200, h: 40, fontSize: 40,
    fontFallback: [primary], fillColor: textState.text.fillColor, textAlign: 'LEFT',
    sourceState: textState,
    fontRuns: [
      { start: 0, end: 1, fontFallback: [primary] },
      { start: 1, end: 3, fontFallback: [secondary] },
    ],
  });
  const context = { manifest: { canvas: { width: 1000, height: 600 } }, warnings: [], textReports: [], stats: { text: 0 } };
  const node = await api.createTextLayer(root, textLayer, context);
  assert.equal(node.fontName, mixed, 'fixture must reproduce Figma mixed fontName');
  const stored = JSON.parse(node.data.get('psdSourceState'));
  const preview = ({ imageChange = false } = {}) => {
    const current = [{
      layerId: '101', nodeId: node.id, node, ownership: 'text-content',
      sourceState: stored, liveState: api.buildPsdLiveSourceState(node, root, stored),
    }];
    const incoming = [textLayer];
    if (imageChange) {
      const oldImage = incremental.normalizePsdSourceState({
        layerId: '102', mode: 'image', x: 0, y: 0, w: 20, h: 20, contentHash: 'old',
      });
      current.push({ layerId: '102', nodeId: '1:102', ownership: 'image-content', sourceState: oldImage,
        node: { type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageHash: 'old' }] } });
      incoming.push({ layerId: '102', mode: 'image', sourceState: { ...oldImage, content: { contentHash: 'new' } } });
    }
    const manifest = { canvas: { width: 1000, height: 600 }, layers: incoming };
    const diff = api.buildPsdIncrementalDiff(current, incoming);
    api.appendPsdIncrementalRuntimeConflicts(diff, root, current, { sourceFileName: 'fixture.psd' }, manifest);
    return diff;
  };
  return { api, root, node, preview, stored };
}

test('fresh imported mixed font text produces preview-no-changes', async () => {
  const { preview } = await fixture();
  const diff = preview();
  assert.equal(diff.status, 'preview-no-changes');
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.conflicts.length, 0);
});

test('an image-only update stays applicable beside unchanged mixed ordinary text', async () => {
  const { preview } = await fixture();
  const diff = preview({ imageChange: true });
  assert.equal(diff.status, 'preview-ready');
  assert.equal(diff.canApply, true);
  assert.deepEqual([...diff.changed].map(pair => pair.source.layerId), ['102']);
  assert.equal(diff.conflicts.length, 0);
});

test('a real secondary font or style change still blocks ordinary text replacement', async () => {
  for (const changedFont of [{ family: 'Different CJK', style: 'Regular' }, { ...secondary, style: 'Bold' }]) {
    const { node, preview } = await fixture();
    node.setRangeFontName(1, 3, changedFont);
    const diff = preview();
    assert.equal(diff.status, 'preview-blocked');
    assert.equal(diff.canApply, false);
    assert.ok(diff.changed[0].changes.some(change => change.path === 'text.fontFamily' && change.category === 'textStyle'));
    assert.ok(diff.conflicts.some(conflict => conflict.kind === 'ordinary-text-requires-native-replacement'));
  }
});

test('an original font loaded under its canonical family keeps the PSD source identity', async () => {
  const { api, root, node, stored } = await fixture();
  node.data.delete('psdFontRunState');
  stored.text.fontFamily = 'PoetsenOne-Regular';
  stored.text.fontFallback = [{ family: stored.text.fontFamily, style: 'Regular' }];

  node.fontName = { family: 'Poetsen One', style: 'Regular' };
  assert.equal(api.buildPsdLiveSourceState(node, root, stored).text.fontFamily, stored.text.fontFamily);

  node.fontName = { family: 'Poetsen One', style: 'Bold' };
  assert.equal(api.buildPsdLiveSourceState(node, root, stored).text.fontFamily, 'Poetsen One');
});

test('new font run metadata captures actual complete ranges and survives metadata snapshots', async () => {
  const { api, node } = await fixture();
  const saved = JSON.parse(node.data.get('psdFontRunState') || 'null');
  assert.deepEqual(saved, { version: 1, length: 3, runs: [
    { start: 0, end: 1, fontName: primary }, { start: 1, end: 3, fontName: secondary },
  ] });
  assert.equal(api.capturePsdLayerMetadata(node).psdFontRunState, node.data.get('psdFontRunState'));
});

test('legacy mixed text without font run metadata retains canonical primary family', async () => {
  const { node, preview } = await fixture();
  node.data.delete('psdFontRunState');
  assert.equal(preview().status, 'preview-no-changes');
  assert.equal(preview({ imageChange: true }).status, 'preview-ready');
  node.setRangeFontName(0, 1, { family: 'Changed primary', style: 'Regular' });
  assert.equal(preview().status, 'preview-blocked');
});

test('range font reads can verify mixed fonts when styled segment API is unavailable', async () => {
  const { node, preview } = await fixture();
  node.getStyledTextSegments = undefined;
  assert.equal(preview().status, 'preview-no-changes');
  node.setRangeFontName(2, 3, { family: 'Changed', style: 'Regular' });
  assert.equal(preview().status, 'preview-blocked');
});

test('font run changes invalidate a preview fingerprint even while fontName stays mixed', async () => {
  const { api, node } = await fixture();
  const before = api.buildPsdLiveWritableFieldSignature(node);
  node.setRangeFontName(1, 3, { ...secondary, style: 'Bold' });
  assert.equal(node.fontName, mixed);
  assert.notEqual(api.buildPsdLiveWritableFieldSignature(node), before);
});
