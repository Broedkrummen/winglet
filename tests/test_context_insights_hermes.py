"""Real pinned context accounting, stores, manual command and turn lease; no provider."""
import contextlib
from types import SimpleNamespace
from datetime import datetime,timezone
import pytest

pytest.importorskip('gateway.session')
from gateway.config import GatewayConfig
from gateway.session import SessionStore,AsyncSessionStore
from gateway.platforms.base import Platform,SessionSource
from gateway.turn_lease import SessionTurnLeaseRegistry
from gateway.slash_commands_status import GatewayStatusCommandsMixin
from gateway.slash_commands_session import GatewaySessionCommandsMixin
from hermes_state import SessionDB
from plugin.hub import Hub
from plugin.store import Store
from plugin.context_insights_hermes import ContextBridge
from plugin.branching import BranchRefused


@pytest.fixture
def real(tmp_path,monkeypatch):
    home=tmp_path/'home';home.mkdir()
    monkeypatch.setenv('HERMES_HOME',str(home));monkeypatch.setenv('HERMES_DISABLE_LAZY_INSTALLS','1')
    db=SessionDB(tmp_path/'state.db')
    db.create_session('current',source='telegram',model='sample-model')
    db.append_message('current','user','Do not return this private prompt',platform_message_id='user1')
    db.append_message('current','assistant','A short answer')
    sessions=SessionStore(sessions_dir=tmp_path/'sessions',config=GatewayConfig());sessions._db=db
    key='agent:main:telegram:dm:general'
    source=SessionSource(platform=Platform.TELEGRAM,chat_id='general',chat_type='dm',user_id='fixture')
    entry=sessions.get_or_create_session(source);entry.session_id='current';sessions._save()
    class Runner(GatewayStatusCommandsMixin,GatewaySessionCommandsMixin):
        def __init__(self):
            self.session_store=sessions;self.async_session_store=AsyncSessionStore(sessions)
            self.config=SimpleNamespace(multiplex_profiles=False);self._turn_leases=SessionTurnLeaseRegistry()
            self.agent=None
        def _resident_agent_for(self,key):return self.agent
        def _is_session_running(self,key):return False
        @contextlib.asynccontextmanager
        async def _async_profile_scope_for_source(self,source):yield
    runner=Runner()
    winglet=Store(tmp_path/'winglet.db');hub=Hub(winglet,web_root=tmp_path/'web')
    hub.store.ensure_chat('general','Context')
    owner,_=winglet.add_device('Owner','test',role='owner',verified=True)
    class Adapter:
        gateway_runner=runner
        _hub=hub
        def _session_key(self,chat):return key
        def _chat_model(self,chat):return {'model':'sample-model','provider':'fixture'}
        def build_source(self,**kwargs):return source
    bridge=ContextBridge(Adapter())
    try:yield bridge,runner,db,hub,owner,hub.store.get_chat('general'),monkeypatch
    finally:db.close();winglet.close()


async def test_real_transcript_estimate_preserves_unknown_window_and_private_text(real):
    bridge,runner,db,hub,owner,chat,_=real
    value=await bridge.inspect(chat,owner)
    assert value['context']['used']>0 and value['context']['window'] is None
    assert value['context']['source']=='local_estimate'
    assert value['usage']['cost']['source']=='unavailable'
    assert 'private prompt' not in str(value)
    assert bridge.capabilities()['context_compression']


async def test_real_manual_compress_with_short_history_reports_unchanged_and_releases_lease(real):
    bridge,runner,db,hub,owner,chat,_=real
    initial=await bridge.inspect(chat,owner)
    result=await bridge.compress(chat,owner,initial['revision'],lambda:None)
    assert result['status']=='unchanged' and result['changed'] is False
    assert result['previous_revision']==result['revision']
    assert len(db.get_messages('current'))==2
    token=await runner._turn_leases.acquire('current',owner_key='another-turn',generation=2,timeout=.1)
    assert token is not None and runner._turn_leases.release(token)


async def test_real_context_breakdown_has_numeric_categories_not_prompt_or_tools(real):
    bridge,runner,db,hub,owner,chat,monkeypatch=real
    from agent import system_prompt
    monkeypatch.setattr(system_prompt,'build_system_prompt_parts',lambda agent:{'stable':'Private system content','volatile':'','context':''})
    comp=SimpleNamespace(context_length=8192,last_prompt_tokens=123,compression_count=0)
    runner.agent=SimpleNamespace(model='sample-model',context_compressor=comp,tools=[],_usage_anchor=None,_turn_base_usage_anchor=None)
    value=await bridge.inspect(chat,owner)
    assert value['context']['window']==8192
    assert value['context']['used']==123
    assert value['context']['categories'] and all('tokens' in c for c in value['context']['categories'])
    assert 'Private system content' not in str(value)


async def test_model_switch_without_new_messages_invalidates_compression_preview(real):
    bridge,runner,db,hub,owner,chat,monkeypatch=real
    selected={'model':'first','provider':'fixture','base_url':'https://fixture.invalid'}
    monkeypatch.setattr(runner,'_resolve_session_agent_runtime',lambda **kwargs:(selected['model'],selected),raising=False)
    async def route(*args):return SimpleNamespace(model=selected['model'],context_length=8192,context_source='config')
    monkeypatch.setattr(runner,'_resolve_route_context',route)
    first=await bridge.inspect(chat,owner)
    selected['model']='second'
    second=await bridge.inspect(chat,owner)
    assert first['revision']!=second['revision']
    assert first['model']=='first' and second['model']=='second'
    with pytest.raises(BranchRefused) as error:
        await bridge.compress(chat,owner,first['revision'],lambda:None)
    assert error.value.code=='stale'
    assert len(db.get_messages('current'))==2


async def test_normalized_account_response_never_serializes_provider_raw_credentials(real):
    bridge,runner,db,hub,owner,chat,monkeypatch=real
    from agent import account_usage
    now=datetime.now(timezone.utc)
    snapshot=account_usage.AccountUsageSnapshot(provider='openrouter',source='credits_api',fetched_at=now,
        windows=(account_usage.AccountUsageWindow(label='API key quota',used_percent=25),),
        details=('Credits balance: $12.50',),raw={'secret':'SHOULD_NEVER_REACH_CLIENT'})
    monkeypatch.setattr(account_usage,'fetch_account_usage',lambda *args,**kwargs:snapshot)
    result=await bridge.account(('private-route','openrouter',{'api_key':'sk-private-fixture'},None))
    assert result['available'] and result['kind']=='credits'
    assert result['windows'][0]['used_percent']==25
    assert 'SHOULD_NEVER_REACH_CLIENT' not in str(result) and 'sk-private-fixture' not in str(result)
