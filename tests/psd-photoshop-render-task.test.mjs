import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const taskSource = fs.readFileSync(new URL("../src/psdImportTask.ts", import.meta.url), "utf8");
const uiSource = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

function sliceFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : source.length;
  return source.slice(start, end > start ? end : source.length);
}

test("initial PSD import renders through Photoshop after the raw export", () => {
  const run = sliceFunction(taskSource, "async function runPsdImportTask(", "function readResultSummary(");
  const exportAt = run.indexOf("export_psd_layers.py");
  const renderAt = run.indexOf("renderPsdLayers(task, photoshopReceiptPath)");
  const submitAt = run.indexOf("submit_psd_import_job.py");
  assert.ok(exportAt >= 0 && renderAt > exportAt && submitAt > renderAt, "render must run between export and submit");
  assert.match(run, /!options\.reuseExportArtifacts && task\.mode === "initial"/);
});

test("Photoshop render replaces the submitted manifest and uses the raw manifest as text base", () => {
  const render = sliceFunction(taskSource, "async function renderPsdLayers(", "async function releasePhotoshopImportSession(");
  assert.match(render, /photoshop_render_units\.py/);
  assert.match(render, /"--base-manifest",\s*task\.manifestSummaryPath/);
  assert.match(render, /task\.manifestSummaryPath = renderedManifest/);
  assert.match(render, /"--session-receipt", photoshopReceiptPath/);
  assert.match(taskSource, /photoshopRenderQueue/);
});

test("renderer falls back to psd-tools when Photoshop COM is missing and can be forced", () => {
  const resolve = sliceFunction(taskSource, "function resolvePsdLayerRenderer(", "function isPhotoshopComRegistered(");
  assert.match(resolve, /FIGMA_RELAY_PSD_RENDERER/);
  assert.match(resolve, /requested === "raw"/);
  assert.match(resolve, /requested === "psd-tools"/);
  assert.match(resolve, /available \? "photoshop" : "psd-tools"/);
  assert.match(resolve, /requested === "photoshop" && !available/);
  assert.match(taskSource, /HKCR\\\\Photoshop\.Application\\\\CLSID/);
});

test("text alignment runs only for Photoshop-rendered initial imports and never fails the import", () => {
  const run = sliceFunction(taskSource, "async function runPsdImportTask(", "function readResultSummary(");
  assert.match(run, /task\.mode === "initial" && task\.renderer === "photoshop"/);
  const align = sliceFunction(taskSource, "async function alignTextToPhotoshopReference(", "function readResultSummary(");
  assert.match(align, /align_psd_text_to_reference\.py/);
  assert.match(align, /"--apply"/);
  assert.match(align, /catch \(error\)/);
  assert.doesNotMatch(align, /throw /);
});

test("rendering stage stays cancellable before Figma submission", () => {
  assert.match(taskSource, /CANCELLABLE_STAGES = new Set\(\["exporting_psd_layers", "waiting_for_photoshop", "rendering_psd_photoshop", "rendering_psd_tools"\]\)/);
  assert.match(taskSource, /isCancelRequested\(task\)\) throw new Error\("PSD render cancellation requested"\)/);
});

test("plugin UI labels the new render and alignment stages", () => {
  assert.match(uiSource, /rendering_psd_photoshop: "/);
  assert.match(uiSource, /rendering_psd_tools: "/);
  assert.match(uiSource, /closing_psd_photoshop: "/);
  assert.match(uiSource, /aligning_psd_text: "/);
});
