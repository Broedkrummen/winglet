import copy
import json
import threading
from types import SimpleNamespace

import pytest
import yaml
from plugin import advanced_config as ac


class Config:
    DEFAULT_CONFIG = {"agent": {"max_turns": 90}, "compression": {"enabled": True, "threshold": .5, "target_ratio": .2, "protect_last_n": 20}}
    def __init__(self, path):
        self.path = path
        self.writes = 0
        self.locked = set()
        self.managed_scope = SimpleNamespace(is_key_managed=lambda key: key in self.locked)
        self.fail = False
    def get_config_path(self): return self.path
    def get_managed_system(self): return None
    def require_readable_config_before_write(self, path): return yaml.safe_load(path.read_text()) or {}
    def load_config(self):
        data = copy.deepcopy(self.DEFAULT_CONFIG)
        raw = self.require_readable_config_before_write(self.path)
        for key in ac.FIELDS:
            value = ac.get(raw, key)
            if value is not None: ac.put(data, key, value)
        return data
    def validate_config_structure(self, data): return []
    def atomic_config_replace(self, path, data):
        if self.fail: raise OSError("disk failure")
        path.write_text(yaml.safe_dump(data)); self.writes += 1


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    path = tmp_path / 'config.yaml'
    path.write_text('agent:\n  max_turns: 30\ncustom:\n  api_key: DO_NOT_EXPOSE\n')
    cfg = Config(path)
    monkeypatch.setattr(ac, 'dependencies', lambda: (cfg, {k: {} for k in ac.FIELDS}, threading.RLock()))
    return cfg


def request(**changes):
    return {'revision': ac.operate()['revision'], 'changes': changes}


def test_catalog_never_exposes_arbitrary_or_secret_fields(cfg):
    data = ac.operate()
    assert 'DO_NOT_EXPOSE' not in json.dumps(data)
    assert {f['key'] for f in data['fields']} <= set(ac.FIELDS)
    assert next(f for f in data['fields'] if f['key'] == 'agent.max_turns')['source'] == 'override'


@pytest.mark.parametrize('key,value', [('model.api_key', 'secret'), ('agent.max_turns', True), ('agent.max_turns', 1.5),
    ('compression.threshold', float('nan')), ('compression.threshold', float('inf')),
    ('compression.enabled', 1), ('compression.protect_last_n', 201), ('compression.threshold', .01)])
def test_unsafe_values_refused_without_partial_write(cfg, key, value):
    original = cfg.path.read_bytes()
    with pytest.raises(ac.ConfigRefused): ac.operate(request(**{key: value}), apply=True)
    assert cfg.writes == 0 and cfg.path.read_bytes() == original


def test_preview_apply_and_reset_preserve_unknown_fields(cfg):
    body = request(**{'agent.max_turns': 40, 'compression.enabled': False})
    preview = ac.operate(body)
    assert cfg.writes == 0 and len(preview['changes']) == 2
    result = ac.operate(body, apply=True)
    assert result['revision'] != body['revision']
    assert cfg.require_readable_config_before_write(cfg.path)['custom']['api_key'] == 'DO_NOT_EXPOSE'
    reset = ac.operate(request(**{'agent.max_turns': None}), apply=True)
    row = next(f for f in reset['fields'] if f['key'] == 'agent.max_turns')
    assert row['value'] == 90 and row['source'] == 'inherited'


def test_revision_conflict_cannot_repeat_mutation(cfg):
    body = request(**{'agent.max_turns': 40})
    ac.operate(body, apply=True)
    with pytest.raises(ac.ConfigRefused) as err: ac.operate(body, apply=True)
    assert err.value.status == 409 and cfg.writes == 1


def test_revocation_at_write_boundary_stops_change(cfg):
    body = request(**{'agent.max_turns': 40})
    calls = []
    def authorize():
        calls.append(1)
        if len(calls) == 2: raise ac.ConfigRefused('revoked', status=403)
    with pytest.raises(ac.ConfigRefused): ac.operate(body, apply=True, authorize=authorize)
    assert cfg.writes == 0


def test_external_edit_between_review_and_write_is_refused(cfg):
    body = request(**{'agent.max_turns': 40})
    calls = []
    def authorize():
        calls.append(1)
        if len(calls) == 2: cfg.path.write_text(cfg.path.read_text() + 'elsewhere: kept\n')
    with pytest.raises(ac.ConfigRefused) as err: ac.operate(body, apply=True, authorize=authorize)
    assert err.value.status == 409 and cfg.writes == 0
    assert 'elsewhere' in cfg.path.read_text()


def test_managed_settings_are_readonly_and_cannot_reset(cfg):
    cfg.locked.add('agent.max_turns')
    row = next(f for f in ac.operate()['fields'] if f['key'] == 'agent.max_turns')
    assert row['source'] == 'managed' and not row['writable']
    with pytest.raises(ac.ConfigRefused): ac.operate(request(**{'agent.max_turns': None}), apply=True)
    assert cfg.writes == 0


def test_write_failure_does_not_claim_success(cfg):
    cfg.fail = True
    before = cfg.path.read_bytes()
    with pytest.raises(OSError): ac.operate(request(**{'agent.max_turns': 40}), apply=True)
    assert cfg.path.read_bytes() == before


def test_two_bot_revisions_are_bound_to_the_actual_path(cfg, tmp_path):
    body = request(**{'agent.max_turns': 40})
    old = cfg.path
    cfg.path = tmp_path/'other-config.yaml'
    cfg.path.write_bytes(old.read_bytes())
    with pytest.raises(ac.ConfigRefused) as err: ac.operate(body, apply=True)
    assert err.value.status == 409 and cfg.writes == 0


def test_invalid_yaml_is_not_overwritten(cfg):
    cfg.path.write_text('agent: [\n')
    with pytest.raises(yaml.YAMLError): ac.operate()
    assert cfg.writes == 0


def test_real_pinned_hermes_preserves_comments_and_unknown_yaml(tmp_path):
    config = pytest.importorskip('hermes_cli.config')
    pytest.importorskip('hermes_cli.web_routers._common')
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(str(tmp_path))
    try:
        path = tmp_path/'config.yaml'
        path.write_text('# keep this comment\nagent:\n  max_turns: 30 # keep this too\ncustom_extension:\n  private_value: ORIGINAL\n')
        body = request(**{'agent.max_turns': 40})
        ac.operate(body, apply=True)
        content = path.read_text()
        assert '# keep this comment' in content and '# keep this too' in content
        assert 'ORIGINAL' in content and config.load_config()['agent']['max_turns'] == 40
        assert 'ORIGINAL' not in json.dumps(ac.operate())
    finally:
        reset_hermes_home_override(token)


async def test_signed_routes_refuse_members_unsigned_and_stale_revisions(cfg, aiohttp_client, tmp_path):
    from plugin.hub import Hub
    from plugin.store import Store
    from test_trust import pair_phone, post_signed
    store = Store(tmp_path/'routes.sqlite')
    hub = Hub(store, web_root=tmp_path/'web')
    hub.hermes = SimpleNamespace(
        HermesRefused=type('HermesRefused', (ValueError,), {}),
        HermesUnavailable=type('HermesUnavailable', (RuntimeError,), {}),
        advanced_config=ac.operate, config_available=lambda: True)
    client = await aiohttp_client(hub.build_app())
    try:
        owner = await pair_phone(client, hub)
        member = await pair_phone(client, hub, 'Member', role='member')
        assert (await client.get('/api/config/catalog', headers=member.auth)).status == 403
        catalog = await (await client.get('/api/config/catalog', headers=owner.auth)).json()
        body = {'revision':catalog['revision'], 'changes':{'agent.max_turns':40}}
        assert (await client.post('/api/config/apply', json=body, headers=owner.auth)).status == 403
        preview = await post_signed(client, owner, '/api/config/preview', body)
        assert preview.status == 200 and cfg.writes == 0
        result = await post_signed(client, owner, '/api/config/apply', body)
        assert result.status == 200 and cfg.writes == 1
        stale = await post_signed(client, owner, '/api/config/apply', body)
        assert stale.status == 409 and cfg.writes == 1
        data = await stale.json()
        assert 'elsewhere' in data['error']
        bad_bot = await client.get('/api/config/catalog?bot=missing', headers=owner.auth)
        assert bad_bot.status == 404
    finally:
        await client.close()
        store.close()


