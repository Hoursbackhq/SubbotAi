"""Turn generated art on a flat background into trimmed transparent WebP.

Only background connected to the image border is removed, so light colours
inside the art (white trousers, coin highlights) survive. Edges get a soft
alpha ramp instead of a hard cut.

  python3 scripts/knockout.py in.png out.webp [--max 900]
  python3 scripts/knockout.py sheet.png out-dir --grid 3x2 --max 256
"""
import argparse, os
import numpy as np
from PIL import Image
from scipy import ndimage

SOFT_LO, SOFT_HI = 6.0, 26.0  # colour distance from bg: <LO fully clear, >HI fully opaque


def knockout(img: Image.Image) -> Image.Image:
    rgb = np.asarray(img.convert('RGB')).astype(np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))

    near = dist < SOFT_HI
    labels, _ = ndimage.label(near)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    outside = np.isin(labels, edge_labels[edge_labels > 0])

    alpha = np.ones((h, w), np.float32)
    ramp = np.clip((dist - SOFT_LO) / (SOFT_HI - SOFT_LO), 0, 1)
    alpha[outside] = ramp[outside]
    # Un-mix the background from semi-transparent edge pixels so they don't halo.
    a = alpha[..., None]
    fg = np.where(a > 0.02, (rgb - bg * (1 - a)) / np.maximum(a, 0.02), rgb)
    out = np.dstack([np.clip(fg, 0, 255), alpha * 255]).astype(np.uint8)
    return Image.fromarray(out)


def trim(img: Image.Image, pad_ratio=0.04, square=False) -> Image.Image:
    box = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    img = img.crop(box)
    w, h = img.size
    pad = int(max(w, h) * pad_ratio)
    cw, ch = (max(w, h),) * 2 if square else (w, h)
    canvas = Image.new('RGBA', (cw + 2 * pad, ch + 2 * pad), (0, 0, 0, 0))
    canvas.paste(img, (pad + (cw - w) // 2, pad + (ch - h)), img)  # bottom-align (busts sit on the edge)
    return canvas


def save(img: Image.Image, path: str, max_side: int):
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    img.save(path, 'WEBP', quality=88, method=6)
    print(f'{path}  {img.size[0]}x{img.size[1]}  {os.path.getsize(path) // 1024} KB')


p = argparse.ArgumentParser()
p.add_argument('src'); p.add_argument('dst')
p.add_argument('--grid'); p.add_argument('--max', type=int, default=900)
args = p.parse_args()
src = Image.open(args.src)
if args.grid:
    cols, rows = map(int, args.grid.split('x'))
    os.makedirs(args.dst, exist_ok=True)
    cw, ch = src.width // cols, src.height // rows
    for r in range(rows):
        for c in range(cols):
            cell = src.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
            save(trim(knockout(cell), square=True), os.path.join(args.dst, f'{r * cols + c + 1}.webp'), args.max)
else:
    save(trim(knockout(src)), args.dst, args.max)
