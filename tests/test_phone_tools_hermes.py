"""Exercise real pinned Hermes session context and registry; never call native reads."""
import asyncio
import json
from types import SimpleNamespace
import pytest
from plugin import phone_tools_hermes as tools
from plugin.phone_tools import PhoneTools
from plugin.hub import Hub
from plugin.store import Store


def test_pinned_registry_discovery_is_uncached_per_phone(tmp_path,monkeypatch):
    from gateway.session_context import set_session_vars, clear_session_vars
    from tools.registry import ToolRegistry, _check_fn_cached
    from plugin import adapter
    registry=ToolRegistry()
    class Context:
        def register_tool(self,**kw): registry.register(**kw)
    tools.register(Context())
    store=Store(tmp_path/'tools.db')
    try:
        owner,_=store.add_device('Synthetic',platform='android')
        other,_=store.add_device('Other',platform='android')
        store.ensure_chat('general','General')
        hub=Hub(store)
        async def build(): return PhoneTools(hub)
        hub.phone_tools=asyncio.run(build())
        monkeypatch.setattr(adapter,'_ACTIVE',SimpleNamespace(_hub=hub,_loop=object()))
        monkeypatch.setattr(adapter,'profile_info',lambda:{'name':'hermes'})
        store._exec('INSERT INTO phone_tool_grants(device_id,tool,scope,mode,enabled,updated_at) VALUES(?,?,?,?,?,?)',(owner['id'],'phone_status','','ask',1,0))
        for device,expected in [(owner,True),(other,False),(owner,True)]:
            token=set_session_vars(platform='winglet',chat_id='general',user_id='winglet:'+device['id'])
            try:
                assert _check_fn_cached(registry.get_entry('phone_status').check_fn) is expected
                assert _check_fn_cached(registry.get_entry('phone_location').check_fn) is False
            finally: clear_session_vars(token)
        token=set_session_vars(platform='telegram',chat_id='general',user_id='winglet:'+owner['id'])
        try: assert tools.binding() is None
        finally: clear_session_vars(token)
        assert set(registry.get_tool_names_for_toolset('phone_tools'))==set(tools_name for tools_name in ('phone_status','phone_shared_note','phone_location','phone_contacts','phone_calendar'))
        assert registry.get_schema('phone_contacts')['parameters']['additionalProperties'] is False
        assert 'error' in json.loads(registry.dispatch('phone_status',{}))
    finally: store.close()


async def test_real_context_dispatch_reaches_exact_gateway_loop(tmp_path,monkeypatch):
    from gateway.session_context import set_session_vars, clear_session_vars
    from tools.registry import ToolRegistry
    from plugin import adapter
    store=Store(tmp_path/'dispatch.db')
    device,_=store.add_device('Synthetic',platform='android')
    store.ensure_chat('general','General')
    hub=Hub(store);hub.phone_tools=PhoneTools(hub)
    active=SimpleNamespace(_hub=hub,_loop=asyncio.get_running_loop())
    monkeypatch.setattr(adapter,'_ACTIVE',active)
    monkeypatch.setattr(adapter,'profile_info',lambda:{'name':'hermes'})
    registry=ToolRegistry()
    class Context:
        def register_tool(self,**kw): registry.register(**kw)
    tools.register(Context())
    token=set_session_vars(platform='winglet',chat_id='general',user_id='winglet:'+device['id'])
    try:
        # No grant: exact real registry handler -> thread -> gateway loop -> refusal.
        answer=await asyncio.to_thread(registry.dispatch,'phone_status',{})
        assert json.loads(answer)=={'error':'revoked'}
        wrong=await asyncio.to_thread(registry.dispatch,'phone_status',{'device_id':'other'})
        assert 'error' in json.loads(wrong)
    finally:
        clear_session_vars(token);store.close()


async def test_pinned_stop_interrupt_cancels_waiting_phone_request(tmp_path,monkeypatch):
    from gateway.session_context import set_session_vars, clear_session_vars
    from plugin import adapter
    store=Store(tmp_path/'stop.db')
    d,_=store.add_device('Synthetic',platform='android');store.ensure_chat('general','General')
    hub=Hub(store);hub.phone_tools=bridge=PhoneTools(hub)
    class Socket:
        closed=False
        events=[]
        async def send_json(self,event):self.events.append(event)
    socket=Socket();hub._sockets[socket]={'device':d,'bot':None,'phone_ready':True,'phone_unlocked':True,'visible':True}
    await bridge.update(d,'',{'tool':'phone_status','enabled':True})
    monkeypatch.setattr(adapter,'_ACTIVE',SimpleNamespace(_hub=hub,_loop=asyncio.get_running_loop()))
    monkeypatch.setattr(adapter,'profile_info',lambda:{'name':'hermes'})
    agent=SimpleNamespace(is_interrupted=False)
    token=set_session_vars(platform='winglet',chat_id='general',user_id='winglet:'+d['id'])
    try:
        task=asyncio.create_task(asyncio.to_thread(tools.invoke,'phone_status',{},parent_agent=agent))
        for _ in range(100):
            if bridge.pending:break
            await asyncio.sleep(.01)
        assert bridge.pending
        agent.is_interrupted=True
        assert json.loads(await asyncio.wait_for(task,1))=={'error':'cancelled'}
        await asyncio.sleep(.01)
        assert not bridge.pending
        assert any(e['type']=='phone_tool.cancel' for e in socket.events)
    finally:clear_session_vars(token);store.close()
