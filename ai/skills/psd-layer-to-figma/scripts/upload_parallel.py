"""
并发上传 PSD 图层 PNG 到 Figma upload URLs。

使用 requests + ThreadPoolExecutor，Windows 兼容性好，不依赖 aiohttp。

用法：
    python upload_parallel.py <mapping.json> [--max-concurrent 8]

mapping.json 格式：
{
  "uploads": [
    { "url": "https://mcp.figma.com/mcp/upload/xxx/submit?scaleMode=FILL", "file": "path/to/image.png" },
    ...
  ]
}

输出（stdout JSON）：
{
  "results": [
    { "file": "path/to/image.png", "imageHash": "abc123...", "success": true },
    ...
  ],
  "successCount": 23,
  "failCount": 0,
  "totalCount": 23,
  "elapsedSeconds": 3.2
}

依赖：requests（Python 标准生态，通常已预装）
"""

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import requests
except ImportError:
    print(json.dumps({"error": "requests not installed. Run: pip install requests"}))
    sys.exit(1)


def upload_one(url, file_path):
    """上传单个文件，返回结果字典。"""
    try:
        data = Path(file_path).read_bytes()
        resp = requests.post(url, data=data, headers={"Content-Type": "image/png"}, timeout=60)
        if resp.status_code == 200:
            body = resp.json()
            return {
                "file": file_path,
                "imageHash": body.get("imageHash", ""),
                "placedOnNodeId": body.get("placedOnNodeId", ""),
                "success": True
            }
        else:
            return {"file": file_path, "error": f"HTTP {resp.status_code}: {resp.text[:200]}", "success": False}
    except Exception as e:
        return {"file": file_path, "error": str(e), "success": False}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: upload_parallel.py <mapping.json> [--max-concurrent N]"}))
        sys.exit(1)

    mapping_path = sys.argv[1]
    max_concurrent = 8

    if "--max-concurrent" in sys.argv:
        idx = sys.argv.index("--max-concurrent")
        if idx + 1 < len(sys.argv):
            max_concurrent = int(sys.argv[idx + 1])

    with open(mapping_path, "r", encoding="utf-8") as f:
        mapping = json.load(f)

    uploads = mapping.get("uploads", [])
    if not uploads:
        print(json.dumps({"error": "No uploads in mapping file", "results": []}))
        sys.exit(0)

    start = time.time()
    results = []

    with ThreadPoolExecutor(max_workers=max_concurrent) as executor:
        futures = {
            executor.submit(upload_one, item["url"], item["file"]): item
            for item in uploads
        }
        for future in as_completed(futures):
            results.append(future.result())

    elapsed = time.time() - start
    success_count = sum(1 for r in results if r["success"])

    output = {
        "results": results,
        "successCount": success_count,
        "failCount": len(results) - success_count,
        "totalCount": len(results),
        "elapsedSeconds": round(elapsed, 2)
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
