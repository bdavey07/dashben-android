#!/usr/bin/env python3
"""Regenerate the binary Android assets excluded from git.

Run from the repo root:  python3 scripts/gen-assets.py

Why generated, not committed: the GitHub push tooling used for this repo
is text-only, so PNGs live here as code, not blobs.

- Launcher icons: an exact redraw of favicon-v2.svg (black rounded
  square, two #d16517 squares) at every density, plus circle-masked
  round icons and adaptive foregrounds.
- Splash screens: white canvases with the same favicon mark centered.
  (The originals were Capacitor defaults, not app art, so a branded
  placeholder loses nothing.)

Requires Pillow:  pip install Pillow
"""
from PIL import Image, ImageDraw

# Favicon geometry in a 512 viewBox.
BG = (0, 0, 0, 255)
ORANGE = (0xD1, 0x65, 0x17, 255)


def favicon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = size / 512
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=110 * k, fill=BG)
    for x, y in ((64, 64), (270, 270)):
        d.rounded_rectangle([x * k, y * k, (x + 178) * k - 1, (y + 178) * k - 1],
                            radius=38 * k, fill=ORANGE)
    return img


def circle_masked(img):
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    base = "android/app/src/main/res"
    legacy = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
              "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
    foreground = {"mipmap-mdpi": 108, "mipmap-hdpi": 162, "mipmap-xhdpi": 216,
                  "mipmap-xxhdpi": 324, "mipmap-xxxhdpi": 432}
    for d, px in legacy.items():
        favicon(px).save(f"{base}/{d}/ic_launcher.png")
        circle_masked(favicon(px)).save(f"{base}/{d}/ic_launcher_round.png")
    for d, px in foreground.items():
        favicon(px).save(f"{base}/{d}/ic_launcher_foreground.png")

    splash = {
        "drawable": (480, 320), "drawable-land-mdpi": (480, 320),
        "drawable-land-hdpi": (800, 480), "drawable-land-xhdpi": (1280, 720),
        "drawable-land-xxhdpi": (1600, 960), "drawable-land-xxxhdpi": (1920, 1280),
        "drawable-port-mdpi": (320, 480), "drawable-port-hdpi": (480, 800),
        "drawable-port-xhdpi": (720, 1280), "drawable-port-xxhdpi": (960, 1600),
        "drawable-port-xxxhdpi": (1280, 1920),
    }
    for d, (w, h) in splash.items():
        canvas = Image.new("RGBA", (w, h), (255, 255, 255, 255))
        mark = favicon(int(min(w, h) * 0.4))
        canvas.paste(mark, ((w - mark.size[0]) // 2, (h - mark.size[1]) // 2), mark)
        canvas.convert("RGB").save(f"{base}/{d}/splash.png")
    print("assets regenerated: 15 launcher + 11 splash PNGs")


if __name__ == "__main__":
    main()
