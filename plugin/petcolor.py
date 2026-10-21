"""A pet's colours, taken from its own idle frame: the disc behind it and Home's glow match the pet.

Pure (a PIL image in, hex strings out), so it's tested without Hermes.
"""

from __future__ import annotations

import colorsys
from typing import Dict, Optional, Tuple

RGB = Tuple[float, float, float]
_BUCKETS = 24


def _hex(rgb: RGB) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c))):02x}" for c in rgb)


def _mix(rgb: RGB, to: RGB, amount: float) -> RGB:
    return tuple(c + (t - c) * amount for c, t in zip(rgb, to))  # type: ignore[return-value]


def pet_palette(image) -> Optional[Dict[str, str]]:
    """{base, soft, deep} for one frame, or None when nothing in it is visible.

    `base` is the weighted mean of the most present hue, ignoring see-through, near-white and near-black
    pixels (highlights and outlines); a pet with no colour at all gets the mean of its greys.
    """
    small = image.convert("RGBA")
    # Nearest-neighbour (0): smoothing would blend outlines into the body and see-through edges into both.
    small.thumbnail((32, 32), resample=0)
    buckets: Dict[int, list] = {}
    seen = []
    for r, g, b, a in small.getdata():
        if a < 128:
            continue
        h, lightness, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if lightness > 0.92 or lightness < 0.08:
            continue
        seen.append((r, g, b))
        weight = s * a / 255
        if weight < 0.05:
            continue
        acc = buckets.setdefault(int(h * _BUCKETS) % _BUCKETS, [0.0, 0.0, 0.0, 0.0])
        acc[0] += weight
        acc[1] += r * weight
        acc[2] += g * weight
        acc[3] += b * weight
    if buckets:
        w, r, g, b = max(buckets.values(), key=lambda v: v[0])
        base: RGB = (r / w, g / w, b / w)
    elif seen:
        base = tuple(sum(p[i] for p in seen) / len(seen) for i in range(3))  # type: ignore[assignment]
    else:
        return None
    return {"base": _hex(base), "soft": _hex(_mix(base, (255, 255, 255), 0.78)), "deep": _hex(_mix(base, (0, 0, 0), 0.62))}
