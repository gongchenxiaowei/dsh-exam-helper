#!/usr/bin/env python3
"""lib/finder.py —— 截图兜底：找选项行 / 导航按钮（H5 页面读不到文字节点时用）

用法: python3 finder.py <png> [rows]
输出: JSON {"rows":[{"y":..,"filled":bool}],"nav":{"next":y,"prev":y}}
"""
import json
import sys

try:
    from PIL import Image
except Exception as e:  # 没装 PIL 就明确说一声，别静默
    print(json.dumps({"error": f"PIL missing: {e}"}))
    sys.exit(0)


def is_marker(px):
    r, g, b = px[:3]
    return b > 180 and (b - r) > 40 and (b - g) > 20


def strong_blue(px):
    r, g, b = px[:3]
    return b > 200 and r < 160 and (b - r) > 60


def main():
    path = sys.argv[1]
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()

    hits = []
    for y in range(150, H):
        c = 0
        for x in range(60, 200, 2):
            if is_marker(px[x, y]):
                c += 1
        if c >= 3:
            hits.append(y)

    groups = []
    for y in hits:
        if groups and y - groups[-1][-1] <= 55:
            groups[-1].append(y)
        else:
            groups.append([y])

    rows = []
    for g in groups:
        a, b = g[0], g[-1]
        if b - a < 55:          # 太窄：可能是文字，不是选项框
            continue
        yc = (a + b) // 2
        filled = 0
        total = 0
        for yy in range(a, b + 1, 3):
            for xx in range(70, 190, 6):
                total += 1
                if strong_blue(px[xx, yy]):
                    filled += 1
        rows.append({"y": yc, "filled": total > 0 and filled / total > 0.5})

    # 导航：右侧（下一题/提交）与左侧（上一题）的独立蓝色文字块
    def text_blocks(x0, x1):
        ys = []
        for y in range(150, H):
            c = 0
            for x in range(x0, x1, 2):
                if strong_blue(px[x, y]):
                    c += 1
            if c >= 3:
                ys.append(y)
        gs = []
        for y in ys:
            if gs and y - gs[-1][-1] <= 30:
                gs[-1].append(y)
            else:
                gs.append([y])
        return [{"y": (g[0] + g[-1]) // 2, "h": g[-1] - g[0]} for g in gs]

    nav = {}
    right = [b for b in text_blocks(1000, 1360) if 20 <= b["h"] <= 160]
    left = [b for b in text_blocks(60, 330) if 20 <= b["h"] <= 160]
    if right:
        nav["next"] = max(right, key=lambda b: b["y"])["y"]
    if left:
        nav["prev"] = max(left, key=lambda b: b["y"])["y"]

    print(json.dumps({"rows": rows, "nav": nav, "size": [W, H]}))


if __name__ == '__main__':
    main()
