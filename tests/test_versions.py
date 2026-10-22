"""A release must report one version through the API, plugin manifest and app."""

import json
from pathlib import Path

import yaml

from plugin.hub import VERSION


def test_app_plugin_api_and_dependency_lock_versions_agree():
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / "app/app.json").read_text(encoding="utf-8"))
    package = json.loads((root / "app/package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "app/package-lock.json").read_text(encoding="utf-8"))
    manifest = yaml.safe_load((root / "plugin/plugin.yaml").read_text(encoding="utf-8"))
    assert {VERSION, config["expo"]["version"], package["version"], lock["version"],
            lock["packages"][""]["version"], str(manifest["version"])} == {VERSION}
