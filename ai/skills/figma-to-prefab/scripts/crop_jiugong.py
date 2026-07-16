"""九宫源图裁剪：将全尺寸九宫源图裁剪为最小可拉伸尺寸。"""
import json, sys, os
from pathlib import Path
from PIL import Image
from unity_project_paths import normalize_asset_path, resolve_unity_project

import argparse

SPEC_PATH = ""
IMAGE_DIR = ""

def crop_nine_slice(img, left, right, top, bottom):
    """9slice: 9 宫格裁剪。"""
    sw, sh = img.size
    tw = left + right + 2
    th = top + bottom + 2
    dst = Image.new("RGBA", (tw, th))
    src_w_center = max(1, sw - left - right)
    src_h_center = max(1, sh - top - bottom)

    sections = [
        # name:  (sx, sy, sw, sh, dx, dy, dw, dh)
        ("TL", (0, 0, left, top), (0, 0, left, top)),
        ("TC", (left, 0, src_w_center, top), (left, 0, 2, top)),
        ("TR", (sw - right, 0, right, top), (left + 2, 0, right, top)),
        ("ML", (0, top, left, src_h_center), (0, top, left, 2)),
        ("MC", (left, top, src_w_center, src_h_center), (left, top, 2, 2)),
        ("MR", (sw - right, top, right, src_h_center), (left + 2, top, right, 2)),
        ("BL", (0, sh - bottom, left, bottom), (0, top + 2, left, bottom)),
        ("BC", (left, sh - bottom, src_w_center, bottom), (left, top + 2, 2, bottom)),
        ("BR", (sw - right, sh - bottom, right, bottom), (left + 2, top + 2, right, bottom)),
    ]
    for name, (sx, sy, sw2, sh2), (dx, dy, dw, dh) in sections:
        if sw2 <= 0 or sh2 <= 0 or dw <= 0 or dh <= 0:
            continue
        src_region = img.crop((sx, sy, sx + sw2, sy + sh2))
        if sw2 == dw and sh2 == dh:
            dst.paste(src_region, (dx, dy))
        else:
            dst.paste(src_region.resize((dw, dh), Image.LANCZOS), (dx, dy))
    return dst

def crop_h3slice(img, left, right):
    """h3slice: 水平 3 切片裁剪。"""
    sw, sh = img.size
    tw = left + right + 2
    dst = Image.new("RGBA", (tw, sh))
    src_center = max(1, sw - left - right)
    sections = [
        ("L", (0, 0, left, sh), (0, 0, left, sh)),
        ("C", (left, 0, src_center, sh), (left, 0, 2, sh)),
        ("R", (sw - right, 0, right, sh), (left + 2, 0, right, sh)),
    ]
    for name, (sx, sy, sw2, sh2), (dx, dy, dw, dh) in sections:
        if sw2 <= 0 or sh2 <= 0 or dw <= 0 or dh <= 0:
            continue
        src_region = img.crop((sx, sy, sx + sw2, sy + sh2))
        if sw2 == dw and sh2 == dh:
            dst.paste(src_region, (dx, dy))
        else:
            dst.paste(src_region.resize((dw, dh), Image.LANCZOS), (dx, dy))
    return dst

def crop_v3slice(img, top, bottom):
    """v3slice: 垂直 3 切片裁剪。"""
    sw, sh = img.size
    th = top + bottom + 2
    dst = Image.new("RGBA", (sw, th))
    src_center = max(1, sh - top - bottom)
    sections = [
        ("T", (0, 0, sw, top), (0, 0, sw, top)),
        ("C", (0, top, sw, src_center), (0, top, sw, 2)),
        ("B", (0, sh - bottom, sw, bottom), (0, top + 2, sw, bottom)),
    ]
    for name, (sx, sy, sw2, sh2), (dx, dy, dw, dh) in sections:
        if sw2 <= 0 or sh2 <= 0 or dw <= 0 or dh <= 0:
            continue
        src_region = img.crop((sx, sy, sx + sw2, sy + sh2))
        if sw2 == dw and sh2 == dh:
            dst.paste(src_region, (dx, dy))
        else:
            dst.paste(src_region.resize((dw, dh), Image.LANCZOS), (dx, dy))
    return dst

def main():
    global SPEC_PATH, IMAGE_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--spec", default="")
    parser.add_argument("--image-dir", default="Assets/_Resources/Sharders/Textures",
                        help="目标图片目录，默认为 Sharders/Textures/")
    args = parser.parse_args()
    try:
        unity_project = resolve_unity_project(args.unity_project)
    except RuntimeError as error:
        parser.error(str(error))
    SPEC_PATH = args.spec or str(unity_project / ".tmp" / "prefab_spec.json")
    raw_image_dir = Path(args.image_dir)
    IMAGE_DIR = str(raw_image_dir if raw_image_dir.is_absolute() else unity_project / normalize_asset_path(args.image_dir))
    with open(SPEC_PATH, encoding="utf-8") as f:
        spec = json.load(f)

    cropped = 0
    errors = 0
    for img_spec in spec.get("images", []):
        setting = json.loads(img_spec.get("spriteSettingJson", "{}"))
        border = setting.get("border", {})
        left = border.get("l", 0)
        right = border.get("r", 0)
        top = border.get("t", 0)
        bottom = border.get("b", 0)
        if left == 0 and right == 0 and top == 0 and bottom == 0:
            continue  # Simple image

        file_path = os.path.join(IMAGE_DIR, img_spec["fileName"])
        if not os.path.exists(file_path):
            print(f"  [SKIP] {img_spec['fileName']} (not found)")
            continue

        img = Image.open(file_path).convert("RGBA")
        sw, sh = img.size

        # Determine slice type from border pattern
        if left > 0 and right > 0 and top > 0 and bottom > 0:
            fn_type = "9slice"
            min_w = left + right + 2
            min_h = top + bottom + 2
        elif left > 0 or right > 0:
            fn_type = "h3slice"
            min_w = left + right + 2
            min_h = sh
        else:
            fn_type = "v3slice"
            min_w = sw
            min_h = top + bottom + 2

        if sw <= min_w and sh <= min_h:
            print(f"  [OK] {img_spec['fileName']} ({sw}x{sh} <= {min_w}x{min_h})")
            continue

        if fn_type == "9slice":
            dst = crop_nine_slice(img, left, right, top, bottom)
        elif fn_type == "h3slice":
            dst = crop_h3slice(img, left, right)
        else:
            dst = crop_v3slice(img, top, bottom)
        dst.save(file_path, "PNG")
        print(f"  [CROP] {img_spec['fileName']}: {sw}x{sh} -> {min_w}x{min_h}")
        cropped += 1
        img.close()

    print(f"\n完成: 裁剪 {cropped}, 错误 {errors}")

if __name__ == "__main__":
    main()
