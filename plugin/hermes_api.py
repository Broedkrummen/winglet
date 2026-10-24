"""The one place Winglet touches Hermes internals.

Hermes moves quickly, and its internal modules aren't a stable API. Every import of ``hermes_cli``,
``agent``, ``cron`` or ``gateway`` internals that a feature depends on lives here, wrapped so that a
missing or renamed function turns that one feature off instead of breaking the plugin.
"""

from __future__ import annotations

import contextlib
import contextvars
import functools
import hashlib
import json
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)


@functools.lru_cache(maxsize=1)
def hermes_version() -> str:
    """Human-readable Hermes version, or "" if this Hermes can't say. Read once: it may run git."""
    try:
        from hermes_cli.version_info import get_version_info
        info = get_version_info()
        for value in (getattr(info, "base_version", ""), getattr(info, "derived_version", "")):
            if value and value != "unknown":
                return str(value)
    except Exception:
        logger.debug("[winglet] version_info unavailable", exc_info=True)
    try:
        from hermes_cli import __release_date__
        return str(__release_date__)
    except Exception:
        return ""


async def cache_media(path: str, name: str, mime: str, voice: bool = False):
    """Hand an uploaded file to Hermes's own media cache, the same way Telegram or Slack do.
    Returns (cached path, media type, kind)."""
    import asyncio
    from pathlib import Path
    from gateway.platforms.base import cache_media_bytes_async
    data = await asyncio.to_thread(Path(path).read_bytes)
    if voice:
        # Hermes files .webm under video by its extension; a voice note is always audio, so it goes
        # straight to the audio cache, where speech-to-text picks it up.
        from gateway.platforms.base import cache_audio_from_bytes_async
        ext = Path(name).suffix.lower()
        ext = {".mp4": ".m4a", "": ".ogg"}.get(ext, ext)
        return await cache_audio_from_bytes_async(data, ext=ext), mime, "audio"
    cached = await cache_media_bytes_async(data, filename=name, mime_type=mime)
    if cached is None:
        raise ValueError(f"Hermes could not read {name} as {mime}")
    return cached.path, cached.media_type, cached.kind


def list_commands() -> list:
    """Gateway slash commands and skill commands, for the app's command palette."""
    with _profile_scope():  # each bot has its own skills, so its own commands
        out = []
        try:
            from hermes_cli.commands import COMMAND_REGISTRY, _is_gateway_available, _resolve_config_gates
            gates = _resolve_config_gates()
            for cmd in COMMAND_REGISTRY:
                if not _is_gateway_available(cmd, gates):
                    continue
                out.append({"cmd": f"/{cmd.name}", "hint": cmd.describe(), "args": cmd.args_hint or "",
                            "category": cmd.category, "kind": "command"})
        except Exception:
            logger.debug("[winglet] command registry unavailable", exc_info=True)
        try:
            from agent.skill_commands import get_skill_commands
            for key, meta in sorted((get_skill_commands() or {}).items()):
                name = key if str(key).startswith("/") else f"/{key}"
                out.append({"cmd": name, "hint": str((meta or {}).get("description") or "Skill")[:160], "args": "",
                            "category": "Skills", "kind": "skill"})
        except Exception:
            logger.debug("[winglet] skill commands unavailable", exc_info=True)
        return out


def resolve_command(name: str) -> str:
    """Hermes's canonical name for a typed command or alias ("reset" -> "new"), or "" if unknown."""
    try:
        from hermes_cli.commands import resolve_command as _resolve
        cmd = _resolve(name)
        return cmd.name if cmd is not None else ""
    except Exception:
        logger.debug("[winglet] command registry unavailable", exc_info=True)
        return ""


# -- your agent: model, providers, persona, memory, usage ------------------------------------
#
# These mirror what Hermes's own dashboard does, calling the same functions rather than its HTTP
# routes. Each raises HermesUnavailable when this Hermes doesn't have the function, so the hub can
# turn the feature off instead of failing.


# The bot (Hermes profile) the current request is about; None is the profile this gateway runs as.
# Set per request by the hub; asyncio.to_thread copies it to the worker thread.
_BOT: contextvars.ContextVar = contextvars.ContextVar("winglet_bot", default=None)


def set_bot(name: Optional[str]) -> contextvars.Token:
    return _BOT.set(name or None)


def reset_bot(token: contextvars.Token) -> None:
    _BOT.reset(token)


def current_bot() -> Optional[str]:
    return _BOT.get()


@contextlib.contextmanager
def _bot_scope(name: str):
    """Config, skills, memory and secrets of another profile this gateway serves, the way Hermes scopes a
    routed turn."""
    from hermes_cli.profiles import get_profile_dir
    home = get_profile_dir(name)
    try:
        from gateway.run import _profile_runtime_scope
    except Exception:
        _profile_runtime_scope = None
    if _profile_runtime_scope is not None:
        with _profile_runtime_scope(home):
            yield
        return
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


@contextlib.contextmanager
def _profile_scope():
    """Read this profile's secrets the way Hermes's own turns do. A gateway that serves several
    profiles refuses unscoped secret reads, and these functions run on worker threads. For another
    bot, everything is that bot's profile."""
    bot = _BOT.get()
    if bot:
        with _bot_scope(bot):
            yield
        return
    try:
        from agent.secret_scope import build_profile_secret_scope, current_secret_scope, reset_secret_scope, set_secret_scope
        from hermes_constants import get_hermes_home
    except Exception:
        yield
        return
    if current_secret_scope() is not None:
        yield
        return
    home = get_hermes_home()
    token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(token)


def _scoped(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _profile_scope():
            return fn(*args, **kwargs)
    return wrapper


class HermesUnavailable(RuntimeError):
    """This Hermes version doesn't offer the function a feature needs."""


class HermesRefused(ValueError):
    """Hermes rejected the request (a bad model, a rejected key); the message is for the user."""


def _detail(exc: Exception) -> str:
    return str(getattr(exc, "detail", "") or exc)


@_scoped
def configured_model() -> dict:
    """The model new chats start with, from config.yaml."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
    except Exception as exc:
        raise HermesUnavailable("config unavailable") from exc
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, dict):
        model, provider = model_cfg.get("default", model_cfg.get("name", "")), model_cfg.get("provider", "")
    else:
        model, provider = (str(model_cfg) if model_cfg else ""), ""
    agent = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    return {"model": str(model or ""), "provider": str(provider or ""),
            "reasoning_effort": str(agent.get("reasoning_effort") or ""), "label": provider_label(str(provider or ""))}


def provider_label(slug: str) -> str:
    try:
        from hermes_cli.providers import get_label
        return str(get_label(slug) or slug)
    except Exception:
        return slug


def chat_model(runner, session_key: str) -> Optional[dict]:
    """The model a chat is really using, when Hermes knows: a /model switch for this chat, or the
    model its last turn resolved to (a fallback can change it). None means "the configured one"."""
    try:
        cached = getattr(runner, "_cached_agent_for", None)
        agent = cached(session_key) if callable(cached) else None
        if agent is not None and isinstance(getattr(agent, "model", None), str) and agent.model:
            return {"model": agent.model, "provider": str(getattr(agent, "provider", "") or ""), "source": "last_turn"}
        override = (getattr(runner, "_session_model_overrides", None) or {}).get(session_key)
        if isinstance(override, dict) and override.get("model"):
            return {"model": str(override["model"]), "provider": str(override.get("provider") or ""), "source": "chat"}
        last = (getattr(runner, "_last_resolved_model", None) or {}).get(session_key)
        if last:
            return {"model": str(last), "provider": "", "source": "last_turn"}
    except Exception:
        logger.debug("[winglet] session model unavailable", exc_info=True)
    return None


@_scoped
def model_options(include_unconfigured: bool = False) -> dict:
    """Providers and their models, the same list Hermes's model pickers show."""
    try:
        from hermes_cli.inventory import build_model_options_payload, load_picker_context
    except Exception as exc:
        raise HermesUnavailable("model inventory unavailable") from exc
    payload = build_model_options_payload(load_picker_context(), include_unconfigured=include_unconfigured)
    providers = []
    for p in payload.get("providers") or []:
        models = list(dict.fromkeys(m if isinstance(m, str) else str((m or {}).get("id") or "")
                                    for m in (p.get("models") or [])))
        providers.append({"slug": p.get("slug", ""), "name": p.get("name") or p.get("slug", ""),
                          "authenticated": bool(p.get("authenticated")), "is_current": bool(p.get("is_current")),
                          "auth_type": p.get("auth_type", ""), "key_env": p.get("key_env", ""),
                          "models": [m for m in models if m], "total_models": p.get("total_models") or len(models),
                          "warning": p.get("warning", ""), "custom_models": True})
    return {"model": payload.get("model", ""), "provider": payload.get("provider", ""), "providers": providers}


@_scoped
def set_default_model(provider: str, model: str, *, confirm: bool = False) -> dict:
    """Make ``model`` the default for new chats, with Hermes's own validation and its warning for
    expensive models (returned as ``confirm_required`` until the user confirms)."""
    try:
        from hermes_cli.web_server_config import _apply_model_assignment_sync, _prepare_main_assignment
        from hermes_cli.config import load_config
    except Exception as exc:
        raise HermesUnavailable("model assignment unavailable") from exc
    if not confirm:
        try:
            from hermes_cli.model_selection_guards import combined_selection_warning
            warning = combined_selection_warning(model, provider=provider, base_url="")
        except Exception:
            warning = None
        if warning is not None:
            return {"ok": False, "confirm_required": True, "confirm_message": str(getattr(warning, "message", warning))}
    try:
        prepared = _prepare_main_assignment(load_config(), provider, model, "", "")
        result = _apply_model_assignment_sync("main", provider, model, "", "", "", prepared=prepared)
    except Exception as exc:
        if type(exc).__name__ == "HTTPException" or isinstance(exc, ValueError):
            raise HermesRefused(_detail(exc)) from exc
        raise
    return {"ok": True, "provider": result.get("provider", provider), "model": result.get("model", model)}


# Cheap read-only calls that reject a bad key, as Hermes's dashboard uses before saving one.
_KEY_PROBES = {
    "OPENROUTER_API_KEY": ("https://openrouter.ai/api/v1/key", "bearer"),
    "OPENAI_API_KEY": ("https://api.openai.com/v1/models", "bearer"),
    "XAI_API_KEY": ("https://api.x.ai/v1/models", "bearer"),
    "ANTHROPIC_API_KEY": ("https://api.anthropic.com/v1/models", "x-api-key"),
    "GEMINI_API_KEY": ("https://generativelanguage.googleapis.com/v1beta/models", "query"),
}


async def check_provider_key(env_var: str, value: str) -> dict:
    """{ok, reachable, message}: ok=False with reachable=True means the provider rejected the key."""
    probe = _KEY_PROBES.get(env_var)
    if not probe:
        return {"ok": True, "reachable": False, "message": ""}
    import httpx
    url, auth = probe
    headers, params = {"Accept": "application/json"}, {}
    if auth == "bearer":
        headers["Authorization"] = f"Bearer {value}"
    elif auth == "x-api-key":
        headers.update({"x-api-key": value, "anthropic-version": "2023-06-01"})
    else:
        params["key"] = value
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers, params=params)
    except Exception:
        return {"ok": True, "reachable": False, "message": "Couldn't reach the provider to check the key; saved anyway."}
    if resp.status_code in (401, 403):
        return {"ok": False, "reachable": True, "message": "The provider rejected that key. Check it and try again."}
    return {"ok": True, "reachable": True, "message": ""}


@_scoped
def save_provider_key(env_var: str, value: str) -> None:
    try:
        from hermes_cli.credential_lifecycle import save_provider_env_credential
    except Exception as exc:
        raise HermesUnavailable("credential storage unavailable") from exc
    save_provider_env_credential(env_var, value)


@_scoped
def remove_provider_key(env_var: str) -> bool:
    try:
        from hermes_cli.credential_lifecycle import remove_provider_env_credential
    except Exception as exc:
        raise HermesUnavailable("credential storage unavailable") from exc
    return bool((remove_provider_env_credential(env_var) or {}).get("found", True))


def _home():
    from hermes_constants import get_hermes_home
    return get_hermes_home()


@_scoped
def read_persona() -> dict:
    path = _home() / "SOUL.md"
    if not path.exists():
        return {"content": "", "exists": False}
    return {"content": path.read_text(encoding="utf-8-sig"), "exists": True}


@_scoped
def write_persona(content: str) -> None:
    path = _home() / "SOUL.md"
    try:
        from utils import atomic_write_text
        atomic_write_text(path, content, preserve_mode=True, create_mode=0o644)
    except ImportError:
        tmp = path.with_suffix(".md.tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)


def _memory_store():
    try:
        from tools.memory_tool import load_on_disk_store
    except Exception as exc:
        raise HermesUnavailable("memory unavailable") from exc
    return load_on_disk_store()


@_scoped
def memory() -> dict:
    """What the agent remembers: notes about its world (MEMORY.md) and about you (USER.md)."""
    store = _memory_store()
    out = {}
    for target in ("memory", "user"):
        entries = list(getattr(store, f"{target}_entries", None) or store._entries_for(target))
        try:
            limit = store._char_limit(target)
        except Exception:
            limit = 0
        out[target] = {"entries": entries, "enabled": bool(store.target_enabled(target)), "limit": limit,
                       "used": len("\n§\n".join(entries))}
    return out


@_scoped
def edit_memory(action: str, target: str, entry: str = "", content: str = "") -> dict:
    """Add, replace or remove one memory entry through Hermes's own store (its limits and its scan
    for prompt-injection content apply)."""
    if target not in ("memory", "user") or action not in ("add", "replace", "remove"):
        raise HermesRefused("unknown memory action")
    store = _memory_store()
    if action == "add":
        result = store.add(target, content)
    elif action == "replace":
        result = store.replace(target, entry, content, matched_entry=entry)
    else:
        result = store.remove(target, entry, matched_entry=entry)
    if not result.get("success", False):
        raise HermesRefused(str(result.get("error") or "Hermes didn't accept that change."))
    return memory()


@_scoped
def usage(days: int = 30) -> dict:
    """Tokens and cost per day and per model, as Hermes's dashboard reports them."""
    try:
        from hermes_cli.web_routers.analytics import _get_usage_analytics
    except Exception as exc:
        raise HermesUnavailable("usage analytics unavailable") from exc
    data = _get_usage_analytics(max(1, min(int(days), 365)))
    keep = ("daily", "by_model", "totals", "period_days")
    return {k: data.get(k) for k in keep if k in data} if isinstance(data, dict) else {}


async def resolve_slash_confirm(session_key: str, confirm_id: str, choice: str) -> str:
    try:
        from tools import slash_confirm
    except Exception as exc:
        raise HermesUnavailable("slash confirm unavailable") from exc
    return str(await slash_confirm.resolve(session_key, confirm_id, choice) or "")


# -- control center: health, pause, restart, updates, logs, schedule ------------------------


def system_stats() -> dict:
    """Host health for owners: CPU, memory, disk and uptime, without hostnames or paths."""
    import os
    import platform
    import time as _time
    info: dict = {"system": platform.system(), "arch": platform.machine(), "cpu_count": os.cpu_count()}
    try:
        import psutil
        vm = psutil.virtual_memory()
        info["memory"] = {"total": vm.total, "used": vm.used, "percent": vm.percent}
        du = psutil.disk_usage(str(_home()))
        info["disk"] = {"total": du.total, "used": du.used, "percent": du.percent}
        info["cpu_percent"] = psutil.cpu_percent(interval=0.1)
        info["uptime_seconds"] = int(_time.time() - psutil.boot_time())
    except Exception:
        try:
            info["load_avg"] = list(os.getloadavg())
        except (OSError, AttributeError):
            pass
    return info


def paused() -> Optional[dict]:
    """Whether new work is on hold (Hermes's /pause): {reason, engaged_at}, or None."""
    try:
        from agent import estop
    except Exception as exc:
        raise HermesUnavailable("pause unavailable") from exc
    return estop.get_state()


def set_paused(on: bool, reason: str = "") -> Optional[dict]:
    from agent import estop
    if on:
        estop.engage(reason or "paused from Winglet")
    else:
        estop.disengage()
    return estop.get_state()


def spawn_restart() -> int:
    """Restart this profile's gateway the way `hermes gateway restart` does, in a detached process
    (it stops this one). Returns the child's pid."""
    try:
        from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action
    except Exception as exc:
        raise HermesUnavailable("restart unavailable") from exc
    return _spawn_hermes_action(_gateway_subcommand(None, "restart"), "gateway-restart").pid


async def start_hermes_update() -> dict:
    """Start `hermes update` the way the dashboard's button does, with the same checks for installs that
    can't update in place. {ok, action_id} or {ok: False, message, update_command}."""
    try:
        from hermes_cli.web_routers.actions import update_hermes
    except Exception as exc:
        raise HermesUnavailable("update unavailable") from exc
    with _profile_scope():
        return dict(await update_hermes())


async def hermes_update_status() -> dict:
    """{running, exit_code, lines, action_id, receipt}: Hermes's own record of the last update, which
    survives the restart the update ends with."""
    try:
        from hermes_cli.web_routers.actions import get_action_status
    except Exception as exc:
        raise HermesUnavailable("update status unavailable") from exc
    with _profile_scope():
        return dict(await get_action_status("hermes-update", lines=40))


async def check_hermes_update(force: bool = False) -> dict:
    """{install_method, current_version, behind, update_available, can_apply, update_command, message}."""
    try:
        from hermes_cli.web_routers.actions import check_hermes_update as _check
    except Exception as exc:
        raise HermesUnavailable("update check unavailable") from exc
    with _profile_scope():
        return dict(await _check(force=force))


def _plugin_dir():
    from pathlib import Path
    return Path(__file__).resolve().parent


@_scoped
def check_winglet_update() -> dict:
    """Whether a newer Winglet is published where it was installed from: {update_available, current,
    latest, reason}. update_available is None when it can't tell (a copied folder, no network)."""
    try:
        from hermes_cli.plugins_updates import run_checks
    except Exception as exc:
        raise HermesUnavailable("plugin update check unavailable") from exc
    here = _plugin_dir()
    for result in run_checks(here.parent, include_pip=False):
        if result.name in (here.name, "winglet"):
            data = result.to_json()
            return {k: data.get(k) for k in ("update_available", "current", "latest", "reason", "needs_fixing")}
    return {"update_available": None, "current": None, "latest": None, "reason": "not installed from git"}


async def update_winglet(timeout: float = 300) -> tuple:
    """`hermes plugins update` for this plugin, without prompts (new capabilities stay ungranted until
    someone reviews them on the server). Returns (exit code, output tail)."""
    import asyncio as _asyncio
    import os
    try:
        from hermes_cli._launchers import runtime_command
        from hermes_cli.web_server import PROJECT_ROOT
    except Exception as exc:
        raise HermesUnavailable("plugin update unavailable") from exc
    code = ("from hermes_cli.plugins_cmd_update import cmd_update; "
            f"cmd_update({_plugin_dir().name!r}, interactive=False)")
    env = {**os.environ, "HERMES_HOME": str(_home()), "COLUMNS": "200"}
    proc = await _asyncio.create_subprocess_exec(*runtime_command(PROJECT_ROOT, code=code), env=env,
                                                 stdin=_asyncio.subprocess.DEVNULL, stdout=_asyncio.subprocess.PIPE,
                                                 stderr=_asyncio.subprocess.STDOUT)
    try:
        out, _ = await _asyncio.wait_for(proc.communicate(), timeout)
    except _asyncio.TimeoutError:
        proc.kill()
        return -1, ["The update took too long and was stopped."]
    return proc.returncode, out.decode("utf-8", errors="replace").splitlines()[-30:]


_LOG_FILES = {"agent": "agent.log", "gateway": "gateway.log", "errors": "errors.log"}
_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


def read_log(name: str, *, lines: int = 300, level: str = "", query: str = "") -> dict:
    """The end of one of Hermes's logs, redacted the way Hermes redacts tool output, filtered by
    minimum level and a search string."""
    filename = _LOG_FILES.get(name)
    if filename is None:
        raise HermesRefused("unknown log")
    path = _home() / "logs" / filename
    if not path.exists():
        return {"lines": [], "size": 0}
    size = path.stat().st_size
    with open(path, "rb") as f:
        f.seek(max(0, size - 512 * 1024))
        text = f.read().decode("utf-8", errors="replace")
    rows = text.splitlines()[1:] if size > 512 * 1024 else text.splitlines()
    floor = _LEVELS.index(level) if level in _LEVELS else 0
    q = query.lower()

    def keep(row: str) -> bool:
        if floor:
            found = next((lv for lv in _LEVELS if f" {lv} " in row[:80]), None)
            if found is None or _LEVELS.index(found) < floor:
                return False
        return not q or q in row.lower()

    picked = [r for r in rows if keep(r)][-max(1, min(lines, 1000)):]
    try:
        from agent.redact import redact_sensitive_text
        picked = redact_sensitive_text("\n".join(picked), force=True, redact_url_credentials=True).split("\n")
    except Exception:
        picked = ["(Hermes's redaction is unavailable on this version, so logs aren't shown.)"]
    return {"lines": picked, "size": size}


def _cron():
    try:
        from cron import jobs
    except Exception as exc:
        raise HermesUnavailable("schedule unavailable") from exc
    return jobs


_JOB_FIELDS = ("id", "name", "prompt", "schedule_display", "state", "enabled", "next_run_at", "last_run_at",
               "last_status", "last_error", "deliver", "created_at", "paused_reason")


def _job_view(job: dict) -> dict:
    out = {k: job.get(k) for k in _JOB_FIELDS}
    schedule = job.get("schedule") or {}
    out["kind"] = schedule.get("kind") if isinstance(schedule, dict) else None
    try:
        out["state"] = _cron().effective_job_state(job)
    except Exception:
        pass
    return out


@_scoped
def list_schedule() -> List[dict]:
    return [_job_view(j) for j in _cron().list_jobs(include_disabled=True)]


@_scoped
def parse_schedule(text: str) -> dict:
    jobs = _cron()
    try:
        schedule = jobs.parse_schedule(text)
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc
    nxt = jobs.compute_next_run(schedule)
    return {"display": schedule.get("display") or text, "kind": schedule.get("kind"), "next_run_at": nxt}


# Routine results arrive in the Winglet Updates chat.
ROUTINE_DELIVERY = "winglet:home"


@_scoped
def create_routine(name: str, prompt: str, schedule: str) -> dict:
    try:
        return _job_view(_cron().create_job(prompt=prompt, schedule=schedule, name=name or None, deliver=ROUTINE_DELIVERY))
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc


@_scoped
def change_routine(job_id: str, action: str, updates: Optional[dict] = None) -> Optional[dict]:
    jobs = _cron()
    try:
        if action == "update":
            allowed = {k: v for k, v in (updates or {}).items() if k in ("name", "prompt", "schedule")}
            job = jobs.update_job(job_id, allowed)
        elif action == "pause":
            job = jobs.pause_job(job_id, "paused from Winglet")
        elif action == "resume":
            job = jobs.resume_job(job_id)
        elif action == "run":
            job = jobs.trigger_job(job_id)
        elif action == "delete":
            return {"deleted": bool(jobs.remove_job(job_id))}
        else:
            raise HermesRefused("unknown action")
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc
    return _job_view(job) if job else None


# -- goals ---------------------------------------------------------------------------------


def goals_available() -> bool:
    """Whether this Hermes has standing goals (/goal). Older versions don't."""
    try:
        import hermes_cli.goals  # noqa: F401
    except Exception:
        return False
    return True


def chat_goal(runner, session_key: str) -> Optional[dict]:
    """The standing goal (/goal) a chat's Hermes session is working on, or None. Read-only: the app
    changes goals by sending /goal and /subgoal, so Hermes's own rules and judge apply."""
    try:
        session_id = runner.session_store.peek_session_id(session_key)
    except Exception:
        return None
    if not session_id:
        return None
    try:
        from hermes_cli.goals import load_goal
    except Exception as exc:
        raise HermesUnavailable("goals unavailable") from exc
    with _profile_scope():
        state = load_goal(session_id)
    if state is None or state.status == "cleared" or not state.goal:
        return None
    import time as _time
    waiting = bool(state.waiting_reason) and (not state.waiting_until or state.waiting_until > _time.time())
    return {"goal": state.goal, "status": state.status, "turns_used": state.turns_used, "max_turns": state.max_turns,
            "subgoals": list(state.subgoals), "last_verdict": state.last_verdict, "last_reason": state.last_reason,
            "paused_reason": state.paused_reason, "waiting_reason": state.waiting_reason if waiting else None,
            "created_at": state.created_at, "last_turn_at": state.last_turn_at}


# -- workspace checkpoints --------------------------------------------------------------------
#
# Hermes snapshots the folder a bot works in just before the agent changes files (its own
# /rollback, tools/checkpoint_manager.py). These read and restore those snapshots; they never
# touch the transcript. A snapshot belongs to one folder and one Hermes profile.


def checkpoints_available() -> bool:
    """Whether this Hermes keeps filesystem checkpoints at all."""
    try:
        from tools.checkpoint_manager import CheckpointManager  # noqa: F401
    except Exception:
        return False
    return True


def checkpoint_restore_available() -> bool:
    """Whether it can also put them back (a list-only Hermes keeps the restore button hidden)."""
    try:
        from tools.checkpoint_manager import CheckpointManager
    except Exception:
        return False
    return callable(getattr(CheckpointManager, "restore", None))


def _checkpoint_dir() -> str:
    """The folder this bot works in: Hermes's own terminal scope, never a caller-supplied path."""
    import os
    from pathlib import Path

    raw = ""
    try:
        from gateway.run import _terminal_scope_cwd
    except ImportError:
        _terminal_scope_cwd = None
    if _terminal_scope_cwd is not None:
        # Raises rather than borrowing the launch profile's folder when a refusal scope is active.
        raw = _terminal_scope_cwd("") or ""
    else:
        try:
            from tools.terminal_scope import terminal_env
            raw = terminal_env("TERMINAL_CWD", "") or ""
        except Exception:
            raw = os.environ.get("TERMINAL_CWD", "") or ""
    path = Path(raw).expanduser() if raw else Path.cwd()
    try:
        return str(path.resolve(strict=False))
    except OSError:
        return str(path)


def _display_path(path: str) -> str:
    """A folder for the screen: its home is shown as ``~``, never the server's whole path."""
    try:
        from pathlib import Path
        home = str(Path.home())
        text = str(path)
        if text == home:
            return "~"
        if text.startswith(home + ("\\" if "\\" in home else "/")):
            return "~" + text[len(home):]
        return text
    except Exception:
        return str(path)


def _checkpoint_manager():
    """Hermes's manager for this profile's checkpoint settings, or None if it has none."""
    try:
        from tools.checkpoint_manager import CheckpointManager
    except Exception:
        return None
    try:
        from hermes_cli.config import DEFAULT_CONFIG, load_config
        config = load_config() or {}
    except Exception as exc:
        raise HermesUnavailable("checkpoint settings unavailable") from exc
    section = config.get("checkpoints") if isinstance(config, dict) else None
    if isinstance(section, bool):
        section = {"enabled": section}
    if not isinstance(section, dict):
        section = {}
    defaults = DEFAULT_CONFIG.get("checkpoints") if isinstance(DEFAULT_CONFIG, dict) else {}
    defaults = defaults if isinstance(defaults, dict) else {}

    def pick(name, fallback):
        value = section.get(name, defaults.get(name, fallback))
        return value

    def number(name, fallback):
        try:
            return int(pick(name, fallback))
        except (TypeError, ValueError):
            return fallback

    return CheckpointManager(enabled=bool(pick("enabled", False)), max_snapshots=number("max_snapshots", 20),
                             max_total_size_mb=number("max_total_size_mb", 500),
                             max_file_size_mb=number("max_file_size_mb", 10))


def _checkpoint_epoch(value) -> float:
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _checkpoint_workspace(manager) -> str:
    """The folder Hermes checkpoints for this bot: its project-marker resolution, or the cwd."""
    directory = _checkpoint_dir()
    try:
        return str(manager.get_working_dir_for_path(directory))
    except Exception:
        logger.debug("[winglet] checkpoint folder resolution failed", exc_info=True)
        return directory


@_scoped
def checkpoints_state() -> dict:
    """{supported, enabled, reason, can_restore, workspace}: what this bot can do with checkpoints."""
    import os

    manager = _checkpoint_manager()
    if manager is None:
        return {"supported": False, "enabled": False, "can_restore": False,
                "reason": "This Hermes version doesn't keep checkpoints.", "workspace": {"path": "", "name": ""}}
    directory = _checkpoint_workspace(manager)
    reason = ""
    try:
        # Refused for a container terminal: the paths belong inside the container, not this host.
        reason = str(manager.unsupported_backend_reason() or "")
    except Exception:
        reason = ""
    enabled = bool(manager.enabled) and not reason
    if not manager.enabled:
        reason = ""
    return {"supported": True, "enabled": enabled, "reason": reason,
            "can_restore": callable(getattr(manager, "restore", None)),
            "workspace": {"path": _display_path(directory), "name": os.path.basename(directory.rstrip("/\\")) or directory}}


@_scoped
def list_checkpoints() -> list:
    """The workspace's snapshots, newest first, in one shape whatever Hermes calls the fields."""
    manager = _checkpoint_manager()
    if manager is None:
        raise HermesUnavailable("checkpoints unavailable")
    directory = _checkpoint_workspace(manager)
    rows = []
    for entry in manager.list_checkpoints(directory) or []:
        if not isinstance(entry, dict):
            continue
        digest = str(entry.get("hash") or "")
        rows.append({"hash": digest, "short": str(entry.get("short_hash") or digest[:8]),
                     "at": _checkpoint_epoch(entry.get("timestamp")),
                     "label": str(entry.get("reason") or "Checkpoint"),
                     "files": int(entry.get("files_changed") or 0),
                     "insertions": int(entry.get("insertions") or 0),
                     "deletions": int(entry.get("deletions") or 0)})
    return rows


@_scoped
def checkpoint_diff(commit_hash: str) -> dict:
    """What changed in the workspace since a checkpoint: {success, stat, diff} or {success: False, error}."""
    manager = _checkpoint_manager()
    if manager is None:
        raise HermesUnavailable("checkpoints unavailable")
    directory = _checkpoint_workspace(manager)
    result = manager.diff(directory, commit_hash)
    return dict(result) if isinstance(result, dict) else {"success": False, "error": "Couldn't read the changes."}


@_scoped
def restore_checkpoint(commit_hash: str, safe: bool = True) -> dict:
    """Put the workspace files back as they were at a checkpoint, Hermes's own safe restore when
    asked: files the owner edited themselves since are left alone."""
    manager = _checkpoint_manager()
    if manager is None:
        raise HermesUnavailable("checkpoints unavailable")
    directory = _checkpoint_workspace(manager)
    if safe:
        # Hermes falls back to a full restore when its write ledger is empty. Keep the
        # app's safe-mode promise: validate its plan inside the manager's own store lock.
        # This manager belongs to this call; no global patch or second lock is needed.
        planner = getattr(manager, "_safe_restore_plan", None)
        refusal = {"success": False, "error": (
            "Hermes can't safely distinguish your edits because its file-write history is unavailable. "
            "Nothing was restored. To overwrite your edits too, turn on "
            "'Also revert files I edited myself' and confirm again.")}
        if not callable(planner):
            return refusal

        def guarded_plan(*args, **kwargs):
            plan = planner(*args, **kwargs)
            if isinstance(plan, dict) and plan.get("success") is False:
                return plan
            if (not isinstance(plan, dict) or plan.get("success") is not True
                    or plan.get("ledger_empty")
                    or not isinstance(plan.get("restore"), list)
                    or not isinstance(plan.get("skipped"), list)):
                return dict(refusal)
            return plan

        manager._safe_restore_plan = guarded_plan
    result = manager.restore(directory, commit_hash, safe=bool(safe))
    return dict(result) if isinstance(result, dict) else {"success": False, "error": "The restore failed."}


# -- abilities: skills, toolsets, MCP servers ------------------------------------------------
#
# The same functions behind the Skills, Tools and MCP pages of Hermes's dashboard. Toolsets are
# Winglet's own (``platform_toolsets.winglet``), so turning one off here doesn't touch the terminal.

PLATFORM = "winglet"
# The override for a member limited to nothing: an override must name something, and this names no
# toolset and keeps MCP servers out. It isn't a deny-all on its own (Hermes still adds default-on plugin
# toolsets, and x_search when xAI keys exist); limit_turn_toolsets enforces the limit on the result.
NO_TOOLS = ["no_mcp"]
APPROVAL_MODES = ("manual", "smart", "off")
MAX_SKILL_BYTES = 200_000


def _router(name: str):
    import importlib
    try:
        return importlib.import_module(f"hermes_cli.web_routers.{name}")
    except Exception as exc:
        raise HermesUnavailable(f"{name} unavailable") from exc


def _models():
    try:
        import hermes_cli.web_models as models
    except Exception as exc:
        raise HermesUnavailable("dashboard models unavailable") from exc
    return models


def _takes_profile(fn) -> bool:
    import inspect
    try:
        return "profile" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


async def _route(fn, *args):
    """Await one of the dashboard's route functions as this profile. A route that takes a ``profile``
    gets the current bot's, so actions it spawns (skill installs) run as that profile too. Its HTTP
    errors carry a message meant for a person; they become refusals."""
    kwargs = {"profile": _BOT.get()} if _BOT.get() and _takes_profile(fn) else {}
    try:
        with _profile_scope():
            return await fn(*args, **kwargs)
    except (HermesUnavailable, HermesRefused):
        raise
    except Exception as exc:
        if isinstance(getattr(exc, "status_code", None), int):
            raise HermesRefused(_detail(exc)) from exc
        raise


def _skills_changed() -> None:
    """New skill commands for the command palette, and a fresh skills index for new sessions."""
    try:
        from agent.skill_commands import reload_skills
        reload_skills()
    except Exception:
        logger.debug("[winglet] skill reload unavailable", exc_info=True)
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        logger.debug("[winglet] skills prompt cache unavailable", exc_info=True)


async def list_skills() -> List[dict]:
    """Installed skills: {name, description, category, enabled, provenance (bundled|hub|agent), usage}."""
    rows = await _route(_router("skills").get_skills)
    keys = ("name", "description", "category", "enabled", "provenance", "usage")
    return [{k: row.get(k) for k in keys} for row in rows]


async def set_skill_enabled(name: str, enabled: bool) -> None:
    if name not in {s["name"] for s in await list_skills()}:
        raise HermesRefused(f"There's no skill called {name}.")
    await _route(_router("skills").toggle_skill, _models().SkillToggle(name=name, enabled=enabled))
    _skills_changed()


async def skill_content(name: str) -> dict:
    data = await _route(_router("skills").get_skill_content, name)
    content = str(data.get("content") or "")
    return {"name": name, "content": content[:MAX_SKILL_BYTES], "truncated": len(content) > MAX_SKILL_BYTES}


async def skill_catalog() -> List[dict]:
    """Hermes's official optional skills, which ship with Hermes and install without the network."""
    data = await _route(_router("skills").list_official_skills)
    keys = ("name", "description", "identifier", "category", "tags", "installed")
    return [{k: row.get(k) for k in keys} for row in data.get("skills") or []]


async def start_skill_install(identifier: str) -> str:
    """Start `hermes skills install` for an official skill. Returns the action to follow."""
    if identifier not in {s["identifier"] for s in await skill_catalog()}:
        raise HermesRefused("Only Hermes's official skills can be installed from the app.")
    started = await _route(_router("skills").install_skill_hub, _models().SkillInstallRequest(identifier=identifier))
    return str(started["name"])


async def start_skill_uninstall(name: str) -> str:
    skill = next((s for s in await list_skills() if s["name"] == name), None)
    if skill is None or skill["provenance"] != "hub":
        raise HermesRefused("Only skills installed from a hub can be removed. Turn this one off instead.")
    started = await _route(_router("skills").uninstall_skill_hub, _models().SkillUninstallRequest(name=name))
    return str(started["name"])


async def action_status(action: str) -> dict:
    """{running, exit_code, lines} for a background `hermes` action this process started."""
    return dict(await _route(_router("actions").get_action_status, action, 40))


def finish_skill_action() -> None:
    _skills_changed()


def _toolset_rows(config: dict) -> list:
    from hermes_cli.tools_config import (
        _CONFIG_ONLY_TOOLSETS, _get_effective_configurable_toolsets, _toolset_allowed_for_platform)
    return [(name, label, desc) for name, label, desc in _get_effective_configurable_toolsets()
            if name not in _CONFIG_ONLY_TOOLSETS and _toolset_allowed_for_platform(name, PLATFORM)]


def _enabled_toolsets(config: dict) -> set:
    from hermes_cli.tools_config import _get_platform_tools
    enabled = set(_get_platform_tools(config, PLATFORM, include_default_mcp_servers=False))
    # Until a list is saved, Hermes reports a plugin platform's whole default bundle as one entry. Saved,
    # it would bring back every toolset the owner turns off.
    enabled.discard(f"hermes-{PLATFORM}")
    return enabled


@_scoped
def toolsets() -> List[dict]:
    """The toolsets the agent has when it works for Winglet: {name, label, description, enabled, configured}.
    configured is False when a toolset still needs a key or a provider set up on the server."""
    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _toolset_has_keys, get_nous_subscription_features, gui_toolset_label
    except Exception as exc:
        raise HermesUnavailable("toolsets unavailable") from exc
    config = load_config()
    enabled = _enabled_toolsets(config)
    features = get_nous_subscription_features(config)
    out = []
    for name, label, desc in _toolset_rows(config):
        try:
            configured = bool(_toolset_has_keys(name, config, features=features))
        except Exception:
            configured = True
        out.append({"name": name, "label": gui_toolset_label(label), "description": desc,
                    "enabled": name in enabled, "configured": configured})
    return out


@_scoped
def set_toolset(name: str, enabled: bool) -> None:
    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _save_platform_tools
        from hermes_cli.web_routers._common import config_write_scope
    except Exception as exc:
        raise HermesUnavailable("toolsets unavailable") from exc
    with config_write_scope(None):
        config = load_config()
        if name not in {row[0] for row in _toolset_rows(config)}:
            raise HermesRefused(f"There's no toolset called {name}.")
        current = _enabled_toolsets(config)
        if enabled:
            current.add(name)
        else:
            current.discard(name)
        _save_platform_tools(config, PLATFORM, current)


@_scoped
def member_toolsets(allowed: List[str], mcp: bool) -> List[str]:
    """The toolset override for a member whose tools are limited: what they're allowed, if the owner
    has it on too. MCP servers only when allowed and on for the owner."""
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names
    config = load_config()
    mine = _enabled_toolsets(config)
    keep = sorted(set(allowed) & mine & {row[0] for row in _toolset_rows(config)})
    if mcp:
        # The owner's MCP servers by name, so the member's list can't widen them.
        servers = sorted(set(_get_platform_tools(config, PLATFORM)) & enabled_mcp_server_names(config))
        keep += servers if servers else ["no_mcp"]
    else:
        keep.append("no_mcp")
    return keep or list(NO_TOOLS)


def limit_turn_toolsets(runner, platform: str) -> bool:
    """Cap the toolsets of every turn from ``platform`` at what that turn's own adapter allows. Each call
    asks the adapter Hermes routes the source to (each profile has its own, and a reconnect replaces it)
    through ``adapter.toolset_limit(source)``: None leaves the turn as Hermes resolved it, a set is the
    most it may end with. The cap applies after Hermes has added anything of its own, so nothing reaches
    a limited turn implicitly, and a turn whose limit can't be worked out gets no tools. Other platforms
    are untouched. False when this Hermes lacks either step, and limits can't be enforced."""
    resolve = getattr(runner, "_resolve_enabled_toolsets_for_source", None)
    route = getattr(runner, "_delivery_adapter_for", None)
    if resolve is None or route is None:
        return False
    if getattr(resolve, "winglet_limited", False):
        return True

    @functools.wraps(resolve)
    def limited(user_config, source, platform_key):
        enabled = resolve(user_config, source, platform_key)
        kind = getattr(source, "platform", None)
        if getattr(kind, "value", kind) != platform:
            return enabled
        try:
            allowed = route(source).toolset_limit(source)
        except Exception:
            logger.warning("[winglet] couldn't work out a turn's tool limit; giving it none", exc_info=True)
            allowed = set()
        return enabled if allowed is None else [name for name in enabled if name in allowed]

    limited.winglet_limited = True
    runner._resolve_enabled_toolsets_for_source = limited
    return True


@_scoped
def approval_mode() -> str:
    from hermes_cli.config import load_config
    mode = (load_config().get("approvals") or {}).get("mode", "manual")
    if mode is False:
        return "off"
    mode = str(mode).strip().lower()
    return mode if mode in APPROVAL_MODES else "manual"


@_scoped
def set_approval_mode(mode: str) -> None:
    if mode not in APPROVAL_MODES:
        raise HermesRefused("mode must be manual, smart or off")
    try:
        from hermes_cli.config import load_config, save_config
        from hermes_cli.web_routers._common import config_write_scope
    except Exception as exc:
        raise HermesUnavailable("approval settings unavailable") from exc
    with config_write_scope(None):
        config = load_config()
        section = config.get("approvals")
        if not isinstance(section, dict):
            section = config["approvals"] = {}
        section["mode"] = mode
        save_config(config)


async def mcp_servers() -> List[dict]:
    """Configured MCP servers, without their arguments or environment (they can carry keys)."""
    data = await _route(_router("mcp").list_mcp_servers)
    keys = ("name", "transport", "url", "command", "auth", "enabled", "source", "plugin")
    return [{k: s.get(k) for k in keys} for s in data.get("servers") or []]


async def set_mcp_enabled(name: str, enabled: bool) -> None:
    await _route(_router("mcp").set_mcp_server_enabled, name, _models().MCPEnabledToggle(enabled=enabled))


async def test_mcp(name: str) -> dict:
    """Connect, list the tools, disconnect: {ok, error, tools: [{name, description}]}."""
    data = await _route(_router("mcp").test_mcp_server, name)
    tools = [{"name": t.get("name"), "description": str(t.get("description") or "")[:300]} for t in data.get("tools") or []]
    return {"ok": bool(data.get("ok")), "error": data.get("error"), "tools": tools}


async def remove_mcp(name: str) -> None:
    await _route(_router("mcp").remove_mcp_server, name)


async def mcp_catalog() -> dict:
    """Hermes's approved MCP servers. Each entry shows what it runs or connects to, so the owner can
    check before adding it."""
    data = await _route(_router("mcp").list_mcp_catalog)
    keys = ("name", "description", "transport", "auth_type", "required_env", "command", "args", "url",
            "install_url", "needs_install", "post_install", "installed", "enabled")
    return {"entries": [{k: e.get(k) for k in keys} for e in data.get("entries") or []],
            "diagnostics": list(data.get("diagnostics") or [])}


async def install_mcp(name: str, env: dict) -> Optional[str]:
    """Add a catalog server, with the keys it asks for. Returns the action to follow when it has to
    download and build first, else None."""
    started = await _route(_router("mcp").install_mcp_catalog_entry,
                           _models().MCPCatalogInstall(name=name, env=env, enable=True))
    return str(started["action"]) if started.get("background") else None


async def reload_mcp(runner, event) -> str:
    """Hermes's /reload-mcp: reconnect every server and tell running chats their tools changed."""
    reload = getattr(runner, "_execute_mcp_reload", None)
    if reload is None:
        raise HermesUnavailable("MCP reload unavailable")
    return str(await reload(event))


# MCP sign-in: the server's OAuth page opens on the phone and comes back to Winglet, which hands the
# result to the same flow Hermes's dashboard uses.
_SIGN_IN_TTL = 15 * 60
_MAX_SIGN_INS = 4
_sign_ins: dict = {}


def _sign_in_view(flow) -> dict:
    view = flow.snapshot()
    return {"id": view["flow_id"], "server": view["server_name"], "status": view["status"],
            "authorization_url": view["authorization_url"], "error": view["error"],
            "tools": [t.get("name") for t in flow.tools] if view["status"] == "approved" else []}


def _forget_old_sign_ins() -> None:
    import time as _time
    cutoff = _time.time() - _SIGN_IN_TTL
    for flow_id, flow in list(_sign_ins.items()):
        if flow.created_at < cutoff:
            flow.mark_error("Timed out", cancelled=True)
            _sign_ins.pop(flow_id, None)


async def start_mcp_sign_in(name: str, callback_url: str) -> dict:
    import asyncio as _asyncio
    import secrets
    import threading
    try:
        from hermes_cli.mcp_config import _get_mcp_servers
        from hermes_cli.web_server_mcp import _run_dashboard_mcp_oauth
        from hermes_constants import get_hermes_home
        from tools.mcp_dashboard_oauth import DashboardOAuthFlow, exception_message
        from tui_gateway.mcp_rpc_helpers import server_configs_with_sources
    except Exception as exc:
        raise HermesUnavailable("MCP sign-in unavailable") from exc

    @_scoped
    def read():
        servers, plugins = server_configs_with_sources(_get_mcp_servers())
        return servers, plugins, str(get_hermes_home().expanduser().resolve(strict=False))

    servers, plugins, home = await _asyncio.to_thread(read)
    if name not in servers:
        raise HermesRefused(f"There's no MCP server called {name}.")
    if plugins.get(name):
        raise HermesRefused(f"{name} comes with the {plugins[name]} plugin and signs in there.")
    cfg = dict(servers[name])
    if not cfg.get("url"):
        raise HermesRefused("This server runs on the server itself and uses keys, not a sign-in.")
    if cfg.get("headers") and cfg.get("auth") != "oauth":
        raise HermesRefused("This server uses an API key, not a sign-in.")
    cfg["auth"] = "oauth"
    _forget_old_sign_ins()
    for flow in list(_sign_ins.values()):
        if flow.server_name == name and not flow.worker_done:
            flow.mark_error("Started again", cancelled=True)
    if sum(not f.worker_done for f in _sign_ins.values()) >= _MAX_SIGN_INS:
        raise HermesRefused("Too many sign-ins are in progress. Try again in a few minutes.")
    flow = DashboardOAuthFlow(flow_id=secrets.token_urlsafe(24), server_name=name, profile=_BOT.get(), hermes_home=home,
                              redirect_uri=(cfg.get("oauth") or {}).get("redirect_uri") or callback_url,
                              reconnect_live=True)
    _sign_ins[flow.flow_id] = flow
    threading.Thread(target=_run_dashboard_mcp_oauth, args=(flow, cfg), daemon=True, name=f"winglet-mcp-{name}").start()
    try:
        await flow.wait_for_authorization_url(timeout=30)
    except Exception as exc:
        flow.mark_error(exception_message(exc))
    return _sign_in_view(flow)


def mcp_sign_in(flow_id: str) -> Optional[dict]:
    flow = _sign_ins.get(flow_id)
    return _sign_in_view(flow) if flow is not None else None


def cancel_mcp_sign_in(flow_id: str) -> None:
    flow = _sign_ins.get(flow_id)
    if flow is not None:
        flow.mark_error("Cancelled", cancelled=True)


def finish_mcp_sign_in(server: str, *, code: Optional[str], state: Optional[str], error: Optional[str],
                       iss: Optional[str]) -> str:
    """Hand the browser's return to the waiting sign-in: "ok", "denied", "expired" or "rejected"."""
    import secrets
    flow = next((f for f in _sign_ins.values()
                 if f.server_name == server and f.status == "authorization_required" and f.expected_state
                 and state and secrets.compare_digest(f.expected_state, state)), None)
    if flow is None:
        return "expired"
    try:
        flow.deliver_callback(code=code, state=state, error=error, iss=iss)
    except ValueError:
        return "rejected"
    return "denied" if error else "ok"


# -- sessions: every conversation Hermes has had, on any platform (read-only) ----------------------------

MAX_SESSION_TEXT = 20_000
MAX_TOOL_TEXT = 2_000


def sessions_available() -> bool:
    try:
        r = _router("sessions")
    except HermesUnavailable:
        return False
    return all(hasattr(r, name) for name in ("get_sessions", "search_sessions", "get_session_detail",
                                             "get_session_messages"))


def _session_row(row: dict) -> dict:
    preview = " ".join(str(row.get("preview") or "").split())
    return {"id": str(row.get("id") or ""), "title": row.get("title") or row.get("display_name") or None,
            "source": row.get("source") or "", "model": row.get("model") or "",
            "started_at": row.get("started_at"), "last_active": row.get("last_active") or row.get("started_at"),
            "message_count": int(row.get("message_count") or 0), "tool_call_count": int(row.get("tool_call_count") or 0),
            "preview": preview[:200], "active": bool(row.get("is_active")), "pinned": bool(row.get("pinned"))}


def list_sessions(limit: int, offset: int) -> dict:
    """The most recently active conversations first, across every platform and routine."""
    get_sessions = _router("sessions").get_sessions
    try:
        with _profile_scope():
            # Called directly, so every query parameter is passed: their defaults are FastAPI markers.
            page = get_sessions(limit=limit, offset=offset, min_messages=1, archived="exclude", order="recent",
                                source=None, sources=None, exclude_sources=None, cwd_prefix=None, full=False,
                                profile=_BOT.get())
    except Exception as exc:
        if isinstance(getattr(exc, "status_code", None), int):
            raise HermesRefused(_detail(exc)) from exc
        raise
    return {"sessions": [_session_row(s) for s in page.get("sessions") or []], "total": int(page.get("total") or 0)}


async def search_sessions(query: str, limit: int = 30) -> list:
    r = _router("sessions")
    found = await _route(lambda: r.search_sessions(q=query, limit=limit, profile=_BOT.get(), source=None, sources=None,
                                                   exclude_sources=None))
    return [{**_session_row(x), "snippet": str(x.get("snippet") or "")[:300], "role": x.get("role")}
            for x in found.get("results") or []]


def _message_text(message: dict) -> str:
    content = message.get("display_content")
    if content is None:
        content = message.get("content")
    if isinstance(content, list):
        content = " ".join(str(part.get("text") or "") if isinstance(part, dict) else str(part) for part in content)
    return str(content or "")


def _tool_names(calls) -> list:
    if isinstance(calls, str):
        try:
            calls = json.loads(calls)
        except ValueError:
            return []
    names = []
    for call in calls or []:
        if isinstance(call, dict):
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = fn.get("name") or call.get("name")
            if name:
                names.append(str(name))
    return names


def _session_message(message: dict) -> Optional[dict]:
    role = message.get("role")
    if role not in ("user", "assistant", "tool") or message.get("display_kind") == "hidden":
        return None
    text = _message_text(message)
    limit = MAX_TOOL_TEXT if role == "tool" else MAX_SESSION_TEXT
    try:
        at = float(message.get("timestamp")) if message.get("timestamp") is not None else None
    except (TypeError, ValueError):
        at = None
    item = {"id": str(message.get("id") or message.get("message_uid") or ""), "role": role,
            "text": text if len(text) <= limit else text[:limit] + "…", "at": at,
            "failed": message.get("display_kind") == "failed_turn"}
    if role == "assistant":
        item["tools"] = _tool_names(message.get("tool_calls"))
    if role == "tool":
        item["tool"] = message.get("tool_name") or ""
    if not item["text"] and not item.get("tools"):
        return None
    return item


async def session_transcript(session_id: str) -> dict:
    """One conversation's latest 500 messages, as text: images are named, not sent."""
    r = _router("sessions")
    detail = await _route(lambda: r.get_session_detail(session_id, profile=_BOT.get()))
    page = await _route(lambda: r.get_session_messages(session_id, profile=_BOT.get(), limit=None, offset=0, order=None,
                                                       include_compacted=False, inline_images=False))
    messages = [m for m in (_session_message(x) for x in page.get("messages") or []) if m]
    return {"session": _session_row(detail), "messages": messages,
            "truncated": (page.get("pagination") or {}).get("returned", 0) >= 500}


# -- pets: the agent's animated face, from Hermes's own pet store (agent/pet) and petdex.dev --------

PET_CATALOG_PAGE = 30
_pet_sheets: dict = {}


def _pet_engine():
    try:
        from agent.pet import constants, manifest, store
        from hermes_cli import pets as pet_config
    except Exception as exc:
        raise HermesUnavailable("pets unavailable") from exc
    return constants, manifest, store, pet_config


def pets_available() -> bool:
    try:
        _pet_engine()
        return True
    except HermesUnavailable:
        return False


def _pet_settings() -> dict:
    """``display.pet`` from the config: slug, enabled and the desktop's own settings."""
    from hermes_cli.config import load_config
    display = load_config().get("display")
    pet = display.get("pet") if isinstance(display, dict) else None
    return pet if isinstance(pet, dict) else {}


def _truthy(value) -> bool:
    try:
        from utils import is_truthy_value
        return is_truthy_value(value, default=False)
    except ImportError:
        return str(value).strip().lower() in ("1", "true", "yes", "on")


def _active_pet():
    """The pet Hermes shows: the configured one when the display is on, else None. Like Hermes, a
    configured pet that's gone falls back to the first one installed."""
    _, _, store, _ = _pet_engine()
    settings = _pet_settings()
    if not _truthy(settings.get("enabled")):
        return None
    return store.resolve_active_pet(str(settings.get("slug") or ""))


def _pet_sheet(pet) -> dict:
    """How to cut a pet's spritesheet into frames, worked out once per version of the file."""
    constants, _, _, _ = _pet_engine()
    stat = pet.spritesheet.stat()
    key = (str(pet.spritesheet), stat.st_mtime_ns, stat.st_size)
    if key not in _pet_sheets:
        from PIL import Image
        from agent.pet import render
        from .petcolor import pet_palette
        with Image.open(pet.spritesheet) as image:
            width, height = image.size
            rows = max(1, height // constants.FRAME_H)
            state_rows = list(constants.state_rows_for_grid(rows))
            idle = state_rows.index("idle") if "idle" in state_rows else 0
            try:
                palette = pet_palette(image.crop((0, idle * constants.FRAME_H, constants.FRAME_W, (idle + 1) * constants.FRAME_H)))
            except Exception:  # a palette is a nicety; the sheet must still load
                palette = None
        try:
            frames = render.state_frame_counts(str(pet.spritesheet))
        except Exception:
            frames = {}
        while len(_pet_sheets) >= 8:
            _pet_sheets.pop(next(iter(_pet_sheets)))
        _pet_sheets[key] = {
            "revision": hashlib.sha256(repr(key).encode()).hexdigest()[:16],
            "mime": "image/png" if pet.spritesheet.suffix.lower() == ".png" else "image/webp",
            "frame_w": constants.FRAME_W, "frame_h": constants.FRAME_H,
            "columns": max(1, width // constants.FRAME_W), "rows": rows,
            "state_rows": state_rows, "frames_per_state": constants.FRAMES_PER_STATE,
            "frames": {str(k): int(v) for k, v in frames.items()}, "loop_ms": constants.LOOP_MS,
            **({"palette": palette} if palette else {}),
        }
    return {**_pet_sheets[key], "slug": pet.slug, "name": pet.display_name, "path": str(pet.spritesheet)}


@_scoped
def active_pet() -> Optional[dict]:
    """The agent's pet with its spritesheet's geometry, or None when it has none showing."""
    pet = _active_pet()
    return _pet_sheet(pet) if pet is not None and pet.exists else None


@_scoped
def pet_sheet(slug: str) -> Optional[dict]:
    """Any installed pet's spritesheet, for previews."""
    _, _, store, _ = _pet_engine()
    pet = store.load_pet(slug)
    return _pet_sheet(pet) if pet is not None and pet.exists else None


@_scoped
def pets() -> dict:
    """Installed pets, and the one showing."""
    _, _, store, _ = _pet_engine()
    active = _active_pet()
    return {"enabled": active is not None, "active": active.slug if active else "",
            "pets": [{"slug": p.slug, "name": p.display_name, "description": p.description, "generated": p.generated}
                     for p in store.installed_pets()]}


def prefetch_pet_catalog() -> None:
    """Start fetching the petdex gallery in the background (Hermes caches it), so it's ready when asked."""
    _, manifest, _, _ = _pet_engine()
    manifest.prefetch()


@_scoped
def pet_catalog(query: str = "", offset: int = 0, limit: int = PET_CATALOG_PAGE) -> dict:
    """A page of the petdex gallery, hand-picked pets first, with what's installed here marked."""
    _, manifest, store, _ = _pet_engine()
    try:
        entries = manifest.fetch_manifest()
    except manifest.ManifestError as exc:
        raise HermesRefused("Couldn't reach the pet gallery at petdex.dev. Try again later.") from exc
    installed = {p.slug for p in store.installed_pets()}
    words = query.lower().split()
    found = [e for e in entries if all(w in f"{e.slug} {e.display_name} {e.submitted_by}".lower() for w in words)]
    found.sort(key=lambda e: "/curated/" not in e.spritesheet_url)
    return {"total": len(found), "pets": [
        {"slug": e.slug, "name": e.display_name, "kind": e.kind, "by": e.submitted_by,
         "curated": "/curated/" in e.spritesheet_url, "installed": e.slug in installed}
        for e in found[offset:offset + limit]]}


@_scoped
def pet_thumbnail(slug: str) -> Optional[bytes]:
    """A small PNG of a pet's first frame. Pets that aren't installed are fetched from petdex once and
    cached; Hermes only fetches from petdex's own hosts."""
    _, manifest, store, _ = _pet_engine()
    pet = store.load_pet(slug)
    if pet is not None and pet.exists:
        return store.thumbnail_png(pet.slug)
    try:
        entry = manifest.find_entry(slug)
    except manifest.ManifestError:
        return None
    return store.thumbnail_png(entry.slug, source_url=entry.spritesheet_url) if entry else None


@_scoped
def pet_installed(slug: str) -> bool:
    _, _, store, _ = _pet_engine()
    pet = store.load_pet(slug)
    return pet is not None and pet.exists


@_scoped
def adopt_pet(slug: str) -> dict:
    """Install a pet from petdex when it isn't here yet, and make it the one showing."""
    _, manifest, store, pet_config = _pet_engine()
    try:
        pet = store.install_pet(slug)
    except (store.PetStoreError, manifest.ManifestError) as exc:
        raise HermesRefused(f"Couldn't get that pet: {exc}") from exc
    pet_config._set_active(pet.slug)
    return {"slug": pet.slug, "name": pet.display_name}


@_scoped
def remove_pet(slug: str) -> bool:
    """Delete an installed pet. When it was the one showing, the display turns off, as in Hermes."""
    _, _, store, pet_config = _pet_engine()
    removed = store.remove_pet(slug)
    pet_config._clear_active_if(slug)
    return removed


@_scoped
def show_pet(on: bool) -> Optional[dict]:
    """Turn the pet display on (the configured pet, else the first installed) or off."""
    _, _, store, pet_config = _pet_engine()
    if not on:
        pet_config._set_enabled(False)
        return None
    pet = store.resolve_active_pet(str(_pet_settings().get("slug") or ""))
    if pet is None:
        raise HermesRefused("Adopt a pet first.")
    pet_config._set_active(pet.slug)
    return {"slug": pet.slug, "name": pet.display_name}



# -- bots: Hermes profiles served by this gateway, each its own agent (Hermes Desktop's Bots) -------

def _rpc(method: str, params: dict) -> dict:
    """Call one of Hermes's own profile handlers (the ones Hermes Desktop uses), so a bot made here is
    made exactly as Desktop makes it."""
    try:
        from tui_gateway import server
        handler = server._methods[method]
    except Exception as exc:
        raise HermesUnavailable(f"{method} unavailable") from exc
    reply = handler("winglet", params) or {}
    if reply.get("error"):
        raise HermesRefused(str((reply["error"] or {}).get("message") or "Hermes refused that."))
    return reply.get("result") or {}


def bots_available() -> bool:
    try:
        from hermes_cli.profiles import profiles_to_serve, read_profile_meta  # noqa: F401
        from tui_gateway import server
        return "profiles.create" in server._methods
    except Exception:
        return False


def _bot_row(name: str, home) -> dict:
    from hermes_cli.profiles import read_profile_meta
    meta = read_profile_meta(home)
    title = meta.get("bot_title") or meta.get("display_name") or name.replace("-", " ").replace("_", " ").title()
    return {"name": name, "title": title, "description": meta.get("description") or ""}


def list_bots() -> List[dict]:
    """Every profile this install has, other than the main one, as a bot. Made in Hermes Desktop, the CLI
    or here: they're all the same."""
    from hermes_cli.profiles import profiles_to_serve
    return [_bot_row(name, home) for name, home in profiles_to_serve(multiplex=True) if name != "default"]


def create_bot(name: str, title: str, persona: str, description: str = "") -> dict:
    """A new profile set up the way Hermes Desktop's Create bot does: the main profile's provider keys and
    model (never its chat-platform tokens), the bundled skills, the persona as SOUL.md, and the Bot Mode
    title that makes it a teammate of the other bots."""
    from hermes_cli.profiles import normalize_profile_name, validate_profile_name
    try:
        name = normalize_profile_name(name)
        validate_profile_name(name)
    except ValueError as exc:
        raise HermesRefused(str(exc)) from exc
    import time as _time
    _rpc("profiles.create", {"name": name, "soul": persona, "description": description})
    _rpc("profiles.configure", {"name": name, "ui_meta": {"hermes-bots": {"title": title, "created": int(_time.time() * 1000)}}})
    from hermes_cli.profiles import get_profile_dir
    return _bot_row(name, get_profile_dir(name))


def multiplex_state(runner) -> dict:
    """Whether this gateway serves every profile (Hermes's multi-profile mode), which profiles it serves,
    and, when it serves only one, Hermes's own reason why."""
    served: List[str] = []
    with contextlib.suppress(Exception):
        served = [str(n) for n in runner.served_profile_names()]
    active = False
    with contextlib.suppress(Exception):
        from agent.secret_scope import is_multiplex_active
        active = bool(is_multiplex_active())
    reason = ""
    if not active:
        with contextlib.suppress(Exception):
            from gateway.status import read_runtime_status
            reason = str((read_runtime_status() or {}).get("multiplex_standalone_reason") or "")
    return {"multiplex": active or len(served) > 1, "served": served, "reason": reason}


def _bot_meta(name: str) -> dict:
    """The bot's Bot Mode settings (title, color…) as Hermes Desktop stores them in profile.yaml."""
    import yaml
    from hermes_cli.profiles import get_profile_dir
    path = get_profile_dir(name) / "profile.yaml"
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        data = {}
    meta = (data.get("ui_meta") or {}).get("hermes-bots") if isinstance(data, dict) else None
    return dict(meta) if isinstance(meta, dict) else {}


def rename_bot(name: str, title: str) -> dict:
    """Change the name a bot goes by, as Hermes Desktop does. Its profile id (what other bots and the
    CLI call it) stays, so nothing that refers to it breaks."""
    if name not in {b["name"] for b in list_bots()}:
        raise HermesRefused("That bot isn't on this server any more.")
    _rpc("profiles.configure", {"name": name, "ui_meta": {"hermes-bots": {**_bot_meta(name), "title": title}}})
    from hermes_cli.profiles import get_profile_dir
    return _bot_row(name, get_profile_dir(name))


def delete_bot(name: str) -> None:
    """Delete a bot's profile, with its memory, skills and sessions, as `hermes profile delete` does."""
    if name not in {b["name"] for b in list_bots()}:
        raise HermesRefused("That bot isn't on this server any more.")
    from hermes_cli.profiles import delete_profile
    try:
        delete_profile(name, yes=True)
    except (ValueError, FileNotFoundError) as exc:
        raise HermesRefused(str(exc)) from exc
