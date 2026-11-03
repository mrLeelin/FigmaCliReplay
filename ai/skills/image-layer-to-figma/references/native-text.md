# Native ordinary text

Use this before importing screenshot-derived UI resources. The result combines complete raster artwork with editable ordinary text. Resource composition happens first, text preparation second, import third, and hierarchy organization last. Do not run the raster compositor over the prepared native text.

## Classify from the source

Inventory every resource containing text. Ordinary labels and changing values become Text: quantities such as `×50`, level numbers, balances, countdowns, captions and progress values. Preserve meaningful whole lines and independently changing values. Stylized lettering with a special silhouette, illustration or dimensional treatment may remain raster; record the visual reason. Layer names and prefixes are not classification evidence.

Separate a mixed resource before preparing its text. Preserve the complete crown, leaf ornament, button artwork or progress fill as artwork, and give the ordinary text its own bounds. Do not paint a new Text over visible bitmap glyphs. Keep the original screenshot and extracted raster text as source evidence; a hidden reference may remain in an existing live file.

Transcribe characters from the actual source, including the multiplication sign, currency, punctuation and spacing. Do not guess missing or ambiguous characters. Read same-scope live Figma text metadata for font family and style before choosing a replacement; a Latin numeric font and a CJK font can differ when the evidence supports that. Capture fill and stroke colors from verified source metadata or the source artwork. Record a substituted font rather than claiming the original font was recovered.

## Prepare a mixed manifest

From the Relay repository root:

```powershell
python -X utf8 ai/skills/image-layer-to-figma/scripts/prepare_native_text.py --manifest <resource-manifest.json> --plan <text-plan.json> --out-dir <new-empty-directory>
```

The command is offline: it does not call a provider or modify Figma. It keeps the input manifest and source PNGs unchanged, copies retained artwork bytes, and writes a compatible `manifest.json` plus `native-text-report.json` in the new directory. Pass that generated manifest to `submit_psd_import_job.py` using the verified file/session/parent target.

The plan identifies actual source `idx` values. Characters, fonts, sizes and colors below illustrate the schema; choose them from the current source and live font evidence, not from this example:

```json
{
  "schemaVersion": 1,
  "layers": [
    {
      "sourceIdx": 7,
      "classification": "ordinary",
      "characters": "×50",
      "font": {"family": "Arial", "style": "Bold"},
      "fontSize": 28,
      "fillColor": "#060605",
      "stroke": {"color": "#F0F3F6", "size": 1}
    },
    {
      "sourceIdx": 9,
      "classification": "decorative",
      "reason": "Title lettering has an illustrated dimensional silhouette."
    }
  ]
}
```

Bounds default to the source layer's `x/y/w/h`. Supply an optional `bounds` object with those four fields when the verified text bounds differ. Declaring a mixed text/art layer is rejected until the resources are separated. Unlisted artwork stays unchanged; the script does not perform OCR or decide whether unlisted pixels contain ordinary text.

Ordinary entries produce `mode: "text"`, `semanticMode: "text"`, `textRole: "ordinary"`, explicit characters/font/fill/stroke metadata, and no raster fallback path. Decorative entries retain their image mode with `textRole: "decorative"` and `rasterTextReason`. The import wrapper validates these roles. An invalid ordinary entry or failed font load blocks that text instead of quietly replacing it with a PNG. Review the report's classification counts and `unclassifiedLayerCount` before submitting: inspect unclassified resources for missed ordinary text, rather than treating a successful preparation as semantic coverage proof.

## Verify the live result

Native text keeps `textAutoResize = "WIDTH_AND_HEIGHT"` and automatic line height. Use source bounds as the placement anchor, then center the actual text dimensions after the font has loaded. Check glyph size and outline visually; the source bitmap bounds and a font's line box are different measurements.

Read back the created nodes through the project CLI and verify:

- Every declared ordinary entry is a visible `TEXT` node with the intended characters, font/style, size, fill and stroke.
- No visible bitmap glyphs duplicate the native text, including inside mixed artwork.
- Automatic sizing and line height avoid clipping; native text stays correctly positioned and fits its control.
- The live composite retains the artwork, stacking and functional hierarchy. The original source remains unchanged.

A font substitution can change glyph shape and width. Report that limit separately from the verified editability. For an already imported screen, use the existing CLI text-creation/edit workflow with fresh target reads and hide the replaced bitmap only after the native text is ready; this offline preparation command does not rewrite a live file. Hierarchy organization itself only groups the accepted nodes and does not perform text conversion.

The legacy PSD incremental updater requires fixed geometry and currently rejects changes to ordinary automatic-size Text. Edit those nodes through the native text workflow, or prepare the revised manifest and import a new resource version. Do not freeze the Text size or substitute a raster image to pass the old incremental contract.
