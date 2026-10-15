"""A pet's colours come from its own idle frame, so the disc behind it and Home's glow match the pet."""

import pytest

Image = pytest.importorskip("PIL.Image")

from plugin.petcolor import pet_palette  # noqa: E402


def frame(fill=None, size=(192, 208)):
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    for box, colour in fill or []:
        image.paste(colour, box)
    return image


def test_the_main_colour_is_the_pets_not_its_outline():
    # A red body with a thin near-black outline and a white highlight.
    image = frame([((30, 30, 162, 178), (20, 20, 20, 255)), ((34, 34, 158, 174), (210, 40, 50, 255)),
                   ((60, 60, 80, 80), (255, 255, 255, 255))])
    palette = pet_palette(image)
    assert palette["base"] == "#d22832"
    assert palette["soft"] == "#f5d0d2"  # 78% toward white: (245, 208, 210)
    assert palette["deep"] == "#500f13"  # 62% toward black


def test_the_bigger_hue_wins_over_a_small_accent():
    image = frame([((20, 20, 172, 188), (40, 120, 220, 255)), ((90, 90, 110, 110), (250, 200, 0, 255))])
    assert pet_palette(image)["base"] == "#2878dc"


def test_a_greyscale_pet_gets_its_grey():
    image = frame([((40, 40, 150, 170), (120, 120, 120, 255))])
    assert pet_palette(image)["base"] == "#787878"


def test_a_frame_with_nothing_visible_has_no_palette():
    assert pet_palette(frame()) is None
    assert pet_palette(frame([((0, 0, 50, 50), (255, 255, 255, 255))])) is None  # only white


def test_semi_transparent_edges_are_ignored():
    image = frame([((40, 40, 150, 170), (30, 160, 90, 255)), ((0, 0, 192, 20), (250, 0, 0, 90))])
    assert pet_palette(image)["base"] == "#1ea05a"
