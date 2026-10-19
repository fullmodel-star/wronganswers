"""把 index.html 用到的 Tabler 線條圖示（MIT）做成內嵌 <svg> sprite，寫進 index.html 的標記之間。

    npm pack @tabler/icons@3.49.0   （在暫存資料夾）→ 解開 →
    python _tools/build_icon_sprite.py <解開後的 package 資料夾>

2026-10-19 版面美化「修練手帳」建立（照 605 _tools/build_icon_sprite.py）：篩選、清除、選取、複習範圍、
統計與設定卡標題、設定頁按鈕等操作類圖示一律用同一套線條圖示，取代原本混用的彩色 emoji。
用法：<svg class="ti"><use href="#ti-<id>"/></svg>。
- 只收下面 ICONS 用到的圖示；新增圖示＝加進 ICONS 後重跑，不要手改 sprite。
- 授權全文複製到 vendor/tabler-icons/LICENSE.txt。
- index.html 是 CRLF：用二進位讀寫，只換標記之間的內容，其他位元組不動。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
START = b"<!-- TABLER_SPRITE_START"
END = b"<!-- TABLER_SPRITE_END -->"

# (sprite id, Tabler 檔名, 樣式)
ICONS = [
    ("search", "search", "outline"),
    ("filter", "adjustments-horizontal", "outline"),
    ("x", "x", "outline"),
    ("list", "list-details", "outline"),
    ("grid", "layout-grid", "outline"),
    ("check", "checkbox", "outline"),
    ("flame", "flame", "outline"),
    ("star", "star", "outline"),
    ("star-f", "star", "filled"),
    ("camera", "camera", "outline"),
    ("photo", "photo", "outline"),
    ("trash", "trash", "outline"),
    ("upload", "upload", "outline"),
    ("download", "download", "outline"),
    ("plug", "plug-connected", "outline"),
    ("save", "device-floppy", "outline"),
    ("calendar", "calendar-event", "outline"),
    ("repeat", "repeat", "outline"),
    ("bolt", "bolt", "outline"),
    ("alert", "alert-octagon", "outline"),
    ("clock", "stopwatch", "outline"),
    ("target", "target", "outline"),
    ("books", "books", "outline"),
    ("chart", "chart-bar", "outline"),
    ("up", "trending-up", "outline"),
    ("down", "trending-down", "outline"),
    ("install", "device-mobile-down", "outline"),
    ("db", "database", "outline"),
    ("sparkles", "sparkles", "outline"),
    ("palette", "palette", "outline"),
    ("folders", "folders", "outline"),
    ("printer", "printer", "outline"),
    ("info", "info-circle", "outline"),
    ("back", "arrow-back-up", "outline"),
    ("refresh", "refresh", "outline"),
    ("pencil", "pencil", "outline"),
    ("file", "file-text", "outline"),
    ("eyeoff", "eye-off", "outline"),
]


def symbol(pkg: Path, sid: str, name: str, style: str) -> str:
    svg = (pkg / "icons" / style / f"{name}.svg").read_text(encoding="utf-8")
    paths = re.findall(r"<path[^>]*/>", svg)
    paths = [p for p in paths if 'stroke="none"' not in p]  # 去掉 24x24 透明底框
    if not paths:
        raise SystemExit(f"[FAIL] {style}/{name}.svg 沒有可用的 path")
    if style == "filled":
        attrs = 'fill="currentColor" stroke="none"'
    else:
        attrs = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    body = "".join(p.replace(" />", "/>") for p in paths)
    return f'<symbol id="ti-{sid}" viewBox="0 0 24 24" {attrs}>{body}</symbol>'


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    pkg = Path(sys.argv[1])
    version = json.loads((pkg / "package.json").read_text(encoding="utf-8"))["version"]
    syms = "".join(symbol(pkg, *i) for i in ICONS)
    block = (f"<!-- TABLER_SPRITE_START：Tabler Icons {version}（MIT，授權見 vendor/tabler-icons/LICENSE.txt）；"
             f"由 _tools/build_icon_sprite.py 產生，勿手改 -->\r\n"
             f'<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false">'
             f"{syms}</svg>\r\n").encode("utf-8")
    raw = HTML.read_bytes()
    a = raw.find(START)
    b = raw.find(END)
    if a < 0 or b < a:
        raise SystemExit("[FAIL] index.html 找不到 TABLER_SPRITE 標記")
    new = raw[:a] + block + raw[b:]
    HTML.write_bytes(new)
    lic = ROOT / "vendor" / "tabler-icons" / "LICENSE.txt"
    lic.parent.mkdir(parents=True, exist_ok=True)
    lic.write_bytes((pkg / "LICENSE").read_bytes())
    print(f"OK Tabler {version}：{len(ICONS)} 個圖示寫進 index.html（sprite {len(block)} bytes）")


if __name__ == "__main__":
    main()
