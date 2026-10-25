"""Safe synthetic fixtures only; no native device or personal data."""
import asyncio
import json
import sqlite3
import time
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from plugin import keys
from plugin.hub import Hub, ROUTE_POLICY
from plugin.store import Store
from plugin.phone_tools import PhoneTools, CATALOG, arguments, result


class Socket:
    closed = False
    def __init__(self): self.events = asyncio.Queue()
    async def send_json(self, value): await self.events.put(value)
    async def close(self, **kw): self.closed = True


@pytest.fixture
async def env(tmp_path):
    store = Store(tmp_path / 'phone.db')
    device, token = store.add_device('Synthetic phone', platform='android')
    store.add_device('Backup owner', platform='android')
    store.ensure_chat('general','Fixture chat')
    hub = Hub(store,bot_info=lambda: {'name':'hermes','title':'Fixture bot'})
    hub.phone_tools = bridge = PhoneTools(hub,timeout=.3)
    ws = Socket()
    hub._sockets[ws] = {'device':device,'bot':None,'visible':True,'phone_ready':True,'phone_unlocked':True,'phone_instance':'fixture-instance-123456'}
    yield SimpleNamespace(store=store,device=device,token=token,hub=hub,bridge=bridge,ws=ws)
    for p in list(bridge.pending.values()): await bridge.finish(p,{'error':'cancelled'})
    store.close()


async def enable(e, tool='phone_status', mode='ask', scope='bot', bot=''):
    await e.bridge.update(e.device,bot,{'tool':tool,'mode':mode,'scope':scope,'enabled':True})
    while not e.ws.events.empty(): e.ws.events.get_nowait()


async def start(e,tool='phone_status',args=None,bot='',chat='general'):
    task=asyncio.create_task(e.bridge.request(e.device['id'],chat,bot,tool,args or {}))
    event=await asyncio.wait_for(e.ws.events.get(),1)
    assert event['type']=='phone_tool.request'
    return task,event['request']


async def decision(e,r,allow=True,**extra):
    await e.bridge.event(e.ws,e.device,'',{'type':'phone_tool.decision','id':r['id'],'nonce':r['nonce'],'allow':allow,**extra})


async def answer(e,r,data,**extra):
    await e.bridge.event(e.ws,e.device,'',{'type':'phone_tool.answer','id':r['id'],'nonce':r['nonce'],'ok':True,'result':data,**extra})


STATUS={'battery':42,'charging':False,'network':'wifi','metered':False,'dnd':False,'model':'Fixture','android':'16'}


async def test_off_by_default_and_no_broadcast(env):
    e=env
    assert await e.bridge.request(e.device['id'],'general','','phone_status',{})=={'error':'revoked'}
    await enable(e)
    other=Socket(); d,_=e.store.add_device('Other',platform='android')
    e.hub._sockets[other]={'device':d,'bot':None,'visible':True,'phone_ready':True,'phone_unlocked':True}
    task,r=await start(e)
    assert other.events.empty()
    await decision(e,r)
    assert (await e.ws.events.get())['type']=='phone_tool.execute'
    await answer(e,r,{**STATUS,'identifier':'never-forwarded'})
    assert await task=={'result':STATUS}
    raw=[dict(r) for r in e.store._all('SELECT * FROM phone_tool_events')]
    assert 'identifier' not in json.dumps(raw) and 'Fixture' not in json.dumps(raw)


@pytest.mark.parametrize('tool,args',[('phone_status',{}),('phone_shared_note',{}),('phone_location',{'precise':False}),('phone_contacts',{'query':'Synthetic'}),('phone_calendar',{'start_ms':1000,'end_ms':2000})])
async def test_each_tool_revoke_cancels_pending_and_rejects_late_result(env,tool,args):
    await enable(env,tool)
    task,r=await start(env,tool,args)
    await decision(env,r)
    await env.bridge.revoke(env.device['id'])
    assert await task=={'error':'revoked'}
    await answer(env,r,{'note':'late private payload'})
    assert not env.bridge.pending
    assert 'private payload' not in json.dumps([dict(r) for r in env.store._all('SELECT * FROM phone_tool_events')])


async def test_decision_nonce_and_single_settlement(env):
    e=env;await enable(e)
    task,r=await start(e)
    await answer(e,r,STATUS) # no decision: cannot fulfill
    await decision(e,r,nonce='0'*48)
    assert not task.done()
    alien=Socket();e.hub._sockets[alien]=e.hub._sockets[e.ws].copy()
    await e.bridge.event(alien,e.device,'',{'type':'phone_tool.decision',**r,'allow':True})
    await e.bridge.event(e.ws,e.device,'other',{'type':'phone_tool.decision',**r,'allow':True})
    assert e.ws.events.empty()
    await decision(e,r)
    assert (await e.ws.events.get())['type']=='phone_tool.execute'
    await decision(e,r) # replay: no second execute
    assert e.ws.events.empty()
    await answer(e,r,STATUS);assert await task=={'result':STATUS}
    await answer(e,r,STATUS)
    assert len([r for r in e.bridge.history(e.device['id'],'') if r['event']=='allowed'])==1


async def test_denial_never_executes_and_error_codes_do_not_log_payload(env):
    await enable(env)
    task,r=await start(env);await decision(env,r,False)
    assert await task=={'error':'denied'}
    events=[]
    while not env.ws.events.empty():events.append(env.ws.events.get_nowait())
    assert not any(e['type']=='phone_tool.execute' for e in events)
    task,r=await start(env);await decision(env,r);await env.ws.events.get()
    await env.bridge.event(env.ws,env.device,'',{'type':'phone_tool.answer',**r,'ok':False,'error':'secret location 12,34'})
    assert await task=={'error':'native_error'}


async def test_precise_always_asks_and_bounds_are_enforced(env):
    await enable(env,'phone_location',mode='while_open')
    task,r=await start(env,'phone_location',{'precise':True});assert r['ask'] is True
    await decision(env,r,False);await task
    assert result('phone_location',{'latitude':12.123456,'longitude':77.654321,'accuracy':2},{'precise':False})=={'latitude':12.12,'longitude':77.65,'accuracy':1500,'precise':False}
    for tool,args in [('phone_contacts',{'query':''}),('phone_calendar',{'start_ms':0,'end_ms':32*86400000}),('phone_status',{'command':'shell'}),('phone_shell',{})]:
        with pytest.raises(ValueError):arguments(tool,args)
    with pytest.raises(ValueError): result('phone_contacts',{'contacts':[{}]*6},{'query':'Synthetic'})
    with pytest.raises(ValueError): result('phone_calendar',{'events':[{}]*51},{'start_ms':1000,'end_ms':2000})
    with pytest.raises(ValueError): result('phone_location',{'latitude':float('nan'),'longitude':0,'accuracy':1},{})


@pytest.mark.parametrize('state',['offline','locked','background','role','unpair','socket','restart'])
async def test_lifecycle_and_authority_changes_fail_closed(env,state):
    e=env;await enable(e)
    task,r=await start(e)
    if state=='offline':e.ws.closed=True
    elif state=='locked':await e.bridge.event(e.ws,e.device,'',{'type':'phone_tools.hello','instance_id':'a'*32,'unlocked':False})
    elif state=='background':e.hub._sockets[e.ws]['visible']=False
    elif state=='role':e.store.update_device(e.device['id'],role='member')
    elif state=='unpair':e.store.remove_device(e.device['id'])
    elif state=='socket':await e.bridge.socket_closed(e.ws)
    elif state=='restart':
        await e.bridge.event(e.ws,e.device,'',{'type':'phone_tools.hello','instance_id':'a'*32,'unlocked':True})
        await e.bridge.event(e.ws,e.device,'',{'type':'phone_tools.hello','instance_id':'b'*32,'unlocked':True})
    await decision(e,r)
    assert 'error' in await task


async def test_expiry_and_concurrent_identity(env):
    e=env;await enable(e)
    tasks=[]
    for _ in range(4):tasks.append(await start(e))
    assert len({r['id'] for _,r in tasks})==4
    assert await e.bridge.request(e.device['id'],'general','','phone_status',{})=={'error':'busy'}
    assert all(value=={'error':'expired'} for value in await asyncio.gather(*(t for t,_ in tasks)))
    assert not e.bridge.pending
    assert await e.bridge.request('missing','general','','phone_status',{})=={'error':'scope'}
    assert await e.bridge.request(e.device['id'],'general','other','phone_status',{})=={'error':'scope'}


async def test_member_scope_and_other_device_chat_refused(env):
    e=env
    member,_=e.store.add_device('Member',platform='android',role='member')
    with pytest.raises(PermissionError):await e.bridge.update(member,'',{'tool':'phone_contacts','scope':'server','enabled':True})
    e.store.ensure_chat('private','Private',owner_device=e.device['id'])
    assert await e.bridge.request(member['id'],'private','','phone_status',{})=={'error':'scope'}
    await enable(e,scope='server')
    e.store.update_device(e.device['id'],role='member')
    assert await e.bridge.request(e.device['id'],'general','','phone_status',{})=={'error':'scope'}


async def test_same_app_instance_on_second_bot_does_not_cancel(env):
    e=env;await enable(e)
    await e.bridge.event(e.ws,e.device,'',{'type':'phone_tools.hello','instance_id':'a'*32,'unlocked':True})
    task,r=await start(e)
    other=Socket();e.hub._sockets[other]={'device':e.device,'bot':'other','visible':True}
    await e.bridge.event(other,e.device,'other',{'type':'phone_tools.hello','instance_id':'a'*32,'unlocked':True})
    assert r['id'] in e.bridge.pending
    await decision(e,r,False);await task


async def test_route_policy_signed_mutation_and_device_isolation(env,aiohttp_client):
    e=env;client=await aiohttp_client(e.hub.build_app())
    auth={'Authorization':'Bearer '+e.token}
    assert (await client.get('/api/phone-tools')).status==401
    assert (await client.put('/api/phone-tools',json={'tool':'phone_status','enabled':True},headers=auth)).status==403
    key=Ed25519PrivateKey.generate()
    public=keys.b64e(key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw))
    e.store._exec('UPDATE devices SET sign_key=?,verified=1 WHERE id=?',(public,e.device['id']))
    body=json.dumps({'tool':'phone_status','enabled':True}).encode()
    stamp=str(int(time.time()));nonce='fresh-nonce-'+('x'*20)
    sig=keys.b64e(key.sign(keys.signing_payload('PUT','/api/phone-tools',body,e.device['id'],stamp,nonce)))
    headers={**auth,'Content-Type':'application/json','X-Winglet-Device':e.device['id'],'X-Winglet-Time':stamp,'X-Winglet-Nonce':nonce,'X-Winglet-Signature':sig}
    assert (await client.put('/api/phone-tools',data=body,headers=headers)).status==200
    assert (await client.put('/api/phone-tools',data=body,headers=headers)).status==403
    other,token=e.store.add_device('Other',platform='android')
    data=await (await client.get('/api/phone-tools',headers={'Authorization':'Bearer '+token})).json()
    assert data['grants']==[] and data['history']==[]
    assert {'h_phone_tools','h_phone_tools_log','h_phone_tools_put','h_phone_tools_revoke'} <= ROUTE_POLICY.keys()


def test_restart_schema_idempotent_and_no_pending_cache(tmp_path):
    path=tmp_path/'legacy.db'
    db=sqlite3.connect(path);db.execute('CREATE TABLE phone_tool_grants(device_id TEXT NOT NULL,tool TEXT NOT NULL,scope TEXT NOT NULL DEFAULT "",mode TEXT NOT NULL DEFAULT "ask",enabled INTEGER NOT NULL DEFAULT 1,updated_at REAL NOT NULL,PRIMARY KEY(device_id,tool))');db.commit();db.close()
    for _ in range(2):
        s=Store(path)
        assert s._one('SELECT count(*) AS n FROM phone_tool_grants')['n']==0
        assert not s._one("SELECT name FROM sqlite_master WHERE name='phone_tool_results'")
        s.close()


@pytest.mark.parametrize('action',['all','tool'])
async def test_revoke_withdraws_authority_before_awaiting_socket_cancel(env,action):
    e=env;await enable(e)
    task,r=await start(e)
    reached=asyncio.Event();release=asyncio.Event()
    original=e.ws.send_json
    async def blocked(event):
        if event['type']=='phone_tool.cancel':
            reached.set();await release.wait()
        await original(event)
    e.ws.send_json=blocked
    revoke=asyncio.create_task(e.bridge.revoke(e.device['id']) if action=='all' else e.bridge.update(e.device,'',{'tool':'phone_status','enabled':False}))
    await asyncio.wait_for(reached.wait(),1)
    assert await e.bridge.request(e.device['id'],'general','','phone_status',{})=={'error':'revoked'}
    release.set();await revoke
    assert await task=={'error':'revoked'}


async def test_request_is_bound_to_the_exact_phone_lifecycle_instance(env):
    await enable(env)
    task,r=await start(env)
    assert r['instance_id']=='fixture-instance-123456'
    env.hub._sockets[env.ws]['phone_instance']='new-instance-after-resume'
    await decision(env,r)
    assert await task=={'error':'revoked'}
