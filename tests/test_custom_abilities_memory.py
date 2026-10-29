import asyncio
import contextlib
import json
import sys
from types import ModuleType, SimpleNamespace

import pytest

from plugin import hermes_api as h
from plugin.ability_inputs import tool_module
from test_abilities import client, hub, store
from test_trust import pair_phone, post_signed, seal


MODULE = '''
def echo(args): return args
def register(ctx):
    ctx.register_tool(name="echo", toolset="echo", schema={"name": "echo"}, handler=echo)
'''


def test_python_upload_validates_without_executing(tmp_path):
    code = f"open({str(tmp_path / 'executed')!r}, 'w').write('bad')\n" + MODULE
    assert tool_module('my-tool', code)['provides_tools'] == ['echo']
    assert not (tmp_path / 'executed').exists()
    for name, content in [('../escape', MODULE), ('ok', 'def broken('), ('ok', 'print(1)'),
                          ('ok', MODULE.replace('name="echo"', 'name=variable')), ('ok', '\ud800')]:
        with pytest.raises(ValueError):
            tool_module(name, content)


@pytest.fixture
def native_memory(monkeypatch):
    monkeypatch.setattr(h, '_profile_scope', contextlib.nullcontext)
    pending = {'deadbeef': {'id': 'deadbeef', 'summary': 'Add fact', 'payload': {'action': 'add', 'target': 'user', 'content': 'Synthetic fact'}}}
    calls = []
    wa = SimpleNamespace(list_pending=lambda _: list(pending.values()), get_pending=lambda _, key: pending.get(key),
                         discard_pending=lambda _, key: pending.pop(key, None) is not None)
    tools = ModuleType('tools'); tools.write_approval = wa
    memory = ModuleType('tools.memory_tool')
    memory.load_on_disk_store = lambda: 'store'
    memory.apply_memory_pending = lambda payload, store: calls.append((payload, store)) or {'success': True}
    monkeypatch.setitem(sys.modules, 'tools', tools)
    monkeypatch.setitem(sys.modules, 'tools.memory_tool', memory)
    return pending, calls, memory


def test_pending_memory_uses_stored_payload_and_keeps_refused_proposal(native_memory):
    pending, calls, memory = native_memory
    memory.apply_memory_pending = lambda *_: {'success': False, 'error': 'Entry changed; review again'}
    with pytest.raises(h.HermesRefused, match='Entry changed'):
        h.review_memory('deadbeef', 'approve')
    assert 'deadbeef' in pending
    memory.apply_memory_pending = lambda payload, store: calls.append((payload, store)) or {'success': True}
    h.review_memory('deadbeef', 'approve')
    assert calls == [({'action': 'add', 'target': 'user', 'content': 'Synthetic fact'}, 'store')]
    assert not pending
    with pytest.raises(h.HermesRefused, match='already handled'):
        h.review_memory('deadbeef', 'approve')


def test_reject_and_invalid_pending_ids_never_apply(native_memory):
    pending, calls, _ = native_memory
    for key in ('../../memory', '/absolute', 'longdeadbeef'):
        with pytest.raises(h.HermesRefused): h.review_memory(key, 'approve')
    assert pending and not calls
    h.review_memory('deadbeef', 'reject')
    assert not pending and not calls


async def test_provider_status_is_scoped_and_allowlisted(monkeypatch, native_memory):
    seen = []
    async def status(profile=None):
        seen.append(profile)
        return {'active': 'synthetic', 'builtin_files': {'path': '/private'}, 'providers': [
            {'name': 'synthetic', 'status': 'ready', 'available': True, 'configured': True, 'setup': {'secret': 'DO_NOT_EXPOSE'}}]}
    monkeypatch.setattr(h, '_router', lambda _: SimpleNamespace(get_memory_status=status))
    token = h.set_bot('second-bot')
    try: result = await h.memory_status()
    finally: h.reset_bot(token)
    assert seen == ['second-bot'] and result['profile'] == 'second-bot'
    assert 'DO_NOT_EXPOSE' not in json.dumps(result) and '/private' not in json.dumps(result)


async def test_custom_preview_is_single_use_and_bound_to_device_and_profile(monkeypatch):
    monkeypatch.setattr(h, '_prepare_custom_tool', lambda *_: ({'code': MODULE}, {'name': 'echo', 'content': MODULE}))
    calls = []
    monkeypatch.setattr(h, '_apply_custom_tool', lambda *args: calls.append(args) or {'ok': True})
    h._ability_previews.clear()
    preview = await h.prepare_custom_ability('tool_python', {}, 'owner')
    for device in ('another-device',):
        with pytest.raises(h.HermesRefused): await h.apply_custom_ability(preview['token'], device, True, True)
    token = h.set_bot('other')
    try:
        with pytest.raises(h.HermesRefused): await h.apply_custom_ability(preview['token'], 'owner', True, True)
    finally: h.reset_bot(token)
    await h.apply_custom_ability(preview['token'], 'owner', False, False)
    assert calls[0][-2:] == (False, False)
    with pytest.raises(h.HermesRefused): await h.apply_custom_ability(preview['token'], 'owner', True, True)
    assert len(calls) == 1


async def test_routes_require_signed_owner_and_sealed_mcp(client, hub):
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, 'Member', role='member')
    for path in ('/api/abilities/preview', '/api/abilities/add', '/api/mcp/custom', '/api/memory/review'):
        assert (await client.post(path, json={}, headers=owner.auth)).status == 403
        assert (await post_signed(client, member, path, {})).status == 403
    assert (await client.get('/api/memory/status', headers=member.auth)).status == 403
    assert (await post_signed(client, owner, '/api/mcp/custom', {'env': {'KEY': 'SECRET'}})).status == 400
    received = []
    async def add(data): received.append(data); return {'ok': True}
    hub.hermes.add_custom_mcp = add
    info = await (await client.get('/api/server-key')).json()
    config = {'name': 'custom', 'command': 'server', 'env': {'TOKEN': 'SECRET_VALUE'}}
    body = {'sealed': seal(info, 'mcp-custom', config, owner.id)}
    response = await post_signed(client, owner, '/api/mcp/custom', body)
    assert response.status == 200 and received == [config]
    assert 'SECRET_VALUE' not in json.dumps(hub.store.list_audit())
    assert hub.mcp_changed


async def test_custom_mcp_never_accepts_a_caller_profile(monkeypatch):
    monkeypatch.setattr(h, '_profile_scope', contextlib.nullcontext)
    calls = []
    async def add(body, profile=None): calls.append((body, profile))
    monkeypatch.setattr(h, '_router', lambda _: SimpleNamespace(add_mcp_server=add))
    monkeypatch.setattr(h, '_models', lambda: SimpleNamespace(MCPServerCreate=lambda **kw: kw))
    token = h.set_bot('selected')
    try: await h.add_custom_mcp({'name': 'custom', 'url': 'https://example.com/mcp', 'profile': 'escape'})
    finally: h.reset_bot(token)
    assert calls == [({'name': 'custom', 'url': 'https://example.com/mcp'}, 'selected')]


def test_repository_install_keeps_reviewed_commit_and_explicit_consent(monkeypatch):
    monkeypatch.setattr(h, '_profile_scope', contextlib.nullcontext)
    calls = []
    pc = SimpleNamespace(dashboard_install_plugin=lambda *args, **kwargs: calls.append((args, kwargs)) or {'ok': True})
    hermes = ModuleType('hermes_cli'); hermes.plugins_cmd = pc
    monkeypatch.setitem(sys.modules, 'hermes_cli', hermes)
    h._apply_custom_tool('tool_repository', {'identifier': 'owner/repo', 'ref': 'a' * 40}, False, False)
    assert calls == [(('owner/repo',), {'force': False, 'enable': False, 'ref': 'a' * 40, 'assume_deps_consent': False})]
    pc.dashboard_install_plugin = lambda *_args, **_kw: {'ok': False, 'error': 'Scan refused'}
    with pytest.raises(h.HermesRefused, match='Scan refused'):
        h._apply_custom_tool('tool_repository', {'identifier': 'owner/repo', 'ref': 'a' * 40}, True, True)


def test_raw_tool_publishes_with_absence_check_before_enable(tmp_path, monkeypatch):
    monkeypatch.setattr(h, '_profile_scope', contextlib.nullcontext)
    calls = []
    pc = SimpleNamespace(_plugins_dir=lambda: tmp_path, _sanitize_plugin_name=lambda name, root: root / name,
                         _find_plugin_entry=lambda _: None, _scan_plugin_tree=lambda *args, **kw: calls.append('scan'),
                         _read_install_metadata=lambda: {},
                         dashboard_set_agent_plugin_enabled=lambda *args, **kwargs: calls.append(('enable', kwargs)) or {'ok': True})
    hermes = ModuleType('hermes_cli'); hermes.plugins_cmd = pc
    monkeypatch.setitem(sys.modules, 'hermes_cli', hermes)
    pm = ModuleType('pm'); client = ModuleType('pm.client'); inputs = ModuleType('pm.plugin_inputs')
    inputs.StagedUpdate = lambda data: data
    def publish(*, explicit, plugins):
        from pathlib import Path
        assert explicit and plugins['target_digest'] is None
        assert Path(plugins['staged'], '__init__.py').read_text() == MODULE
        assert not (tmp_path / 'tool').exists()
        calls.append('publish')
    client.sync_venv = publish
    for name, module in [('pm', pm), ('pm.client', client), ('pm.plugin_inputs', inputs)]: monkeypatch.setitem(sys.modules, name, module)
    h._apply_custom_tool('tool_python', {'name': 'tool', 'content': MODULE}, False, True)
    assert calls == ['scan', 'publish', ('enable', {'enabled': True})]
    (tmp_path / 'tool').mkdir()
    with pytest.raises(h.HermesRefused, match='already installed'):
        h._apply_custom_tool('tool_python', {'name': 'tool', 'content': MODULE}, False, True)
    assert len(calls) == 3


async def test_memory_review_route_ignores_forged_payload_and_keeps_audit_content_free(client, hub):
    owner = await pair_phone(client, hub)
    received = []
    hub.hermes.review_memory = lambda *args: received.append(args) or {'ok': True}
    response = await post_signed(client, owner, '/api/memory/review',
                                 {'id': 'deadbeef', 'decision': 'approve', 'payload': {'content': 'FORGED_SECRET'}})
    assert response.status == 200 and received == [('deadbeef', 'approve')]
    assert 'FORGED_SECRET' not in json.dumps(hub.store.list_audit())


async def test_refused_custom_install_finishes_job_with_hermes_reason(client, hub):
    owner = await pair_phone(client, hub)
    def refuse(*_): raise hub.hermes.HermesRefused('That plugin name is already installed.')
    hub.hermes.apply_custom_ability = refuse
    response = await post_signed(client, owner, '/api/abilities/add', {'token': 't', 'consent': True})
    assert response.status == 202
    job_id = (await response.json())['job']['id']
    for _ in range(100):
        job = hub.store.get_job(job_id)
        if job['state'] != 'running':
            break
        await asyncio.sleep(0.01)
    assert job['state'] == 'failed'
    assert 'already installed' in job['detail']['message']
    # A failed install must not leave a job that blocks the next one.
    assert hub._busy_job() is None
