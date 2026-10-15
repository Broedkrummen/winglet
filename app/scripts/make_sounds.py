"""Winglet's four interface sounds, made here as soft tones so there's nothing to license.

Run from app/: python scripts/make_sounds.py  (writes assets/sounds/*.wav)
"""

import math
import struct
import wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / "assets" / "sounds"


def tone(freq, ms, start=0.0, decay=8.0):
    """A plucked sine with a touch of its octave: quick attack, exponential fade."""
    n = int(RATE * ms / 1000)
    out = []
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.005) * math.exp(-decay * t / (ms / 1000))
        out.append((start + i, env * (math.sin(2 * math.pi * freq * t) + 0.18 * math.sin(4 * math.pi * freq * t))))
    return out


def render(name, notes):
    length = max(int(s) for part in notes for s, _ in part) + 1
    buf = [0.0] * length
    for part in notes:
        for i, v in part:
            buf[int(i)] += v
    peak = max(abs(v) for v in buf) or 1.0
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(32767 * 0.5 * v / peak)) for v in buf))


def ms(m):
    return RATE * m / 1000


render("tap", [tone(1046.5, 70, decay=10)])
render("sent", [tone(659.3, 90), tone(987.8, 120, start=ms(60))])
render("reply", [tone(784.0, 160), tone(987.8, 160, start=ms(90)), tone(1174.7, 260, start=ms(180))])
render("needs-you", [tone(987.8, 140), tone(784.0, 220, start=ms(130))])
