#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Dump Unity runtime RectTransform/layout truth for a UGUI Prefab.

This script does not modify project assets. It sends a temporary C# snippet to
the Unity Roslyn gateway, instantiates the Prefab in an unsaved Canvas, forces a
layout pass, and writes a JSON snapshot for deterministic comparison.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any


TRUTH_FILE_NAME = "unity_runtime_truth.json"


def parse_canvas(value: str) -> tuple[float, float]:
    normalized = value.lower().replace("*", "x").replace("×", "x")
    parts = [part.strip() for part in normalized.split("x") if part.strip()]
    if len(parts) != 2:
        raise ValueError(f"Canvas size must be WIDTHxHEIGHT for runtime truth dump, got: {value}")
    width = float(parts[0])
    height = float(parts[1])
    if width <= 0 or height <= 0:
        raise ValueError(f"Canvas size must be positive, got: {value}")
    return width, height


def unity_project_root(project_root: Path) -> Path:
    candidate = project_root / "JellybeanUnity"
    if (candidate / "Assets").exists():
        return candidate.resolve()
    if (project_root / "Assets").exists():
        return project_root.resolve()
    raise FileNotFoundError(f"Unity project Assets folder not found under {project_root}")


def unity_asset_path(project_root: Path, prefab_path: Path) -> str:
    repo_root = project_root.resolve()
    unity_root = unity_project_root(repo_root)
    raw = prefab_path
    if not raw.is_absolute():
        raw = (repo_root / raw).resolve()
    else:
        raw = raw.resolve()
    try:
        rel_to_unity = raw.relative_to(unity_root).as_posix()
    except ValueError:
        try:
            rel_to_repo = raw.relative_to(repo_root).as_posix()
        except ValueError as exc:
            raise ValueError(f"Prefab path is outside project root: {raw}") from exc
        prefix = "JellybeanUnity/"
        rel_to_unity = rel_to_repo[len(prefix):] if rel_to_repo.startswith(prefix) else rel_to_repo
    if not rel_to_unity.startswith("Assets/"):
        raise ValueError(f"Prefab must resolve to a Unity Assets path, got: {rel_to_unity}")
    return rel_to_unity


def build_unity_code(asset_path: str, canvas_width: float, canvas_height: float) -> str:
    template = r'''
string JsonEscape(string value)
{
    if (value == null) return "";
    var sb = new System.Text.StringBuilder();
    for (int i = 0; i < value.Length; i++)
    {
        char c = value[i];
        if (c == '\\') sb.Append("\\\\");
        else if (c == '"') sb.Append("\\\"");
        else if (c == '\n') sb.Append("\\n");
        else if (c == '\r') sb.Append("\\r");
        else if (c == '\t') sb.Append("\\t");
        else if (char.IsControl(c)) sb.Append("\\u").Append(((int)c).ToString("x4"));
        else sb.Append(c);
    }
    return sb.ToString();
}

string Q(string value) { return "\"" + JsonEscape(value) + "\""; }
string N(float value) { return value.ToString("0.######", System.Globalization.CultureInfo.InvariantCulture); }
string B(bool value) { return value ? "true" : "false"; }

void AppendVec2(System.Text.StringBuilder sb, string name, UnityEngine.Vector2 value)
{
    sb.Append(Q(name)).Append(":{\"x\":").Append(N(value.x)).Append(",\"y\":").Append(N(value.y)).Append("}");
}

void AppendColor(System.Text.StringBuilder sb, string name, UnityEngine.Color value)
{
    sb.Append(Q(name)).Append(":{\"r\":").Append(N(value.r)).Append(",\"g\":").Append(N(value.g)).Append(",\"b\":").Append(N(value.b)).Append(",\"a\":").Append(N(value.a)).Append("}");
}

float EffectiveCanvasGroupAlpha(UnityEngine.Transform transform)
{
    float alpha = 1f;
    var current = transform;
    while (current != null)
    {
        var group = current.GetComponent<UnityEngine.CanvasGroup>();
        if (group != null)
        {
            alpha *= group.alpha;
            if (group.ignoreParentGroups) break;
        }
        current = current.parent;
    }
    return alpha;
}

void AppendRuntimeRect(System.Text.StringBuilder sb, UnityEngine.RectTransform rt)
{
    var parentRt = rt.parent as UnityEngine.RectTransform;
    float parentWidth = parentRt != null ? parentRt.rect.width : rt.rect.width;
    float parentHeight = parentRt != null ? parentRt.rect.height : rt.rect.height;
    float spanWidth = (rt.anchorMax.x - rt.anchorMin.x) * parentWidth;
    float spanHeight = (rt.anchorMax.y - rt.anchorMin.y) * parentHeight;
    float width = (spanWidth + rt.sizeDelta.x) * System.Math.Abs(rt.localScale.x);
    float height = (spanHeight + rt.sizeDelta.y) * System.Math.Abs(rt.localScale.y);
    float pivotX = rt.anchorMin.x * parentWidth + spanWidth * rt.pivot.x + rt.anchoredPosition.x;
    float pivotY = rt.anchorMin.y * parentHeight + spanHeight * rt.pivot.y + rt.anchoredPosition.y;
    float x = pivotX - rt.pivot.x * width;
    float y = parentHeight - (pivotY + (1f - rt.pivot.y) * height);
    sb.Append("\"rect\":{\"x\":").Append(N(x))
      .Append(",\"y\":").Append(N(y))
      .Append(",\"width\":").Append(N(width))
      .Append(",\"height\":").Append(N(height))
      .Append(",\"rotationZ\":").Append(N(rt.localEulerAngles.z))
      .Append("}");
}

void AppendComponents(System.Text.StringBuilder sb, UnityEngine.RectTransform rt)
{
    var canvasGroup = rt.GetComponent<UnityEngine.CanvasGroup>();
    if (canvasGroup != null)
    {
        sb.Append(",\"canvasGroup\":{\"alpha\":").Append(N(canvasGroup.alpha))
          .Append(",\"effectiveAlpha\":").Append(N(EffectiveCanvasGroupAlpha(rt)))
          .Append(",\"interactable\":").Append(B(canvasGroup.interactable))
          .Append(",\"blocksRaycasts\":").Append(B(canvasGroup.blocksRaycasts))
          .Append(",\"ignoreParentGroups\":").Append(B(canvasGroup.ignoreParentGroups))
          .Append("}");
    }

    var image = rt.GetComponent<UnityEngine.UI.Image>();
    if (image != null)
    {
        sb.Append(",\"image\":{\"type\":").Append(Q(image.type.ToString()))
          .Append(",\"enabled\":").Append(B(image.enabled))
          .Append(",\"raycastTarget\":").Append(B(image.raycastTarget))
          .Append(",\"sprite\":").Append(Q(image.sprite != null ? image.sprite.name : ""))
          .Append(",\"preserveAspect\":").Append(B(image.preserveAspect))
          .Append(",\"fillAmount\":").Append(N(image.fillAmount))
          .Append(",");
        AppendColor(sb, "color", image.color);
        sb.Append("}");
    }

    var rawImage = rt.GetComponent<UnityEngine.UI.RawImage>();
    if (rawImage != null)
    {
        sb.Append(",\"rawImage\":{\"enabled\":").Append(B(rawImage.enabled))
          .Append(",\"texture\":").Append(Q(rawImage.texture != null ? rawImage.texture.name : ""))
          .Append(",");
        AppendColor(sb, "color", rawImage.color);
        sb.Append("}");
    }

    var tmp = rt.GetComponent<TMPro.TMP_Text>();
    if (tmp != null)
    {
        sb.Append(",\"text\":{\"kind\":\"TMP\",\"enabled\":").Append(B(tmp.enabled))
          .Append(",\"text\":").Append(Q(tmp.text))
          .Append(",\"fontSize\":").Append(N(tmp.fontSize))
          .Append(",\"alignment\":").Append(Q(tmp.alignment.ToString()))
          .Append(",");
        AppendColor(sb, "color", tmp.color);
        sb.Append("}");
    }
    else
    {
        var uiText = rt.GetComponent<UnityEngine.UI.Text>();
        if (uiText != null)
        {
            sb.Append(",\"text\":{\"kind\":\"UGUI\",\"enabled\":").Append(B(uiText.enabled))
              .Append(",\"text\":").Append(Q(uiText.text))
              .Append(",\"fontSize\":").Append(uiText.fontSize)
              .Append(",\"alignment\":").Append(Q(uiText.alignment.ToString()))
              .Append(",");
            AppendColor(sb, "color", uiText.color);
            sb.Append("}");
        }
    }
}

void AppendNode(System.Text.StringBuilder sb, UnityEngine.RectTransform rt, string path)
{
    sb.Append("{");
    sb.Append("\"name\":").Append(Q(rt.gameObject.name));
    sb.Append(",\"path\":").Append(Q(path));
    sb.Append(",\"siblingIndex\":").Append(rt.GetSiblingIndex());
    sb.Append(",\"activeSelf\":").Append(B(rt.gameObject.activeSelf));
    sb.Append(",\"activeInHierarchy\":").Append(B(rt.gameObject.activeInHierarchy));
    sb.Append(",");
    AppendRuntimeRect(sb, rt);
    sb.Append(",\"rectTransform\":{");
    AppendVec2(sb, "anchorMin", rt.anchorMin);
    sb.Append(",");
    AppendVec2(sb, "anchorMax", rt.anchorMax);
    sb.Append(",");
    AppendVec2(sb, "anchoredPosition", rt.anchoredPosition);
    sb.Append(",");
    AppendVec2(sb, "sizeDelta", rt.sizeDelta);
    sb.Append(",");
    AppendVec2(sb, "pivot", rt.pivot);
    sb.Append(",\"localScale\":{\"x\":").Append(N(rt.localScale.x)).Append(",\"y\":").Append(N(rt.localScale.y)).Append(",\"z\":").Append(N(rt.localScale.z)).Append("}");
    sb.Append("}");
    AppendComponents(sb, rt);
    sb.Append(",\"children\":[");
    bool first = true;
    for (int i = 0; i < rt.childCount; i++)
    {
        var child = rt.GetChild(i) as UnityEngine.RectTransform;
        if (child == null) continue;
        if (!first) sb.Append(",");
        first = false;
        AppendNode(sb, child, path + "/" + child.gameObject.name);
    }
    sb.Append("]}");
}

string assetPath = "__ASSET_PATH__";
float canvasWidth = __CANVAS_WIDTH__;
float canvasHeight = __CANVAS_HEIGHT__;
var prefab = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>(assetPath);
if (prefab == null)
{
    throw new System.Exception("Prefab not found: " + assetPath);
}

UnityEngine.GameObject canvasGo = null;
UnityEngine.GameObject instance = null;
try
{
    canvasGo = new UnityEngine.GameObject("__PrefabToFigmaTruthCanvas", typeof(UnityEngine.RectTransform), typeof(UnityEngine.Canvas), typeof(UnityEngine.UI.CanvasScaler), typeof(UnityEngine.UI.GraphicRaycaster));
    canvasGo.hideFlags = UnityEngine.HideFlags.HideAndDontSave;
    var canvas = canvasGo.GetComponent<UnityEngine.Canvas>();
    canvas.renderMode = UnityEngine.RenderMode.ScreenSpaceOverlay;
    var canvasRt = canvasGo.GetComponent<UnityEngine.RectTransform>();
    canvasRt.anchorMin = new UnityEngine.Vector2(0.5f, 0.5f);
    canvasRt.anchorMax = new UnityEngine.Vector2(0.5f, 0.5f);
    canvasRt.pivot = new UnityEngine.Vector2(0.5f, 0.5f);
    canvasRt.anchoredPosition = UnityEngine.Vector2.zero;
    canvasRt.sizeDelta = new UnityEngine.Vector2(canvasWidth, canvasHeight);

    instance = UnityEditor.PrefabUtility.InstantiatePrefab(prefab) as UnityEngine.GameObject;
    if (instance == null) instance = UnityEngine.Object.Instantiate(prefab);
    instance.hideFlags = UnityEngine.HideFlags.HideAndDontSave;
    var rootRt = instance.GetComponent<UnityEngine.RectTransform>();
    if (rootRt == null)
    {
        throw new System.Exception("Prefab root has no RectTransform: " + assetPath);
    }
    rootRt.SetParent(canvasRt, false);

    UnityEngine.Canvas.ForceUpdateCanvases();
    UnityEngine.UI.LayoutRebuilder.ForceRebuildLayoutImmediate(rootRt);
    UnityEngine.Canvas.ForceUpdateCanvases();
    UnityEngine.UI.LayoutRebuilder.ForceRebuildLayoutImmediate(rootRt);
    UnityEngine.Canvas.ForceUpdateCanvases();

    var sb = new System.Text.StringBuilder();
    sb.Append("{\"schema\":\"unity-runtime-prefab-truth.v1\"");
    sb.Append(",\"prefabPath\":").Append(Q(assetPath));
    sb.Append(",\"canvas\":{\"width\":").Append(N(canvasWidth)).Append(",\"height\":").Append(N(canvasHeight)).Append("}");
    sb.Append(",\"root\":");
    AppendNode(sb, rootRt, rootRt.gameObject.name);
    sb.Append("}");
    return sb.ToString();
}
finally
{
    if (instance != null) UnityEngine.Object.DestroyImmediate(instance);
    if (canvasGo != null) UnityEngine.Object.DestroyImmediate(canvasGo);
}
'''
    return (
        template
        .replace("__ASSET_PATH__", asset_path.replace("\\", "/").replace('"', '\\"'))
        .replace("__CANVAS_WIDTH__", f"{canvas_width:.6f}f")
        .replace("__CANVAS_HEIGHT__", f"{canvas_height:.6f}f")
    )


def extract_gateway_result(payload: dict[str, Any]) -> str:
    if payload.get("state") != "Success" and payload.get("success") is not True:
        raise RuntimeError(json.dumps(payload, ensure_ascii=False, indent=2))
    result = payload.get("result")
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and isinstance(result.get("resultText"), str):
        return result["resultText"]
    if isinstance(result, dict) and isinstance(result.get("resultJson"), str):
        return json.loads(result["resultJson"])
    if isinstance(result, dict) and isinstance(result.get("value"), str):
        return result["value"]
    raise RuntimeError(f"Unity gateway did not return a JSON string result: {payload!r}")


def run_dump(args: argparse.Namespace) -> dict[str, Any]:
    project_root = Path(args.project_root).resolve()
    unity_root = unity_project_root(project_root)
    asset_path = unity_asset_path(project_root, Path(args.prefab))
    canvas_width, canvas_height = parse_canvas(args.canvas)
    gateway_client = unity_root / "Assets" / "Editor" / "RoslynGateway" / "PyScripts" / "ai_gateway_client.py"
    if not gateway_client.exists():
        raise FileNotFoundError(f"Unity Roslyn gateway client not found: {gateway_client}")

    code = build_unity_code(asset_path, canvas_width, canvas_height)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / TRUTH_FILE_NAME if out_dir.is_dir() else out_dir

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".cs.txt", delete=False) as handle:
        handle.write(code)
        code_path = Path(handle.name)

    try:
        command = [
            sys.executable,
            str(gateway_client),
            "--http-timeout",
            str(max(args.timeout + 5, 30)),
            "do-code",
            "--project-root",
            str(unity_root),
            "--code-file",
            str(code_path),
            "--timeout",
            str(args.timeout),
        ]
        completed = subprocess.run(
            command,
            cwd=str(project_root),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=args.timeout + 15,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "Unity gateway command failed "
                f"({completed.returncode}): {completed.stdout}\n{completed.stderr}"
            )
        payload = json.loads(completed.stdout)
        truth_text = extract_gateway_result(payload)
        truth = json.loads(truth_text)
        truth["artifacts"] = {"truthPath": str(output_path)}
        output_path.write_text(json.dumps(truth, ensure_ascii=False, indent=2), encoding="utf-8")
        return truth
    finally:
        try:
            code_path.unlink()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump Unity runtime truth for a UGUI Prefab")
    parser.add_argument("--project-root", default=".")
    parser.add_argument("--prefab", required=True)
    parser.add_argument("--canvas", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    truth = run_dump(args)
    print(f"wrote {truth.get('artifacts', {}).get('truthPath', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
