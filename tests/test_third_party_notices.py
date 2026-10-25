"""Distribution contracts: full notice text, deterministic order and stale-copy rejection."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("notice_generator", ROOT / "scripts/generate_third_party_notices.py")
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


def source(root, name, text):
    path = root / "third_party/notices" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_committed_notice_copies_are_current():
    result = subprocess.run([sys.executable, str(ROOT / "scripts/generate_third_party_notices.py"), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_full_unicode_copyright_license_and_provenance_survive_both_packages(tmp_path):
    complete = '# Attribution é\n\nCopyright (c) Example\n\nPermission is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS".\n\nAdapted from https://example.invalid/source#revision\n'
    source(tmp_path, "z.md", complete)
    source(tmp_path, "a.md", "# Another notice\nNo trailing newline")
    assert generator.main([], root=tmp_path) == 0
    items = json.loads((tmp_path / generator.APP).read_text(encoding="utf-8"))
    assert [item["file"] for item in items] == ["a.md", "z.md"]
    assert items[1]["text"] == complete
    assert items[0]["text"] == "# Another notice\nNo trailing newline"
    plugin = (tmp_path / generator.PLUGIN).read_text(encoding="utf-8")
    assert complete in plugin
    assert plugin.index("Source: third_party/notices/a.md") < plugin.index("Source: third_party/notices/z.md")
    assert generator.main(["--check"], root=tmp_path) == 0


@pytest.mark.parametrize("mutation", ["source", "added", "deleted", "app", "plugin"])
def test_check_rejects_stale_source_or_either_packaged_copy_without_rewriting(tmp_path, mutation):
    original = source(tmp_path, "first.md", "# Notice\nCopyright and full terms\n")
    generator.main([], root=tmp_path)
    if mutation == "source": original.write_text("Changed copyright and terms", encoding="utf-8")
    elif mutation == "added": source(tmp_path, "second.md", "# Newly required notice\nFull license")
    elif mutation == "deleted": original.unlink()
    else: (tmp_path / (generator.APP if mutation == "app" else generator.PLUGIN)).write_text("stale", encoding="utf-8")
    before = {path: (tmp_path / path).read_bytes() for path in [generator.APP, generator.PLUGIN]}
    assert generator.main(["--check"], root=tmp_path) == 1
    assert before == {path: (tmp_path / path).read_bytes() for path in before}
