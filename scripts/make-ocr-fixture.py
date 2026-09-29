#!/usr/bin/env python3
"""Render the OCR fixture used by the Rust tests: a mock centre-of-screen
augment choice with real names and effects from src-tauri/data/augments.json."""

import json
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src-tauri" / "data" / "augments.json"
OUT = ROOT / "src-tauri" / "tests" / "fixtures" / "augment-card.png"
FONT = "/System/Library/Fonts/STHeiti Light.ttc"
WANTED = ["万用瞄准镜", "亮出你的剑", "巨像的勇气"]

W, H = 1600, 900
CARD_W, CARD_H, GAP = 460, 560, 40
MARGIN_TOP = 170


def load_augments() -> dict[str, dict]:
    with DATA.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    items = payload if isinstance(payload, list) else payload.get("augments", [])
    return {item["name"]: item for item in items}


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def wrap(text: str, size: int, width: int) -> list[str]:
    return textwrap.wrap(text, width=width, break_long_words=True, break_on_hyphens=False)


def main() -> None:
    augments = load_augments()
    chosen = []
    for name in WANTED:
        if name not in augments:
            raise SystemExit(f"missing augment in data: {name}")
        chosen.append(augments[name])

    total = CARD_W * len(chosen) + GAP * (len(chosen) - 1)
    start_x = (W - total) // 2

    image = Image.new("RGB", (W, H), (1, 10, 19))
    draw = ImageDraw.Draw(image)
    name_font, rarity_font, effect_font = font(46), font(24), font(26)

    rarity_label = {"silver": "银色海克斯", "gold": "金色海克斯", "prismatic": "棱彩海克斯"}

    for index, augment in enumerate(chosen):
        x = start_x + index * (CARD_W + GAP)
        y = MARGIN_TOP
        draw.rectangle([x, y, x + CARD_W, y + CARD_H], fill=(10, 20, 40), outline=(120, 90, 40), width=3)
        draw.text((x + 32, y + 40), augment["name"], font=name_font, fill=(240, 230, 210))
        draw.text(
            (x + 32, y + 110),
            rarity_label.get(augment.get("rarity", ""), augment.get("rarity", "")),
            font=rarity_font,
            fill=(200, 160, 90),
        )
        effect = augment.get("effect", "")
        line_y = y + 180
        for line in wrap(effect, 26, 15):
            draw.text((x + 32, line_y), line, font=effect_font, fill=(200, 197, 186))
            line_y += 44

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, "PNG")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
