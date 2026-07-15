"""手工精确拆分 code.js。基于 landmark 函数位置。"""
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
SRC = BASE / "code.js"
OUT = BASE / "code"

lines = SRC.read_text(encoding="utf-8").split("\n")
total = len(lines)
print(f"Original: {total} lines")

# 手工定义分界点: [(文件名, 起始行(1-based), 结束行(1-based))]
# 基于代码中的 landmark 函数精确切分
SPLITS = [
    # init: showUI → router 结束
    ("00_init.js", 1, 94),

    # 所有 handler 包装函数
    ("01_handlers.js", 95, 368),

    # prefab→figma: handlePrefabToFigmaWrite → writePrefabToFigmaJob → sub-fns
    ("02_prefab_to_figma.js", 369, 1276),

    # figma→prefab: exportFigmaToPrefabJob + exportFigmaPrefabImages + utils
    # (from exportFigmaToPrefabJob up to analyzeFigmaHierarchyCleanupJob)
    ("03_figma_to_prefab.js", 1277, 1650),

    # hierarchy + component set + query + grid
    # (from buildHierarchyCleanupErrorResult up to but not including importPsdJob)
    ("04_hierarchy.js", 1651, 4851),

    # PSD impl + verify + 九宫检测 + 工具函数
    # (from importPsdJob to end of file)
    ("05_utils.js", 4852, total),
]

# 验证覆盖率
covered = set()
for name, start, end in SPLITS:
    for i in range(start - 1, end):
        covered.add(i)
uncovered = [i for i in range(total) if i not in covered]
if uncovered:
    # 显示未覆盖的连续区间
    ranges = []
    r_start = uncovered[0]
    for i in range(1, len(uncovered)):
        if uncovered[i] != uncovered[i-1] + 1:
            ranges.append((r_start + 1, uncovered[i-1] + 1))
            r_start = uncovered[i]
    ranges.append((r_start + 1, uncovered[-1] + 1))
    print(f"\nWARNING: {len(uncovered)} uncovered lines:")
    for rs, re in ranges[:5]:
        print(f"  Lines {rs}-{re}")
    if len(ranges) > 5:
        print(f"  ... and {len(ranges)-5} more ranges")

# 写文件
OUT.mkdir(parents=True, exist_ok=True)
for old in OUT.glob("*.js"):
    old.unlink()

out_total = 0
for name, start, end in SPLITS:
    chunk = lines[start-1:end]
    content = "\n".join(chunk).strip()
    if not content:
        print(f"  SKIP {name}: empty")
        continue
    (OUT / name).write_text(content + "\n", encoding="utf-8")
    lc = content.count("\n") + 1
    out_total += lc
    print(f"  {name}: {start}-{end} ({lc} lines)")

print(f"\nTotal: {out_total} lines (original: {total})")
print(f"Diff: {out_total - total:+d}")
