"""下載 Microsoft Fluent Emoji 的 3D 圖（MIT），縮成 128px PNG → vendor/fluent-3d/<key>.png

    python _tools/build_fluent3d.py
    （需要 Pillow：pip install pillow）

2026-10-19 版面美化「修練手帳」建立（照 605 _tools/build_fluent3d.py）：首屏主視覺、狀態列、功能圖格、
底部分頁／側欄圖示用 3D 立體圖。
- 來源：https://github.com/microsoft/fluentui-emoji （MIT，全文寫到 vendor/fluent-3d/LICENSE.txt）。
- 顯示最大約 96px，存 128px 給高解析螢幕。
- 下載後檢查是 PNG 檔頭（不是錯誤頁），不合格就停。
- 資料夾名大小寫要完全一樣（例：Bullseye 不是 Direct hit），錯了是 404。
"""
import io
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "vendor" / "fluent-3d"
BASE = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main"
SIZE = 128

# key → Fluent 資料夾名（index.html 用 vendor/fluent-3d/<key>.png）
ICONS = {
    "book": "Closed book",            # 首屏主視覺、錯題本分頁
    "pencil": "Pencil",               # 首屏主視覺、手動新增
    "fire": "Fire",                   # 連續天數、複習分頁
    "grad": "Graduation cap",         # 精熟
    "chart": "Bar chart",             # 統計分頁、弱點分析圖格
    "gear": "Gear",                   # 設定分頁
    "stopwatch": "Stopwatch",         # 限時模擬圖格
    "camera": "Camera with flash",    # 拍照新增圖格
    "search": "Magnifying glass tilted left",  # 搜尋圖格
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for key, folder in ICONS.items():
        fname = folder.lower().replace(" ", "_") + "_3d.png"
        url = f"{BASE}/assets/{urllib.parse.quote(folder)}/3D/{urllib.parse.quote(fname)}"
        raw = fetch(url)
        if not raw.startswith(b"\x89PNG"):
            print(f"[FAIL] {key}：{url} 不是 PNG"); sys.exit(1)
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
        dst = OUT / f"{key}.png"
        im.save(dst, optimize=True)
        print(f"OK {key:10s} {dst.stat().st_size // 1024} KB  ← {folder}")
    (OUT / "LICENSE.txt").write_bytes(fetch(f"{BASE}/LICENSE"))
    print("OK LICENSE.txt")


if __name__ == "__main__":
    main()
