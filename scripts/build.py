"""构建 Figma MCP Relay 插件产物。

职责：
- 拼接 code/ 目录下的 .js 文件为 code.js（按指定顺序）。
- 将 prompts/ 目录下的 AI 提示词 Markdown 同步内联到 ui.html。
- 注入递增构建版本号，确保 Figma 开发者模式每次加载最新 code.js。
"""
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
CODE_DIR = BASE / "code"
OUTPUT = BASE / "code.js"
UI_HTML = BASE / "ui.html"
BRIDGE_SERVER = BASE / "unity" / "Assets" / "Editor" / "FigmaBridge" / "FigmaBridgeServer.cs"
PROMPTS_DIR = BASE / "prompts"
PACKAGE_JSON = BASE / "package.json"

RELEASE_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
RELEASE_VERSION_MARKER = re.compile(
    r"(<!-- BEGIN_RELEASE_VERSION -->)v[^<]*(<!-- END_RELEASE_VERSION -->)",
)
BRIDGE_RELEASE_VERSION_MARKER = re.compile(
    r'(// BEGIN_RELEASE_VERSION\s+private const string Version = ")[^"]+(";\s+// END_RELEASE_VERSION)',
)

# 构建版本计数器（持久化文件），仅用于破坏 Figma 缓存
BUILD_VERSION_FILE = BASE / ".build_version"
BUILD_VERSION = 0
if BUILD_VERSION_FILE.exists():
    try:
        BUILD_VERSION = int(BUILD_VERSION_FILE.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        BUILD_VERSION = 1

ORDER = [
    "03_image_health.mjs",
    "00_init.js",
    "01_handlers.js",
    "02_prefab_to_figma.js",
    "03_figma_to_prefab.js",
    "04_hierarchy.js",
    "05_utils.js",
    "06_psd_incremental.mjs",
    "07_cleanup_snapshot.mjs",
]

PROMPT_FILES = {
    "cleanup": "cleanup.md",
    "componentVariants": "component-variants.md",
    "unity": "unity.md",
}


def find_prompt_placeholders(content):
    """提取模板占位符，便于构建日志诊断。"""
    return sorted(set(re.findall(r"\{\{(\w+)\}\}", content)))


def build_prompt_block():
    """读取 prompts/*.md 并生成可直接内联到 ui.html 的 JS 模板对象。"""
    missing = []
    templates = {}
    for key, filename in PROMPT_FILES.items():
        path = PROMPTS_DIR / filename
        if not path.exists():
            missing.append(filename)
            continue
        content = path.read_text(encoding="utf-8").strip()
        templates[key] = content
        placeholders = ",".join(find_prompt_placeholders(content)) or "-"
        print(f"  prompt {key}: {filename}, chars={len(content)}, placeholders={placeholders}")
    if missing:
        raise FileNotFoundError("missing prompt template(s): " + ", ".join(missing))

    lines = [
        "    // BEGIN_AI_PROMPT_TEMPLATES",
        "    const AiPromptTemplates = {",
    ]
    entries = list(PROMPT_FILES.keys())
    for index, key in enumerate(entries):
        comma = "," if index < len(entries) - 1 else ""
        lines.append(f"      {json.dumps(key, ensure_ascii=False)}: {json.dumps(templates[key], ensure_ascii=False)}{comma}")
    lines.extend([
        "    };",
        "    // END_AI_PROMPT_TEMPLATES",
    ])
    return "\n".join(lines)


def sync_prompt_templates():
    """把 Markdown 提示词模板替换进 ui.html 中的标记区。"""
    if not UI_HTML.exists():
        print("ui.html not found, skip prompt sync")
        return
    html = UI_HTML.read_text(encoding="utf-8")
    pattern = re.compile(
        r"    // BEGIN_AI_PROMPT_TEMPLATES\n.*?    // END_AI_PROMPT_TEMPLATES",
        re.DOTALL,
    )
    block = build_prompt_block()
    new_html, count = pattern.subn(lambda _match: block, html, count=1)
    if count != 1:
        raise RuntimeError("AI prompt template marker block not found or duplicated in ui.html")
    UI_HTML.write_text(new_html, encoding="utf-8")
    print(f"ui.html: synced {len(PROMPT_FILES)} AI prompt templates from prompts/")


def sync_marked_release_version(path, pattern, version, label):
    """更新一个且仅一个带标记的发布版本。"""
    if not path.exists():
        raise FileNotFoundError(f"{label} not found: {path}")

    content = path.read_text(encoding="utf-8")
    marker_count = len(pattern.findall(content))
    if marker_count != 1:
        raise RuntimeError(f"release version marker block not found or duplicated in {label}")

    updated, count = pattern.subn(lambda match: f"{match.group(1)}{version}{match.group(2)}", content, count=1)
    if count != 1:
        raise RuntimeError(f"release version marker block could not be updated in {label}")
    path.write_text(updated, encoding="utf-8")


def sync_release_version():
    """将 package.json 的发布版本同步到插件面板和 Unity Bridge。"""
    if not PACKAGE_JSON.exists():
        raise FileNotFoundError(f"package.json not found: {PACKAGE_JSON}")

    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    version = package.get("version")
    if not isinstance(version, str) or not RELEASE_VERSION_PATTERN.fullmatch(version):
        raise RuntimeError(f"package.json contains an invalid semantic version: {version!r}")

    sync_marked_release_version(UI_HTML, RELEASE_VERSION_MARKER, f"v{version}", "ui.html")
    sync_marked_release_version(BRIDGE_SERVER, BRIDGE_RELEASE_VERSION_MARKER, version, "FigmaBridgeServer.cs")
    print(f"release version {version}: synced ui.html and FigmaBridgeServer.cs from package.json")


def build():
    global BUILD_VERSION
    sync_prompt_templates()
    sync_release_version()

    if not CODE_DIR.exists():
        raise FileNotFoundError(f"code/ directory not found: {CODE_DIR}")

    lines = []
    missing = []
    empty = []
    for name in ORDER:
        f = CODE_DIR / name
        if not f.exists():
            missing.append(name)
            continue
        content = f.read_text(encoding="utf-8").strip()
        if f.suffix == ".mjs":
            content = re.sub(r"^export\s+", "", content, flags=re.MULTILINE)
        if not content:
            empty.append(name)
            continue
        lines.append(content)
        print(f"  + {name} ({len(content.splitlines())} lines)")
    if missing or empty:
        details = []
        if missing:
            details.append("missing: " + ", ".join(missing))
        if empty:
            details.append("empty: " + ", ".join(empty))
        raise FileNotFoundError("required Figma plugin code fragment(s) invalid: " + "; ".join(details))

    # 注入构建版本号（递增整数），每次重新打开插件时可确认加载的是最新构建
    # 版本号变化会让 Figma 在下次 Run Plugin 时重新读取 code.js（不清缓存即可）
    version = BUILD_VERSION + 1
    BUILD_VERSION = version
    # 在拼接后的完整代码中替换 BUILD_NUMBER 占位符为实际版本号
    # (避免使用 JS 变量传递，因为 Figma JSVM 沙箱可能限制顶级作用域)
    lines.insert(0, f"// Figma MCP Relay build #{version}")

    # 在拼接后的完整代码中替换 __BUILD_NUMBER__ 占位符为实际版本号
    code_text = "\n".join(lines) + "\n"
    # 直接检查并替换
    replaced_count = code_text.count("__BUILD_NUMBER__")
    code_text = code_text.replace("__BUILD_NUMBER__", str(version))
    print(f"  replacement: __BUILD_NUMBER__ -> {version} ({replaced_count} occurrences)")

    # 持久化构建版本号
    BUILD_VERSION_FILE.write_text(str(version), encoding="utf-8")

    OUTPUT.write_text(code_text, encoding="utf-8")

    # manifest.json 的 ui 保持干净文件路径，Figma 不支持 ?v=N
    manifest_path = BASE / "manifest.json"
    if manifest_path.exists():
        manifest_text = manifest_path.read_text(encoding="utf-8")
        manifest_text = re.sub(
            r'("ui"\s*:\s*"ui\.html)\??[^"]*(")',
            r'\1\2',
            manifest_text,
        )
        manifest_path.write_text(manifest_text, encoding="utf-8")
        print(f"  manifest.json: ui path reverted to clean ui.html")

    total = OUTPUT.read_text(encoding="utf-8").count("\n") + 1
    print(f"\ncode.js: {total} lines from {len(lines)} files (build #{version})")
    print()

if __name__ == "__main__":
    build()
