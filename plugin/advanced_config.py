"""Typed, non-secret configuration edits through Hermes's own schema and YAML writer."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Field:
    label: str
    section: str
    kind: str
    minimum: float = 0
    maximum: float = 1
    description: str = ""
    applies: str = "next_turn"


FIELDS = {
    "agent.max_turns": Field("Maximum agent turns", "Execution", "integer", 1, 1000, "Maximum iterations per turn. Applies to the next turn."),
    "file_read_max_chars": Field("File read limit", "Execution", "integer", 1000, 2000000, "Maximum characters returned by a file read.", applies="new_session"),
    "memory.memory_enabled": Field("Agent memory", "Memory", "boolean", description="Include the agent's memory in future prompts.", applies="new_session"),
    "memory.user_profile_enabled": Field("User profile", "Memory", "boolean", description="Include the user profile in future prompts.", applies="new_session"),
    "memory.memory_char_limit": Field("Memory size", "Memory", "integer", 100, 100000, "Character budget for agent memory.", applies="new_session"),
    "memory.user_char_limit": Field("User profile size", "Memory", "integer", 100, 100000, "Character budget for the user profile.", applies="new_session"),
    "memory.write_approval": Field("Review memory writes", "Memory", "boolean", description="Stage agent memory changes for owner approval."),
    "memory.nudge_interval": Field("Memory review interval", "Memory", "integer", 1, 1000, "Turns between built-in memory review reminders.", applies="new_session"),
    "auxiliary.background_review.enabled": Field("Background memory review", "Memory", "boolean", description="Allow Hermes background review. This is configuration, not live activity status.", applies="new_session"),
    "compression.enabled": Field("Automatic compression", "Context", "boolean", description="Allow Hermes to compact long conversations."),
    "compression.threshold": Field("Compression threshold", "Context", "number", .1, 1, "Fraction of the context window that triggers compression. Hermes may apply a model-specific floor."),
    "compression.target_ratio": Field("Recent context ratio", "Context", "number", .01, .9, "Fraction of the compression threshold preserved as recent context."),
    "compression.protect_last_n": Field("Protected recent messages", "Context", "integer", 1, 200, "Minimum recent messages retained within Hermes's context budget."),
}


class ConfigRefused(ValueError):
    def __init__(self, message, *, status=400, fields=None):
        super().__init__(message)
        self.status = status
        self.fields = fields or {}


def get(data, path, default=None):
    for key in path.split("."):
        if not isinstance(data, dict) or key not in data:
            return default
        data = data[key]
    return data


def put(data, path, value, *, reset=False):
    parts = path.split(".")
    for key in parts[:-1]:
        if key not in data:
            if reset:
                return
            data[key] = {}
        if not isinstance(data[key], dict):
            raise ConfigRefused("Repair the invalid configuration section on the server first.")
        data = data[key]
    if reset:
        data.pop(parts[-1], None)
    else:
        data[parts[-1]] = value


def dependencies():
    from hermes_cli import config
    from hermes_cli.web_server_config import CONFIG_SCHEMA
    from hermes_cli.web_routers._common import _CONFIG_MUTATION_LOCK
    required = ("get_config_path", "require_readable_config_before_write", "load_config",
                "atomic_config_replace", "validate_config_structure")
    if not all(callable(getattr(config, name, None)) for name in required):
        raise ImportError("Hermes does not offer safe configuration editing")
    return config, CONFIG_SCHEMA, _CONFIG_MUTATION_LOCK


def available():
    try:
        dependencies()
        return True
    except Exception:
        return False


def revision(path, effective, config):
    raw = path.read_bytes() if path.exists() else b""
    if len(raw) > 1024 * 1024:
        raise ConfigRefused("This configuration is too large for the mobile editor.")
    values = {key: [get(effective, key), config.managed_scope.is_key_managed(key)] for key in FIELDS}
    values['managed_install'] = bool(config.get_managed_system())
    return hashlib.sha256(str(path.resolve()).encode() + b"\0" + raw + b"\0" +
                          json.dumps(values, sort_keys=True, allow_nan=False).encode()).hexdigest()


def inspect(config, schema):
    path = config.get_config_path()
    if path.exists() and path.stat().st_size > 1024 * 1024:
        raise ConfigRefused("This configuration is too large for the mobile editor.")
    raw = config.require_readable_config_before_write(path)
    effective = config.load_config()
    rows = []
    for key, field in FIELDS.items():
        if key not in schema:
            continue
        default = get(config.DEFAULT_CONFIG, key)
        value = get(effective, key)
        # No arbitrary YAML, environment expansions or objects reach the client.
        if type(value) not in (bool, int, float, type(None)) or type(default) not in (bool, int, float, type(None)):
            continue
        explicit = get(raw, key, None) is not None
        writable = not config.get_managed_system() and not config.managed_scope.is_key_managed(key)
        rows.append({"key": key, "label": field.label, "section": field.section,
                     "type": field.kind, "description": field.description, "value": value,
                     "default": default, "source": "managed" if not writable else "override" if explicit else "inherited", "writable": writable,
                     "minimum": field.minimum, "maximum": field.maximum, "applies": field.applies})
    return {"revision": revision(path, effective, config), "fields": rows, "applies": "mixed"}


def validate_changes(changes, allowed):
    if not isinstance(changes, dict) or not changes or len(changes) > len(FIELDS):
        raise ConfigRefused("Choose at least one supported setting.")
    errors = {}
    for key, value in changes.items():
        field = FIELDS.get(key)
        if not field or key not in allowed:
            errors[key if isinstance(key, str) and key in FIELDS else "settings"] = "This setting cannot be edited here."
        elif value is None:
            continue  # explicit reset to Hermes's inherited value
        elif field.kind == "boolean":
            if type(value) is not bool:
                errors[key] = "Choose on or off."
        elif type(value) not in (int, float) or not math.isfinite(value):
            errors[key] = "Enter a finite number."
        elif field.kind == "integer" and type(value) is not int:
            errors[key] = "Enter a whole number."
        elif not field.minimum <= value <= field.maximum:
            errors[key] = f"Use a value from {field.minimum:g} to {field.maximum:g}."
    if errors:
        raise ConfigRefused("Some settings need attention.", fields=errors)


def operate(body=None, *, apply=False, authorize=lambda: None):
    config, schema, lock = dependencies()
    with lock:
        authorize()
        before = inspect(config, schema)
        if body is None:
            return before
        if not isinstance(body, dict) or set(body) - {"revision", "changes"}:
            raise ConfigRefused("Invalid configuration request.")
        if body.get("revision") != before["revision"]:
            raise ConfigRefused("Settings changed elsewhere. Reload and review your changes again.", status=409)
        changes = body.get("changes")
        validate_changes(changes, {f["key"] for f in before["fields"] if f['writable']})
        path = config.get_config_path()
        raw = copy.deepcopy(config.require_readable_config_before_write(path))
        effective = copy.deepcopy(config.load_config())
        for key, value in changes.items():
            put(raw, key, value, reset=value is None)
            put(effective, key, get(config.DEFAULT_CONFIG, key) if value is None else value)
        issues = config.validate_config_structure(effective)
        if any(issue.severity == "error" for issue in issues):
            # Validation messages may contain unrelated secret/config content.
            raise ConfigRefused("Hermes found an invalid configuration. Repair it on the server before saving.")
        preview = [{"key": key, "label": FIELDS[key].label, "before": get(config.load_config(), key),
                    "after": get(effective, key), "reset": value is None, "applies": FIELDS[key].applies} for key, value in changes.items()]
        if not apply:
            return {"revision": before["revision"], "changes": preview, "applies": "mixed"}
        # No await after this check: revocation, external edits and bot scope are checked at the write boundary.
        authorize()
        if revision(path, config.load_config(), config) != before["revision"]:
            raise ConfigRefused("Settings changed while being reviewed. Reload first.", status=409)
        config.atomic_config_replace(path, raw)
        result = inspect(config, schema)
        result["changed"] = list(changes)
        return result

