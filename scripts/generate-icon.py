"""Regenerate the original MacLink SVG and multi-size Windows icon.

Run: python scripts/generate-icon.py
Requires Pillow (python -m pip install Pillow); not needed for normal builds.
The artwork is drawn from geometry only and contains no external assets.
"""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SIZES = (16, 24, 32, 48, 64, 128, 256)
BACKGROUND = "#253e35"
ACCENT = "#83b999"
FOREGROUND = "#f5f9f3"

SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <title>MacLink</title>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="{BACKGROUND}"/>
  <rect x="40" y="50" width="126" height="91" rx="15" fill="{BACKGROUND}" stroke="{ACCENT}" stroke-width="12"/>
  <path d="M150 192v18m-22 0h44" fill="none" stroke="{FOREGROUND}" stroke-width="10" stroke-linecap="round"/>
  <rect x="84" y="96" width="132" height="96" rx="15" fill="{BACKGROUND}" stroke="{FOREGROUND}" stroke-width="12"/>
  <circle cx="194" cy="170" r="5" fill="{ACCENT}"/>
</svg>
'''


def draw_icon() -> Image.Image:
    scale = 4
    image = Image.new("RGBA", (256 * scale, 256 * scale))
    draw = ImageDraw.Draw(image)

    def box(bounds, radius, fill, outline=None, width=0):
        draw.rounded_rectangle(
            tuple(value * scale for value in bounds),
            radius=radius * scale,
            fill=fill,
            outline=outline,
            width=width * scale,
        )

    # Pillow outlines are inset, so expand the SVG's centered strokes outward.
    box((8, 8, 248, 248), 52, BACKGROUND)
    box((34, 44, 172, 147), 21, BACKGROUND, ACCENT, 12)
    draw.line((150 * scale, 192 * scale, 150 * scale, 210 * scale), fill=FOREGROUND, width=10 * scale)
    draw.line((128 * scale, 210 * scale, 172 * scale, 210 * scale), fill=FOREGROUND, width=10 * scale)
    for x, y in ((150, 192), (128, 210), (172, 210)):
        draw.ellipse(((x - 5) * scale, (y - 5) * scale, (x + 5) * scale, (y + 5) * scale), fill=FOREGROUND)
    box((78, 90, 222, 198), 21, BACKGROUND, FOREGROUND, 12)
    draw.ellipse((189 * scale, 165 * scale, 199 * scale, 175 * scale), fill=ACCENT)
    return image.resize((256, 256), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    ASSETS.mkdir(exist_ok=True)
    (ASSETS / "maclink.svg").write_text(SVG, encoding="utf-8")
    draw_icon().save(ASSETS / "maclink.ico", sizes=[(size, size) for size in SIZES])
    print("Generated assets/maclink.svg and assets/maclink.ico (16-256 px).")
