#!/usr/bin/env python3
"""Generate synthetic, offline OCR benchmark panels from the bundled catalog.

No desktop capture, model inference, downloads, or runtime resource writes occur.
Only PNGs and manifest.json under src-tauri/target/ocr-benchmark-corpus are
written. The manifest is authoritative; old, unreferenced PNGs are not deleted.

Requires Pillow. Example (from the repository root):
    python scripts/make-ocr-benchmark-corpus.py
    python scripts/make-ocr-benchmark-corpus.py --font C:/Windows/Fonts/msyh.ttc

These are synthetic rendering/identity regressions, NOT a real-game accuracy
benchmark. In particular, they do not model all game fonts, motion, UI scales,
anti-aliasing, localization, panel transitions, or screen capture conditions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "src-tauri" / "data" / "augments.json"
OUTPUT = ROOT / "src-tauri" / "target" / "ocr-benchmark-corpus"
DEFAULT_FONT = "C:/Windows/Fonts/msyh.ttc"
RARITY_LABELS = {"silver": "银色海克斯", "gold": "金色海克斯", "prismatic": "棱彩海克斯"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", default=DEFAULT_FONT, help="Local CJK font file; no download occurs")
    parser.add_argument("--sizes", type=int, nargs="+", default=[46, 30, 20], help="Title pixel sizes")
    parser.add_argument(
        "--limit-groups", type=int, default=None,
        help="Smoke-test only: generate this many catalog groups per size (default: all)",
    )
    args = parser.parse_args()
    if any(size < 16 or size > 64 for size in args.sizes):
        parser.error("--sizes must be between 16 and 64")
    if args.limit_groups is not None and args.limit_groups < 1:
        parser.error("--limit-groups must be positive")
    args.sizes = list(dict.fromkeys(args.sizes))
    args.font = Path(args.font).resolve(strict=True)
    return args


def load_catalog() -> tuple[list[dict[str, Any]], str]:
    raw = CATALOG.read_bytes()
    document = json.loads(raw)
    entries = document if isinstance(document, list) else document["augments"]
    entries = sorted(entries, key=lambda item: int(item["id"]))
    if len(entries) < 6 or len({str(item["id"]) for item in entries}) != len(entries):
        raise ValueError("catalog must contain at least six distinct IDs")
    if any(not str(item.get("name", "")).strip() for item in entries):
        raise ValueError("catalog contains an empty name")
    return entries, hashlib.sha256(raw).hexdigest()


def output_path(filename: str) -> Path:
    # This benchmark must never follow a directory/file link into user data.
    if OUTPUT.resolve() != OUTPUT.absolute():
        raise ValueError("refusing a redirected benchmark output directory")
    path = OUTPUT / filename
    if path.resolve().parent != OUTPUT or path.is_symlink():
        raise ValueError("refusing a redirected benchmark output file")
    return path


class Renderer:
    def __init__(self, font_path: Path) -> None:
        self.font_path = font_path

    @lru_cache(maxsize=64)
    def font(self, size: int) -> ImageFont.FreeTypeFont:
        return ImageFont.truetype(str(self.font_path), size=size)

    def fit_title(self, text: str, requested_size: int, max_width: int) -> ImageFont.FreeTypeFont:
        for size in range(requested_size, 11, -1):
            result = self.font(size)
            if result.getlength(text) <= max_width:
                return result
        raise ValueError("title cannot fit the synthetic card")

    def wrap(self, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
        lines, current = [], ""
        for character in text:
            if character == "\n":
                if current:
                    lines.append(current)
                current = ""
            elif current and font.getlength(current + character) > max_width:
                lines.append(current)
                current = character
            else:
                current += character
        if current:
            lines.append(current)
        return lines

    def panel(
        self, rows: list[list[dict[str, Any]]], title_size: int, *, markers: bool = True,
        columns: int = 3, column_positions: list[int] | None = None,
    ) -> tuple[Image.Image, list[dict[str, Any]]]:
        width, height = 1680, 900
        image = Image.new("RGB", (width, height), (1, 10, 19))
        draw = ImageDraw.Draw(image)
        margin, gap = 48, 36
        card_width = (width - margin * 2 - gap * (columns - 1)) // columns
        row_gap = 34
        card_height = (height - margin * 2 - row_gap * (len(rows) - 1)) // len(rows)
        metadata = []
        for row_index, entries in enumerate(rows):
            top = margin + row_index * (card_height + row_gap)
            positions = column_positions if column_positions is not None else list(range(len(entries)))
            for column, item in zip(positions, entries):
                left = margin + column * (card_width + gap)
                right, bottom = left + card_width, top + card_height
                draw.rectangle((left, top, right, bottom), fill=(10, 20, 40), outline=(120, 90, 40), width=3)
                name = str(item["name"])
                title_font = self.fit_title(name, title_size, card_width - 48)
                title_x = left + (card_width - title_font.getlength(name)) / 2
                title_y = top + 34
                # Centering makes the physical card centers independent of name length.
                title_box = draw.textbbox((title_x, title_y), name, font=title_font)
                draw.text((title_x, title_y), name, font=title_font, fill=(240, 230, 210))
                metadata.append({
                    "id": str(item["id"]), "name": name, "row": row_index, "column": column,
                    "titleFontSize": title_font.size, "titleBounds": list(title_box),
                })
                body_top = top + 34 + max(title_size, 46) + 72
                if markers:
                    rarity_font = self.font(max(16, round(title_size * 0.52)))
                    rarity = RARITY_LABELS.get(str(item.get("rarity", "")), "银色海克斯")
                    draw.text((left + 24, top + 34 + max(title_size, 46) + 20), rarity,
                              font=rarity_font, fill=(200, 160, 90))
                body_font = self.font(max(16, round(title_size * 0.57)))
                line_height = round(body_font.size * 1.55)
                for text in self.wrap(str(item.get("effect", "")), body_font, card_width - 48):
                    if body_top + line_height > bottom - 24:
                        break
                    draw.text((left + 24, body_top), text, font=body_font, fill=(200, 197, 186))
                    body_top += line_height
        return image, metadata


def main() -> None:
    args = parse_args()
    entries, catalog_hash = load_catalog()
    renderer = Renderer(args.font)
    # Verify the selected font before any output is created.
    renderer.font(args.sizes[0])
    output_path("manifest.json")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    cases: list[dict[str, Any]] = []

    def add(
        case_id: str, rows: list[list[dict[str, Any]]], size: int, expected: list[dict[str, Any]],
        *, description: str, markers: bool = True, columns: int = 3,
        column_positions: list[int] | None = None,
    ) -> None:
        image, rendered = renderer.panel(rows, size, markers=markers, columns=columns,
                                         column_positions=column_positions)
        filename = f"{case_id}.png"
        image.save(output_path(filename), "PNG", compress_level=3)
        cases.append({
            "id": case_id, "file": filename, "description": description,
            "shouldMatch": bool(expected), "expectedIds": [str(item["id"]) for item in expected],
            "fontSize": size, "kind": "positive" if expected else "negative",
            "expectedNames": [str(item["name"]) for item in expected],
            "width": image.width, "height": image.height, "requestedTitleSize": size,
            "panelMarkers": markers, "rendered": rendered,
        })

    groups = math.ceil(len(entries) / 3)
    if args.limit_groups is not None:
        groups = min(groups, args.limit_groups)
    for size in args.sizes:
        for group in range(groups):
            trio = [entries[(group * 3 + index) % len(entries)] for index in range(3)]
            add(f"catalog-{group:03d}-size-{size}", [trio], size, trio,
                description="Three distinct catalog names, in left-to-right card order")

    by_length = sorted(entries, key=lambda item: (len(item["name"]), int(item["id"])))
    mixed = [by_length[0], by_length[-1], by_length[len(by_length) // 2]]
    for size in args.sizes:
        add(f"mixed-length-size-{size}", [mixed], size, mixed,
            description="Short, longest, and medium title lengths in the same panel")

    by_name = {item["name"]: item for item in entries}
    similar_names = ["万用瞄准镜", "更万用的瞄准镜", "最万用的瞄准镜"]
    if all(name in by_name for name in similar_names):
        trio = [by_name[name] for name in similar_names]
        add("similar-names", [trio], 30, trio,
            description="Distinct identities with shared title substrings; no substring substitution")

    # Fixed, short titles make the negative layouts geometrically unambiguous.
    # These are synthetic non-panel examples: all must yield zero candidates.
    chosen = [by_name[name] for name in ["万用瞄准镜", "亮出你的剑", "巨像的勇气", "珠光护手",
                                          "科学狂人", "无限循环往复"] if name in by_name]
    if len(chosen) != 6:
        chosen = entries[:6]
    add("negative-four-cards", [chosen[:4]], 30, [], columns=4,
        description="Four distinct aligned cards produce multiple possible triples; reject all")
    add("negative-two-rows", [chosen[:3], chosen[3:6]], 30, [],
        description="Two valid-looking title rows are ambiguous; reject all")
    add("negative-two-cards-no-marker", [[chosen[0], chosen[2]]], 30, [], markers=False,
        column_positions=[0, 2],
        description="Two exact titles without nearby panel marker are insufficient")
    add("negative-duplicate-identities", [[chosen[0], chosen[1], chosen[0]]], 30, [], markers=False,
        description="Repeated first/third identity without a marker cannot form a candidate panel")

    covered = sorted({title["id"] for case in cases if case["shouldMatch"] for title in case["rendered"]},
                     key=int)
    manifest = {
        "schemaVersion": 1, "syntheticOnly": True,
        "limitations": "Offline synthetic rendering tests only; not real-game OCR accuracy evidence.",
        "catalogSha256": catalog_hash, "catalogCount": len(entries), "fontFile": args.font.name,
        "titleSizes": args.sizes, "coveredCatalogIds": covered,
        "allCatalogNamesCovered": len(covered) == len(entries),
        "positiveCaseCount": sum(case["shouldMatch"] for case in cases),
        "negativeCaseCount": sum(not case["shouldMatch"] for case in cases), "cases": cases,
    }
    output_path("manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                            encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "cases": len(cases),
                      "positive": manifest["positiveCaseCount"], "negative": manifest["negativeCaseCount"],
                      "catalogNamesCovered": len(covered), "catalogCount": len(entries)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
