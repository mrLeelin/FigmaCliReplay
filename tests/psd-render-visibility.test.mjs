import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const template = fs.readFileSync(new URL('../ai/skills/psd-layer-to-figma/scripts/photoshop_render_units.jsx', import.meta.url), 'utf8');

function renderHarness(effectiveVisibility = false) {
  let changes = 0;
  let nextId = 1;
  const snapshots = [];
  const doc = { typename: 'Document', width: { as: () => 100 }, height: { as: () => 100 }, layers: [] };
  function layer(name, parent = doc, visible = true, group = false) {
    let value = visible;
    const result = { id: nextId++, name, parent, typename: group ? 'LayerSet' : 'ArtLayer', layers: [] };
    Object.defineProperty(result, 'visible', {
      get: () => value && (!effectiveVisibility || parent.typename === 'Document' || parent.visible),
      set: next => { if (value !== next) changes++; value = next; },
    });
    parent.layers.push(result);
    return result;
  }
  function visibleLeaves(container = doc) {
    return container.layers.flatMap(item => !item.visible ? [] : item.typename === 'LayerSet' ? visibleLeaves(item) : [item.name]);
  }
  const context = vm.createContext({
    File: function (name) { this.fsName = name; },
    LayerKind: { TEXT: 'text' },
  });
  vm.runInContext(template.replaceAll('__CONFIG__', '{outDir:"test"}').replace(/main\(\);\s*$/, ''), context);
  context.srcDoc = doc;
  context.layerInfo = () => ({ bounds: [0, 0, 20, 20] });
  context.savePngCopy = () => snapshots.push(visibleLeaves());
  const unit = (layers, hideTexts = []) => ({ layers, hideTexts, clip: null });
  const render = (item, index) => context.renderUnit(item, index);
  const restore = () => { if (context.restoreIsolatedLayers) context.restoreIsolatedLayers(); };
  return { context, doc, layer, snapshots, unit, render, restore, changes: () => changes, visibleLeaves };
}

test('rendering consecutive units changes only the visibility difference, not every sibling twice', () => {
  const h = renderHarness();
  const layers = Array.from({ length: 40 }, (_, index) => h.layer(`layer${index}`));
  layers.forEach((layer, index) => h.render(h.unit([layer]), index));
  h.restore();
  assert.deepEqual(h.snapshots, layers.map(layer => [layer.name]));
  assert.equal(h.visibleLeaves().length, layers.length, 'original visibility must be restored');
  assert.ok(h.changes() <= layers.length * 4,
    `40 rendered layers made ${h.changes()} visibility changes; expected at most 160`);
});

test('nested groups, clipping chains and hidden children keep the same saved pixels between units', () => {
  const h = renderHarness();
  const groupA = h.layer('groupA', h.doc, true, true);
  const a = h.layer('a', groupA);
  h.layer('hidden', groupA, false);
  const text = h.layer('text', groupA);
  const groupB = h.layer('groupB', h.doc, true, true);
  const base = h.layer('base', groupB);
  const clipped = h.layer('clipped', groupB);
  const hiddenClip = h.layer('hiddenClip', groupB, false);
  const inputs = [h.unit([a]), h.unit([base, clipped, hiddenClip]), h.unit([groupA], [text]), h.unit([text])];
  inputs.forEach((input, index) => h.render(input, index));
  h.restore();
  assert.deepEqual(h.snapshots, [['a'], ['base', 'clipped'], ['a'], ['text']]);
  assert.deepEqual(h.visibleLeaves(), ['a', 'text', 'base', 'clipped']);
});

test('an unsuccessful PNG save still allows the next unit and final visibility restoration', () => {
  const h = renderHarness();
  const a = h.layer('a');
  const b = h.layer('b');
  const originalSave = h.context.savePngCopy;
  h.context.savePngCopy = () => { throw new Error('disk full'); };
  assert.throws(() => h.render(h.unit([a]), 0), /disk full/);
  h.context.savePngCopy = originalSave;
  h.render(h.unit([b]), 1);
  h.restore();
  assert.deepEqual(h.snapshots, [['b']]);
  assert.deepEqual(h.visibleLeaves(), ['a', 'b']);
});

test('child visibility is captured before hiding an ancestor changes its effective state', () => {
  const h = renderHarness(true);
  const groupA = h.layer('groupA', h.doc, true, true);
  const a = h.layer('a', groupA);
  const groupB = h.layer('groupB', h.doc, true, true);
  const b = h.layer('b', groupB);
  const other = h.layer('other', groupB);
  h.layer('hidden', groupB, false);
  [a, b, other, a].forEach((layer, index) => h.render(h.unit([layer]), index));
  h.restore();
  assert.deepEqual(h.snapshots, [['a'], ['b'], ['other'], ['a']]);
  assert.deepEqual(h.visibleLeaves(), ['a', 'b', 'other']);
});
