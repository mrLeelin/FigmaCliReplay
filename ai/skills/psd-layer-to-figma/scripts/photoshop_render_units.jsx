// Photoshop 渲染单元导出：由 photoshop_render_units.py 注入 __CONFIG__ 后执行。
// 每个可见视觉单元在独立临时文档中由 Photoshop 自身渲染，图层样式、蒙版、
// 剪贴蒙版与组级样式全部按 Photoshop 结果输出；普通文字只记录 ID，保持原生 Text。
var CONFIG = __CONFIG__;

function q(value) {
  var s = String(value);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"' || c === '\\') out += '\\' + c;
    else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
    else out += c;
  }
  return out + '"';
}

function toJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return q(value);
  var parts = [];
  if (value instanceof Array) {
    for (var i = 0; i < value.length; i++) parts.push(toJson(value[i]));
    return '[' + parts.join(',') + ']';
  }
  for (var key in value) {
    if (value.hasOwnProperty(key)) parts.push(q(key) + ':' + toJson(value[key]));
  }
  return '{' + parts.join(',') + '}';
}

function s2t(s) { return stringIDToTypeID(s); }

function layerDescriptor(layerId) {
  var ref = new ActionReference();
  ref.putIdentifier(s2t('layer'), layerId);
  return executeActionGet(ref);
}

function readBounds(desc, key) {
  if (!desc.hasKey(s2t(key))) return null;
  var b = desc.getObjectValue(s2t(key));
  return [
    b.getUnitDoubleValue(s2t('left')),
    b.getUnitDoubleValue(s2t('top')),
    b.getUnitDoubleValue(s2t('right')),
    b.getUnitDoubleValue(s2t('bottom'))
  ];
}

function anyEffectEnabled(desc) {
  if (!desc.hasKey(s2t('layerEffects'))) return false;
  if (desc.hasKey(s2t('layerFXVisible')) && !desc.getBoolean(s2t('layerFXVisible'))) return false;
  var fx = desc.getObjectValue(s2t('layerEffects'));
  for (var i = 0; i < fx.count; i++) {
    var key = fx.getKey(i);
    var type = fx.getType(key);
    if (type === DescValueType.OBJECTTYPE) {
      var one = fx.getObjectValue(key);
      if (one.hasKey(s2t('enabled')) && one.getBoolean(s2t('enabled'))) return true;
    } else if (type === DescValueType.LISTTYPE) {
      var list = fx.getList(key);
      for (var j = 0; j < list.count; j++) {
        var item = list.getObjectValue(j);
        if (item.hasKey(s2t('enabled')) && item.getBoolean(s2t('enabled'))) return true;
      }
    }
  }
  return false;
}

function layerInfo(layer) {
  var desc = layerDescriptor(layer.id);
  var mode = desc.hasKey(s2t('mode')) ? typeIDToStringID(desc.getEnumerationValue(s2t('mode'))) : 'normal';
  var info = {
    effects: anyEffectEnabled(desc),
    userMask: desc.hasKey(s2t('hasUserMask')) && desc.getBoolean(s2t('hasUserMask')),
    vectorMask: desc.hasKey(s2t('hasVectorMask')) && desc.getBoolean(s2t('hasVectorMask')),
    blend: mode,
    opacity: desc.hasKey(s2t('opacity')) ? desc.getInteger(s2t('opacity')) : 255,
    bounds: readBounds(desc, 'bounds'),
    artboard: null
  };
  if (desc.hasKey(s2t('artboardEnabled')) && desc.getBoolean(s2t('artboardEnabled'))) {
    var ab = desc.getObjectValue(s2t('artboard'));
    info.artboard = readBounds(ab, 'artboardRect');
  }
  return info;
}

function isText(layer) {
  return layer.typename === 'ArtLayer' && layer.kind === LayerKind.TEXT;
}

function collectTexts(layer, out) {
  if (layer.typename === 'LayerSet') {
    for (var i = 0; i < layer.layers.length; i++) collectTexts(layer.layers[i], out);
  } else if (isText(layer) && layer.visible) {
    out.push(layer);
  }
}

// 组需要整体渲染的条件：组级样式、蒙版、非穿透混合或组透明度会改变子层合成结果。
function groupIsAtomic(info) {
  return info.effects || info.userMask || info.vectorMask || info.blend !== 'passThrough' || info.opacity < 255;
}

var units = [];
var srcDoc = null;

// 自底向上遍历，保证 units 顺序等于 Photoshop 合成顺序。
function walk(container, clipRect, depth, path) {
  var layers = container.layers;
  var i = layers.length - 1;
  while (i >= 0) {
    var layer = layers[i];
    // 收集紧贴其上的剪贴层，作为同一渲染单元。
    var chain = [layer];
    var j = i - 1;
    while (j >= 0 && layers[j].typename === 'ArtLayer' && layers[j].grouped) {
      chain.push(layers[j]);
      j--;
    }
    i = j;
    if (!layer.visible) continue;
    var info = layerInfo(layer);
    var name = layer.name;
    var unitPath = path.concat([name]);
    if (layer.typename === 'LayerSet') {
      if (info.artboard) {
        walk(layer, info.artboard, depth + 1, unitPath);
        continue;
      }
      if (!groupIsAtomic(info) && chain.length === 1) {
        walk(layer, clipRect, depth + 1, unitPath);
        continue;
      }
      var texts = [];
      collectTexts(layer, texts);
      units.push({ kind: 'image', layers: chain, layerId: layer.id, name: name, path: unitPath,
        clip: clipRect, blend: info.blend, hideTexts: texts, group: true });
      for (var t = 0; t < texts.length; t++) {
        units.push({ kind: 'text', layers: [texts[t]], layerId: texts[t].id, name: texts[t].name,
          path: unitPath.concat([texts[t].name]), clip: clipRect, blend: 'normal', hideTexts: [] });
      }
      continue;
    }
    if (isText(layer) && chain.length === 1) {
      units.push({ kind: 'text', layers: chain, layerId: layer.id, name: name, path: unitPath,
        clip: clipRect, blend: info.blend, hideTexts: [] });
      continue;
    }
    units.push({ kind: 'image', layers: chain, layerId: layer.id, name: name, path: unitPath,
      clip: clipRect, blend: info.blend, hideTexts: [], group: false });
  }
}

function intersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  var r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  if (r[2] <= r[0] || r[3] <= r[1]) return null;
  return r;
}

function unionBounds(chain) {
  var r = null;
  for (var i = 0; i < chain.length; i++) {
    if (!chain[i].visible) continue;
    var b = layerInfo(chain[i]).bounds;
    if (!b || b[2] <= b[0] || b[3] <= b[1]) continue;
    r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b;
  }
  return r;
}

function containsOrder(list, order) {
  for (var i = 0; i < list.length; i++) if (list[i] === order) return true;
  return false;
}

function containsLayer(list, layer) {
  for (var i = 0; i < list.length; i++) if (list[i] === layer || list[i].id === layer.id) return true;
  return false;
}

// 仅保留渲染单元自身及其祖先路径：逐级隐藏路径外的同级图层，返回被隐藏的图层以便复原。
function isolateUnit(unit) {
  var changed = [];
  var keep = unit.layers;
  var parent = unit.layers[0].parent;
  while (parent) {
    var siblings = parent.layers;
    for (var i = 0; i < siblings.length; i++) {
      var sibling = siblings[i];
      if (sibling.visible && !containsLayer(keep, sibling)) {
        sibling.visible = false;
        changed.push(sibling);
      }
    }
    if (parent.typename === 'Document') break;
    keep = [parent];
    parent = parent.parent;
  }
  for (var t = 0; t < unit.hideTexts.length; t++) {
    if (unit.hideTexts[t].visible) { unit.hideTexts[t].visible = false; changed.push(unit.hideTexts[t]); }
  }
  return changed;
}

// 在源文档原位渲染：复制到其他文档会让 Photoshop 重算渐变填充/渐变叠加（结果与源不一致），
// 且大文档反复复制可能导致崩溃；原位隐藏无关图层后另存 PNG 副本即是 Photoshop 自身合成。
function renderUnit(unit, index) {
  var base = unionBounds(unit.layers);
  if (!base) return { skipped: 'empty-bounds' };
  var canvas = [0, 0, srcDoc.width.as('px'), srcDoc.height.as('px')];
  if (!intersect(unit.clip || canvas, canvas)) return { skipped: 'outside-clip' };
  var changed = isolateUnit(unit);
  try {
    var file = new File(CONFIG.outDir + '/u_' + index + '.png');
    var opts = new PNGSaveOptions();
    opts.compression = 1;
    srcDoc.saveAs(file, opts, true, Extension.LOWERCASE);
    return { file: file.fsName, rect: canvas };
  } finally {
    for (var r = changed.length - 1; r >= 0; r--) changed[r].visible = true;
  }
}

// 画板背景（默认白色）在隐藏其他图层后会被当作单元像素输出：渲染期间临时改为透明，结束后复原。
function artboardBackgroundType(layerId) {
  var desc = layerDescriptor(layerId);
  if (!desc.hasKey(s2t('artboard'))) return null;
  var ab = desc.getObjectValue(s2t('artboard'));
  return ab.hasKey(s2t('artboardBackgroundType')) ? ab.getInteger(s2t('artboardBackgroundType')) : null;
}

function setArtboardBackgroundType(layerId, type) {
  // editArtboardEvent 只对当前选中图层生效，按 ID 引用会被静默忽略：先选中画板再按 target 修改。
  var selectRef = new ActionReference();
  selectRef.putIdentifier(s2t('layer'), layerId);
  var select = new ActionDescriptor();
  select.putReference(s2t('null'), selectRef);
  select.putBoolean(s2t('makeVisible'), false);
  executeAction(s2t('select'), select, DialogModes.NO);
  var ref = new ActionReference();
  ref.putEnumerated(s2t('layer'), s2t('ordinal'), s2t('targetEnum'));
  var desc = new ActionDescriptor();
  desc.putReference(s2t('null'), ref);
  var ab = new ActionDescriptor();
  ab.putString(s2t('artboardPresetName'), '');
  ab.putInteger(s2t('artboardBackgroundType'), type);
  desc.putObject(s2t('artboard'), s2t('artboard'), ab);
  desc.putInteger(s2t('changeBackground'), 1);
  executeAction(s2t('editArtboardEvent'), desc, DialogModes.NO);
  if (artboardBackgroundType(layerId) !== type) throw new Error('artboard background not changed: ' + layerId);
}

function makeArtboardsTransparent(container, restore) {
  for (var i = 0; i < container.layers.length; i++) {
    var layer = container.layers[i];
    if (layer.typename !== 'LayerSet') continue;
    var info = layerInfo(layer);
    if (info.artboard) {
      var type = artboardBackgroundType(layer.id);
      if (type !== null && type !== 3) {
        setArtboardBackgroundType(layer.id, 3);
        restore.push({ id: layer.id, type: type });
      }
    }
  }
}

function main() {
  app.displayDialogs = DialogModes.NO;
  var oldUnits = app.preferences.rulerUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  var psdFile = new File(CONFIG.psdPath);
  var alreadyOpen = false;
  for (var o = 0; o < app.documents.length; o++) {
    // 未保存的新文档读取 fullName 会抛错（8103），跳过即可。
    try {
      if (app.documents[o].fullName.fsName == psdFile.fsName) { srcDoc = app.documents[o]; alreadyOpen = true; }
    } catch (unsaved) {}
  }
  if (!srcDoc) srcDoc = app.open(psdFile);
  app.activeDocument = srcDoc;
  var artboardRestore = [];
  var result = { canvas: { width: srcDoc.width.as('px'), height: srcDoc.height.as('px') }, units: [], errors: [] };
  try {
    walk(srcDoc, null, 0, []);
    // 全部图层可见时的 Photoshop 合成图，作为导入后文字对齐与验收的参照。
    var refOpts = new PNGSaveOptions();
    refOpts.compression = 1;
    srcDoc.saveAs(new File(CONFIG.outDir + '/reference.png'), refOpts, true, Extension.LOWERCASE);
    result.reference = CONFIG.outDir + '/reference.png';
    makeArtboardsTransparent(srcDoc, artboardRestore);
    for (var i = 0; i < units.length; i++) {
      var unit = units[i];
      if (CONFIG.onlyOrders && !containsOrder(CONFIG.onlyOrders, i)) continue;
      var entry = { order: i, kind: unit.kind, layerId: unit.layerId, name: unit.name, path: unit.path,
        clip: unit.clip, blend: unit.blend, group: !!unit.group, layerIds: [] };
      for (var k = 0; k < unit.layers.length; k++) entry.layerIds.push(unit.layers[k].id);
      if (unit.kind === 'image') {
        try {
          var out = renderUnit(unit, i);
          for (var key in out) if (out.hasOwnProperty(key)) entry[key] = out[key];
        } catch (err) {
          entry.error = String(err);
          result.errors.push(unit.name + ': ' + String(err));
        }
      }
      result.units.push(entry);
    }
  } finally {
    for (var a = artboardRestore.length - 1; a >= 0; a--) {
      try { setArtboardBackgroundType(artboardRestore[a].id, artboardRestore[a].type); }
      catch (restoreErr) { result.errors.push('artboard restore: ' + String(restoreErr)); }
    }
    // 只关闭本脚本打开的文档；用户已打开的文档保持原状（渲染期间的显隐切换已复原）。
    if (!alreadyOpen) srcDoc.close(SaveOptions.DONOTSAVECHANGES);
    app.preferences.rulerUnits = oldUnits;
  }
  var f = new File(CONFIG.outDir + '/ps_units.json');
  f.encoding = 'UTF-8';
  f.open('w');
  f.write(toJson(result));
  f.close();
  return 'ok:' + result.units.length + ':errors=' + result.errors.length;
}

main();
