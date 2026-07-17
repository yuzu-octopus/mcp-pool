#!/usr/bin/env python3
"""Generate project page HTML from TOML data + Jinja2 template."""

import argparse
import math
import re
import tomllib
from datetime import UTC, datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

HERE = Path(__file__).parent
TEMPLATE = "template.html.j2"


def load_toml(path: Path) -> dict:
    with path.open("rb") as f:
        return tomllib.load(f)


KNOWN_SECTION_TYPES = {
    "features", "table", "steps", "terms", "code_block", "stack", "text", "links", "custom",
    "notice", "timeline", "workflow",
}

REQUIRED_TOP_KEYS = {"project", "brand", "sections"}
REQUIRED_PROJECT_KEYS = {
    "name", "tagline", "subtitle", "description",
    "github_url", "page_url", "logo_svg",
}


_ITEMS_TYPES = {"features", "steps", "stack", "links", "timeline", "workflow", "terms"}
_BODY_TYPES = {"text", "custom", "notice"}
_VALID_NOTICE_TYPES = {"info", "warning", "success", "error"}


_ITEM_KEYS = {
    "features": ("title", "body"),
    "steps": ("title", "body"),
    "stack": ("name", "description"),
    "links": ("title", "url", "description"),
    "timeline": ("title", "body"),
    "workflow": ("title", "body"),
    "terms": ("term", "definition"),
}


def _validate_section_fields(section: dict, index: int, st: str) -> None:
    if st in _ITEMS_TYPES:
        items = section.get("items")
        if not isinstance(items, list):
            msg = f"sections[{index}] type='{st}' requires 'items' to be a list"
            raise SystemExit(msg)
        required = _ITEM_KEYS.get(st, ())
        for j, item in enumerate(items):
            if not isinstance(item, dict):
                msg = f"sections[{index}].items[{j}] must be a dict"
                raise SystemExit(msg)
            for key in required:
                if key not in item:
                    msg = f"sections[{index}].items[{j}] type='{st}' requires '{key}'"
                    raise SystemExit(msg)
    elif st == "code_block":
        if "code" not in section or not isinstance(section["code"], str):
            msg = f"sections[{index}] type='code_block' requires 'code' (string)"
            raise SystemExit(msg)
    elif st == "table":
        if "headers" not in section or not isinstance(section["headers"], list):
            msg = f"sections[{index}] type='table' requires 'headers' (list)"
            raise SystemExit(msg)
        if "rows" not in section or not isinstance(section["rows"], list):
            msg = f"sections[{index}] type='table' requires 'rows' (list)"
            raise SystemExit(msg)
        for j, row in enumerate(section["rows"]):
            if not isinstance(row, dict) or "cells" not in row or not isinstance(row["cells"], list):
                msg = f"sections[{index}].rows[{j}] requires 'cells' (list)"
                raise SystemExit(msg)
    elif st in _BODY_TYPES:
        if "body" not in section or not isinstance(section["body"], str):
            msg = f"sections[{index}] type='{st}' requires 'body' (string)"
            raise SystemExit(msg)
        if st == "notice" and "notice_type" in section and section["notice_type"] not in _VALID_NOTICE_TYPES:
                valid = ", ".join(sorted(_VALID_NOTICE_TYPES))
                msg = f"sections[{index}] notice_type must be one of: {valid}"
                raise SystemExit(msg)


def validate(data: dict) -> None:
    missing = REQUIRED_TOP_KEYS - data.keys()
    if missing:
        msg = f"Missing top-level keys: {', '.join(sorted(missing))}"
        raise SystemExit(msg)

    project = data.get("project", {})
    if not isinstance(project, dict):
        msg = "project must be a table"
        raise SystemExit(msg)
    for key in REQUIRED_PROJECT_KEYS:
        if key not in project:
            msg = f"Missing project.{key}"
            raise SystemExit(msg)

    brand = data.get("brand", {})
    if not isinstance(brand, dict):
        msg = "brand must be a table"
        raise SystemExit(msg)
    if "tagline" not in brand:
        msg = "Missing brand.tagline"
        raise SystemExit(msg)

    sections = data.get("sections", [])
    if not isinstance(sections, list) or not sections:
        msg = "sections must be a non-empty array"
        raise SystemExit(msg)

    for i, section in enumerate(sections):
        for key in ("id", "type", "icon"):
            if key not in section:
                msg = f"sections[{i}] missing required field '{key}'"
                raise SystemExit(msg)

        sid = section["id"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", sid):
            msg = f"sections[{i}] id must match [a-zA-Z0-9_-]+, got '{sid}'"
            raise SystemExit(msg)

        st = section["type"]
        if st not in KNOWN_SECTION_TYPES:
            valid = ", ".join(sorted(KNOWN_SECTION_TYPES))
            msg = f"sections[{i}] unknown type '{st}'. Valid types: {valid}"
            raise SystemExit(msg)

        _validate_section_fields(section, i, st)


def render(template_name: str, data: dict) -> str:
    data["current_year"] = datetime.now(UTC).year
    env = Environment(
        loader=FileSystemLoader(HERE),
        autoescape=False,  # noqa: S701 — trusted TOML input, static site output
    )
    template = env.get_template(template_name)
    return template.render(**data)


def _extract_logo_inner(logo_svg: str) -> tuple[str, str]:
    """Extract inner content + viewBox from a logo SVG.

    Returns (inner_svg_content, viewBox_string).
    """
    resolved = logo_svg
    resolved = re.sub(r"<\?xml[^>]*\?>", "", resolved).strip()
    vb_match = re.search(r'viewBox="([^"]*)"', resolved)
    viewBox = vb_match.group(1) if vb_match else "0 0 64 64"
    svg_start = re.search(r"<svg[^>]*>", resolved)
    if not svg_start:
        return resolved, viewBox
    inner_start = svg_start.end()
    svg_end = resolved.rfind("</svg>")
    inner = resolved[inner_start:svg_end].strip() if svg_end != -1 else resolved[inner_start:]
    return inner, viewBox


def _find_jetbrains_font(weight: str = "Regular") -> str | None:
    """Find a JetBrains Mono TTF file on the system."""
    search_dirs = [
        Path.home() / "Library" / "Fonts",  # macOS user fonts
        Path("/Library/Fonts"),               # macOS system fonts
        Path("/opt/homebrew/share/fonts"),   # macOS Homebrew (Apple Silicon)
        Path("/usr/local/share/fonts"),      # macOS Homebrew (Intel) / Linux
        Path("/usr/share/fonts"),            # Linux system fonts
        Path.home() / ".fonts",              # Linux per-user
        Path.home() / ".local" / "share" / "fonts",  # Linux XDG
    ]
    patterns = [
        f"JetBrainsMono-{weight}.ttf",
        f"JetBrainsMono{weight}.ttf",
        "JetBrainsMono*.ttf",
    ]
    for base in search_dirs:
        if not base.is_dir():
            continue
        for pat in patterns:
            matches = sorted(base.rglob(pat))
            if matches:
                return str(matches[0])
    return None


def _wrap_text(draw, text: str, font, max_width: int) -> list[str]:
    """Wrap text into lines that fit within max_width pixels using word boundaries."""
    words = text.split()
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        test_line = " ".join([*current, word])
        bbox = draw.textbbox((0, 0), test_line, font=font)
        if bbox[2] - bbox[0] <= max_width:
            current.append(word)
        else:
            if current:
                lines.append(" ".join(current))
            current = [word]
    if current:
        lines.append(" ".join(current))
    return lines or [text]


def _truncate_text(draw, text: str, font, max_width: int) -> str:
    """Truncate text with ellipsis to fit within max_width pixels."""
    bbox = draw.textbbox((0, 0), text, font=font)
    if bbox[2] - bbox[0] <= max_width:
        return text
    while len(text) > 1:
        text = text[:-1]
        bbox = draw.textbbox((0, 0), text + "...", font=font)
        if bbox[2] - bbox[0] <= max_width:
            return text + "..."
    return text[:1] + "..."


def generate_og_image(project: dict, output_path: Path) -> None:
    """Generate a 1200x630 OG preview PNG using Pillow + cairosvg for the logo.

    Layout: logo on the left (vertically centered), project name / tagline /
    subtitle on the right with proper text wrapping and Dracula theme colors.
    Uses the system JetBrains Mono font if available, falls back to default.
    """
    try:
        from io import BytesIO

        import cairosvg
        from PIL import Image, ImageDraw, ImageFont
    except (ImportError, OSError) as e:
        print(f"  ! Dependencies not available, skipping OG image: {e}")
        return

    name = project.get("name", "")
    tagline = project.get("tagline", "")
    subtitle = project.get("subtitle", "")
    logo_svg = project.get("logo_svg", "")

    # Dracula dark theme colors
    BG = "#282a36"
    PURPLE = "#bd93f9"
    FG = "#f8f8f2"
    MUTED = "#8ca0d7"

    # Find fonts — prefer JetBrains Mono, fall back to default
    bold_path = _find_jetbrains_font("Bold") or _find_jetbrains_font("Regular")
    regular_path = _find_jetbrains_font("Regular") or _find_jetbrains_font("Medium")

    if not bold_path:
        print("  ! JetBrains Mono Bold not found, using PIL default font (OG image text will be small)")

    try:
        font_name = ImageFont.truetype(bold_path or "", 48) if bold_path else ImageFont.load_default()
    except (OSError, UnicodeDecodeError):
        font_name = ImageFont.load_default()
    try:
        font_tagline = ImageFont.truetype(regular_path or "", 26) if regular_path else ImageFont.load_default()
    except (OSError, UnicodeDecodeError):
        font_tagline = ImageFont.load_default()
    try:
        font_subtitle = ImageFont.truetype(regular_path or "", 22) if regular_path else ImageFont.load_default()
    except (OSError, UnicodeDecodeError):
        font_subtitle = ImageFont.load_default()

    # Create canvas
    img = Image.new("RGB", (1200, 630), BG)
    draw = ImageDraw.Draw(img)

    # Logo layout constants — used whether or not logo renders
    logo_size = 200
    logo_x = 80
    logo_y = (630 - logo_size) // 2

    # Resolve var(--) references in logo SVG for cairosvg.
    # Sort by key length descending so longer names match before shorter ones,
    # avoiding partial-match corruption (e.g. --bg-color matched by --bg).
    _SVG_COLORS = {
        "--bg": "#282a36", "--panel": "#44475a", "--fg": "#f8f8f2",
        "--muted": "#8ca0d7", "--purple": "#bd93f9", "--pink": "#ff79c6",
        "--cyan": "#8be9fd", "--green": "#50fa7b", "--orange": "#ffb86c",
        "--red": "#ff5555", "--yellow": "#f1fa8c",
    }
    if not logo_svg.strip():
        print("  ! Empty logo_svg, skipping logo")
    else:
        logo_svg_resolved = logo_svg
        for var_name in sorted(_SVG_COLORS, key=len, reverse=True):
            logo_svg_resolved = logo_svg_resolved.replace(f"var({var_name})", _SVG_COLORS[var_name])

        # Render logo from SVG via cairosvg at correct resolution
        try:
            logo_inner, viewBox = _extract_logo_inner(logo_svg_resolved)
            logo_svg_full = (
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewBox}">'
                f"{logo_inner}</svg>"
            )
            # Compute scale from viewBox so logo fills at least logo_size
            vb_parts = list(map(float, viewBox.split()))
            scale = math.ceil(logo_size / max(vb_parts[2] if len(vb_parts) > 2 else 64, 1))
            logo_png = cairosvg.svg2png(bytestring=logo_svg_full.encode("utf-8"), scale=scale)
            if logo_png:
                logo_img = Image.open(BytesIO(logo_png)).convert("RGBA")
                # Preserve aspect ratio — fit within logo_size square
                w, h = logo_img.size
                if w > 0 and h > 0:
                    ratio = min(logo_size / w, logo_size / h)
                    new_size = (int(w * ratio), int(h * ratio))
                    logo_img = logo_img.resize(new_size, Image.Resampling.LANCZOS)
                paste_x = logo_x + (logo_size - logo_img.width) // 2
                paste_y = logo_y + (logo_size - logo_img.height) // 2
                img.paste(logo_img, (paste_x, paste_y), logo_img)
        except Exception:
            print("  ! Logo rendering failed, continuing without logo")

    # Text area: starts after logo + gap, max width to right edge with margin
    text_x = logo_x + logo_size + 40  # 320
    max_text_width = 1200 - text_x - 80  # 800px

    # 1. Project name (large, bold, purple) — truncate if too long
    name_display = _truncate_text(draw, name, font_name, max_text_width)
    name_bbox = draw.textbbox((0, 0), name_display, font=font_name)
    name_h = name_bbox[3] - name_bbox[1]

    # 2. Tagline (medium, white)
    tagline_display = _truncate_text(draw, tagline, font_tagline, max_text_width)
    tagline_bbox = draw.textbbox((0, 0), tagline_display, font=font_tagline)
    tagline_h = tagline_bbox[3] - tagline_bbox[1]

    # Calculate vertical centering for the text block
    subtitle_lines = _wrap_text(draw, subtitle, font_subtitle, max_text_width)
    if len(subtitle_lines) > 3:
        subtitle_lines = subtitle_lines[:3]
        subtitle_lines[-1] = subtitle_lines[-1].rstrip(".") + "..."
    # Keep text block in safe zone (top 540px, social media overlays cover bottom ~60px)
    SAFE_TOP = 30
    # Calculate subtitle height from actual text metrics, not hardcoded
    subtitle_h = 0
    for line in subtitle_lines:
        lb = draw.textbbox((0, 0), line, font=font_subtitle)
        subtitle_h += (lb[3] - lb[1]) + 10  # line height + gap
    subtitle_h -= 10 if subtitle_lines else 0  # remove trailing gap

    accent_h = 4
    gap1 = 16  # gap between name and tagline
    gap2 = 14  # gap between tagline and subtitle
    gap3 = 20  # gap between subtitle and accent

    total_text_h = name_h + gap1 + tagline_h + gap2 + subtitle_h + gap3 + accent_h
    text_y_start = (630 - total_text_h) // 2 - SAFE_TOP

    y = text_y_start
    draw.text((text_x, y), name_display, fill=PURPLE, font=font_name)
    y += name_h + gap1
    draw.text((text_x, y), tagline_display, fill=FG, font=font_tagline)
    y += tagline_h + gap2
    # Track the last subtitle line's actual bottom position for accent placement
    last_subtitle_bottom = y
    for line in subtitle_lines:
        draw.text((text_x, y), line, fill=MUTED, font=font_subtitle)
        line_bbox = draw.textbbox((text_x, y), line, font=font_subtitle)
        last_subtitle_bottom = line_bbox[3]
        y = line_bbox[3] + 10  # 10px gap between subtitle lines
    y = last_subtitle_bottom + gap3
    draw.rectangle([text_x, y, text_x + 100, y + accent_h], fill=PURPLE)

    try:
        img.save(output_path, "PNG")
    except Exception as e:
        print(f"  ! OG image generation failed: {e}")


def generate_one(input_path: Path, output_path: Path) -> None:
    data = load_toml(input_path)
    validate(data)

    # Ensure output directory exists before generating OG image
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Generate OG image before render so template can reference it
    og_path = output_path.parent / "og-image.png"
    generate_og_image(data.get("project", {}), og_path)
    # Set og_image for template (only if not already set by user)
    project = data.setdefault("project", {})
    if "og_image" not in project:
        project["og_image"] = "og-image.png"

    html = render(TEMPLATE, data)
    output_path.write_text(html, encoding="utf-8")
    print(f"  \u2713 {output_path}")


def batch(input_dir: Path, output_dir: Path) -> None:
    toml_files = sorted(input_dir.glob("*.toml"))
    if not toml_files:
        print("No .toml files found in", input_dir)
        return
    for toml_path in toml_files:
        project_dir = output_dir / toml_path.stem
        output_path = project_dir / "index.html"
        try:
            generate_one(toml_path, output_path)
        except SystemExit as e:
            print(f"  ! {toml_path.name}: {e.code or 'error'}")
        except Exception as e:
            print(f"  ! {toml_path.name}: {e}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate project page from TOML")
    parser.add_argument(
        "--input",
        type=str,
        required=True,
        help="TOML file (single mode) or directory (batch mode)",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output HTML path (single mode) or directory (batch mode)",
    )
    parser.add_argument(
        "--batch",
        action="store_true",
        help="Batch mode: process all .toml files in input directory",
    )
    args = parser.parse_args()

    if args.batch:
        batch(Path(args.input), Path(args.output))
    else:
        generate_one(Path(args.input), Path(args.output))


if __name__ == "__main__":
    main()
