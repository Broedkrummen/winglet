import asyncio
import json
from types import SimpleNamespace
import pytest
from plugin.branching import BranchRefused
from plugin.context_insights import ContextInsights
from plugin.context_insights_hermes import number
from plugin.hub import Hub, MessageRejected, ROUTE_POLICY
from plugin.store import Store
from test_trust import pair_phone


class Bridge:
    def __init__(self):
        self.calls=0;self.account_calls=0;self.revision='reviewed-revision';self.wait=asyncio.Event();self.account_wait=None;self.identity='route';self.fail=False
    def capabilities(self):return {k:True for k in ('session_context','context_compression','usage_insights','provider_limits')}
    async def inspect(self,chat,device):
        return {'chat_id':chat['id'],'revision':self.revision,'busy':False,'context':{'used':100,'window':None}}
    async def compress(self,chat,device,expected,check):
        self.calls+=1
        await self.wait.wait();check()
        if self.fail:raise RuntimeError('provider returned a partial failure')
        self.revision='compressed-revision'
        return {'status':'completed','revision':self.revision,'outcome':'Compressed by fixture'}
    async def account_route(self,chat,device):return (self.identity,'fixture',{},None)
    async def account(self,route):
        self.account_calls+=1
        if self.account_wait is not None:await self.account_wait.wait()
        return {'available':True,'windows':[{'label':'Window','used_percent':10}],'details':[]}


@pytest.fixture
def env(tmp_path):
    store=Store(tmp_path/'winglet.db');hub=Hub(store,web_root=tmp_path/'web')
    owner,_=store.add_device('Owner','test',role='owner',verified=True)
    other,_=store.add_device('Second owner','test',role='owner',verified=True)
    member,_=store.add_device('Member','test',role='member',verified=True)
    chat=store.create_chat('Context test',owner_device=owner['id'])
    locks={}
    hub.branching=SimpleNamespace(_lock=lambda key:locks.setdefault(key,asyncio.Lock()),busy=lambda key:locks.setdefault(key,asyncio.Lock()).locked())
    bridge=Bridge();service=hub.context_insights=ContextInsights(hub,None,bridge)
    yield service,hub,bridge,owner,other,member,chat
    store.close()


def request(operation='context-test-operation-123',revision='reviewed-revision'):return {'operation_id':operation,'revision':revision}


async def settle(service,device,chat,op):
    for _ in range(100):
        value=service.operation(device,chat,op)
        if value['status']!='running':return value
        await asyncio.sleep(.01)
    raise AssertionError('Operation did not settle')


async def test_compression_receipt_is_accepted_then_authoritative_and_never_reexecuted(env):
    service,hub,bridge,owner,_,_,chat=env
    body=request()
    assert (await service.start(owner,chat,body))['status']=='running'
    assert service.busy(chat['id'])
    with pytest.raises(MessageRejected):await hub.user_message(owner,chat['id'],'new text')
    with pytest.raises(BranchRefused):await service.start(owner,chat,request('context-second-operation-123'))
    assert (await service.start(owner,chat,body))['status']=='running'
    bridge.wait.set()
    result=await settle(service,owner,chat,body['operation_id'])
    assert result['status']=='completed' and result['revision']=='compressed-revision'
    assert (await service.start(owner,chat,body))['status']=='completed'
    restarted=ContextInsights(hub,None,bridge)
    assert (await restarted.start(owner,chat,body))['status']=='completed'
    assert bridge.calls==1
    assert not hub.store.all_messages(chat['id'])


async def test_revision_busy_identity_and_authorization_fail_closed(env):
    service,hub,bridge,owner,other,member,chat=env
    for action in (lambda:service.inspect(member,chat),lambda:service.start(member,chat,request())):
        with pytest.raises(BranchRefused) as error:await action()
        assert error.value.status==403
    with pytest.raises(BranchRefused):await service.start(owner,chat,request(revision='stale'))
    await service.start(owner,chat,request())
    with pytest.raises(BranchRefused):await service.start(other,chat,request())
    with pytest.raises(BranchRefused):service.operation(other,chat,request()['operation_id'])
    hub.store.update_device(owner['id'],role='member')
    bridge.wait.set()
    await asyncio.sleep(.03)
    with pytest.raises(BranchRefused):service.operation(owner,chat,request()['operation_id'])
    with service.db() as db:row=db.execute('SELECT state FROM winglet_context_ops').fetchone()
    assert row['state']=='refused'


async def test_failed_provider_is_unknown_and_retry_is_observation_only(env):
    service,_,bridge,owner,_,_,chat=env
    bridge.fail=True;bridge.wait.set()
    await service.start(owner,chat,request())
    result=await settle(service,owner,chat,request()['operation_id'])
    assert result['status']=='unknown'
    assert (await service.start(owner,chat,request()))['status']=='unknown'
    assert bridge.calls==1


async def test_restart_marks_unfinished_receipt_unknown_without_replay(env):
    service,hub,bridge,owner,_,_,chat=env
    body=request()
    with service.db() as db:db.execute('INSERT INTO winglet_context_ops VALUES(?,?,?,?,?,?,?)',(body['operation_id'],owner['id'],chat['id'],body['revision'],'running','{}',1))
    restarted=ContextInsights(hub,None,bridge)
    assert (await restarted.start(owner,chat,body))['status']=='unknown'
    assert bridge.calls==0


async def test_account_reads_are_singleflight_cached_and_route_bound(env):
    service,_,bridge,owner,_,member,chat=env
    bridge.account_wait=asyncio.Event()
    first=asyncio.create_task(service.limits(owner,chat));second=asyncio.create_task(service.limits(owner,chat))
    await asyncio.sleep(.02);bridge.account_wait.set()
    assert all(result['available'] for result in await asyncio.gather(first,second))
    assert (await service.limits(owner,chat))['cached']
    assert bridge.account_calls==1
    with pytest.raises(BranchRefused):await service.limits(member,chat)
    bridge.identity='other-account'
    await service.limits(owner,chat)
    assert bridge.account_calls==2


async def test_provider_switch_during_fetch_discards_old_account_result(env):
    service,_,bridge,owner,_,_,chat=env
    bridge.account_wait=asyncio.Event()
    pending=asyncio.create_task(service.limits(owner,chat))
    await asyncio.sleep(.02);bridge.identity='new-route';bridge.account_wait.set()
    with pytest.raises(BranchRefused) as error:await pending
    assert error.value.code=='stale'


async def test_account_route_revalidation_cannot_return_data_after_demotion(env):
    service,hub,bridge,owner,_,_,chat=env
    calls=0
    original=bridge.account_route
    async def route(chat,device):
        nonlocal calls
        calls+=1
        result=await original(chat,device)
        if calls==2:hub.store.update_device(owner['id'],role='member')
        return result
    bridge.account_route=route
    with pytest.raises(BranchRefused) as error:await service.limits(owner,chat)
    assert error.value.status==403


async def test_failed_accounts_keep_the_same_cache_bound_as_successes(env):
    service,_,bridge,owner,_,_,chat=env
    async def failed(route):raise RuntimeError('fixture provider failure')
    bridge.account=failed
    for index in range(70):
        bridge.identity=f'account-{index}'
        assert not (await service.limits(owner,chat))['available']
    assert len(service.cache)==64


async def test_context_routes_require_owner_signature_and_bot_scope(aiohttp_client,tmp_path):
    store=Store(tmp_path/'db.sqlite');hub=Hub(store,web_root=tmp_path/'web')
    locks={};hub.branching=SimpleNamespace(_lock=lambda key:locks.setdefault(key,asyncio.Lock()),busy=lambda key:locks.setdefault(key,asyncio.Lock()).locked())
    bridge=Bridge();bridge.wait.set();hub.context_insights=ContextInsights(hub,None,bridge)
    client=await aiohttp_client(hub.build_app())
    phone=await pair_phone(client,hub)
    chat=store.create_chat('Scoped')
    path=f"/api/context/chats/{chat['id']}"
    assert (await client.get(path)).status==401
    assert (await client.get(path,headers=phone.auth)).status==200
    assert (await client.get(path+'?bot=unserved',headers=phone.auth)).status in (404,409)
    body=json.dumps(request()).encode()
    assert (await client.post(path+'/compress',headers=phone.auth,data=body)).status==403
    signed=phone.signed('POST',path+'/compress',body)
    response=await client.post(path+'/compress',headers={**signed,'Content-Type':'application/json'},data=body)
    assert response.status==202,await response.text()
    await settle(hub.context_insights,store.get_device(phone.id),chat,request()['operation_id'])
    store.add_device('Other owner','test',role='owner',verified=True)
    store.update_device(phone.id,role='member')
    assert (await client.get(path,headers=phone.auth)).status==403
    await client.close();store.close()


def test_unknown_numbers_are_never_zero_or_nonfinite():
    for value in (None,True,False,-1,float('nan'),float('inf'),'100'):assert number(value) is None
    assert number(0)==0 and number(15)==15
    assert ROUTE_POLICY['h_context_compress']=='owner_signed'
