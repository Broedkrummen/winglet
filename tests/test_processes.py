import asyncio
import json
import threading
from types import SimpleNamespace
import pytest
from plugin import processes as module
from plugin.processes import ProcessRefused, Processes, Scope
from plugin.hub import Hub, ROUTE_POLICY
from plugin.store import Store
from test_trust import pair_phone


def process(pid=123, started=1, text="hello\n"):
    return SimpleNamespace(id="proc_abcdef123456", started_at=started, pid=pid, host_start_time=10,
        session_key="key:general", parent_session_id="s:general", command="python worker.py", cwd="/workspace",
        exited=False, completion_reason="exited", exit_code=None, detached=False, process=object(),
        env_ref=None, _pty=None, output_buffer=text, total_output_chars=len(text), _lock=threading.Lock())


class Bridge:
    def __init__(self):
        self.item=process()
        self.calls=0
        self.sid="s:general"
        self.gate=threading.Event()
        self.gate.set()
    def available(self): return True
    def scope(self, chat): return Scope(chat['id'],chat.get('bot'),f"key:{chat['id']}",self.sid)
    def belongs(self, item, scope): return item.session_key==scope.key and item.parent_session_id==scope.session_id
    def list(self, scope): return [self.item] if self.belongs(self.item,scope) else []
    def get(self, sid): return self.item if self.item.id==sid else None
    def stop(self,item):
        self.calls+=1
        assert self.gate.wait(timeout=5)
        item.exited=True; item.completion_reason="killed"; item.exit_code=-15
        return {"status":"killed"}


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(module,'sanitized',lambda value,limit:str(value or '')[-limit:])
    return Processes(None,bridge=Bridge())


async def handle(service,chat=None):
    return (await service.listing(chat or {'id':'general'}))['processes'][0]['handle']


async def test_handles_are_opaque_scoped_and_generation_bound(service):
    h=await handle(service)
    assert 'proc_' not in h and '123' not in h
    for chat in [{'id':'elsewhere'},{'id':'general','bot':'other'}]:
        with pytest.raises(ProcessRefused) as error:
            await service.detail(chat,h)
        assert error.value.status==404
    service.bridge.item=process(pid=123,started=2)  # same PID, a different generation
    with pytest.raises(ProcessRefused) as error:
        await service.stop({'id':'general'},h,'operation-123456789')
    assert error.value.code=='stale' and service.bridge.calls==0


async def test_session_reset_and_gateway_restart_expire_handles(service):
    h=await handle(service)
    service.bridge.sid='new-session'
    with pytest.raises(ProcessRefused): await service.detail({'id':'general'},h)
    restarted=Processes(None,bridge=Bridge())
    with pytest.raises(ProcessRefused): await restarted.detail({'id':'general'},h)


async def test_output_deltas_resets_and_truncation_are_bounded(service):
    h=await handle(service)
    first=await service.detail({'id':'general'},h)
    assert first['output']['reset'] and first['output']['text']=='hello\n'
    item=service.bridge.item
    item.output_buffer+='world\n'; item.total_output_chars+=6
    second=await service.detail({'id':'general'},h,first['output']['cursor'])
    assert second['output']['text']=='world\n' and not second['output']['reset']
    again=await service.detail({'id':'general'},h,second['output']['cursor'])
    assert again['output']['text']=='' and not again['output']['reset']
    item.output_buffer='z'*100_000; item.total_output_chars+=100_000
    page=await service.detail({'id':'general'},h,second['output']['cursor'])
    assert page['output']['reset'] and page['output']['truncated']
    assert len(page['output']['text'])==module.OUTPUT_CHARS
    stale=await service.detail({'id':'general'},h,'-9')
    assert stale['output']['reset'] and len(stale['output']['text'])==module.OUTPUT_CHARS


async def test_stop_is_confirmed_asynchronously_and_duplicates_do_not_kill_again(service):
    h=await handle(service)
    service.bridge.gate.clear()
    first=await service.stop({'id':'general'},h,'operation-123456789')
    assert first['status']=='stopping'
    again=await service.stop({'id':'general'},h,'operation-another-123')
    assert again==first
    for _ in range(20):
        if service.bridge.calls: break
        await asyncio.sleep(.01)
    assert service.bridge.calls==1
    service.bridge.gate.set()
    await service.close()
    detail=await service.detail({'id':'general'},h)
    assert detail['process']['status']=='stopped'
    assert detail['process']['stop']['status']=='stopped'
    assert (await service.stop({'id':'general'},h,'operation-123456789'))['status']=='stopped'
    assert service.bridge.calls==1


async def test_already_exited_and_unverifiable_recovery_do_not_signal(service):
    h=await handle(service)
    service.bridge.item.exited=True
    assert (await service.stop({'id':'general'},h,'operation-123456789'))['status']=='already_exited'
    assert service.bridge.calls==0
    service.bridge.item=process(started=3)
    service.bridge.item.detached=True; service.bridge.item.process=None; service.bridge.item.host_start_time=None
    h=await handle(service)
    with pytest.raises(ProcessRefused) as error:
        await service.stop({'id':'general'},h,'operation-123456789')
    assert error.value.code=='unverifiable' and service.bridge.calls==0


async def test_handles_are_bounded_and_expire(monkeypatch,service):
    monkeypatch.setattr(module,'MAX_HANDLES',3)
    now=[10.0]; service.clock=lambda:now[0]
    old=await handle(service)
    for i in range(5):
        service.bridge.item=process(started=10+i)
        await handle(service)
    assert len(service._leases)==3
    with pytest.raises(ProcessRefused): await service.detail({'id':'general'},old)
    newest=await handle(service)
    now[0]+=module.HANDLE_TTL+1
    with pytest.raises(ProcessRefused): await service.detail({'id':'general'},newest)


async def test_failed_stop_is_replayed_for_same_operation_and_a_new_attempt_is_explicit(service):
    def failed(item):
        service.bridge.calls+=1
        return {'status':'error','error':'Process is still running'}
    service.bridge.stop=failed
    h=await handle(service)
    await service.stop({'id':'general'},h,'failed-operation-123')
    await service.close()
    replay=await service.stop({'id':'general'},h,'failed-operation-123')
    assert replay['status']=='failed' and service.bridge.calls==1
    await service.stop({'id':'general'},h,'new-operation-123456')
    await service.close()
    assert service.bridge.calls==2


async def test_older_slow_output_redaction_cannot_roll_back_newer_output(monkeypatch,service):
    h=await handle(service)
    entered=threading.Event(); release=threading.Event()
    def delayed(value,limit):
        if value=='old':
            entered.set()
            assert release.wait(timeout=5)
        return value[-limit:]
    monkeypatch.setattr(module,'sanitized',delayed)
    item=service.bridge.item
    item.output_buffer='old'; item.total_output_chars=3
    older=asyncio.create_task(service.detail({'id':'general'},h))
    while not entered.is_set(): await asyncio.sleep(.01)
    item.output_buffer='old-new'; item.total_output_chars=7
    newer=await service.detail({'id':'general'},h)
    release.set()
    late=await older
    assert newer['output']['text']=='old-new'
    assert late['output']['text']=='old-new'
    assert late['output']['cursor']==newer['output']['cursor']


@pytest.fixture
def hub(tmp_path,service):
    store=Store(tmp_path/'db.sqlite')
    store.ensure_chat('general','General')
    store.ensure_chat('otherbot','Other',bot='other')
    hub=Hub(store,web_root=tmp_path/'web')
    hub.processes=service
    hub.bots_provider=lambda:{'multiplex':True,'served':['default','other'],'bots':[]}
    yield hub
    store.close()


@pytest.fixture
async def client(aiohttp_client,hub):
    return await aiohttp_client(hub.build_app())


async def test_routes_require_owner_scope_and_signed_stop(client,hub):
    phone=await pair_phone(client,hub)
    endpoint='/api/processes/chats/general'
    assert (await client.get(endpoint)).status==401
    _,token=hub.store.add_device('Member','android',role='member',verified=True)
    assert (await client.get(endpoint,headers={'Authorization':f'Bearer {token}'})).status==403
    response=await client.get(endpoint,headers=phone.auth)
    assert response.status==200
    h=(await response.json())['processes'][0]['handle']
    assert (await client.get(f'/api/processes/chats/otherbot/{h}',headers=phone.auth)).status==404
    assert (await client.post(f'{endpoint}/{h}/stop',headers=phone.auth,json={'operation_id':'operation-123456789'})).status==403
    body={'operation_id':'operation-123456789'}
    # pair_phone owns the actual device signing key; use the same signature protocol as controls.
    raw=json.dumps(body).encode()
    headers=phone.signed('POST',f'{endpoint}/{h}/stop',raw)
    response=await client.post(f'{endpoint}/{h}/stop',headers={**headers,'Content-Type':'application/json'},data=raw)
    assert response.status==202,await response.text()
    await hub.processes.close()
    assert hub.processes.bridge.calls==1


def test_process_route_policy_is_owner_only():
    assert ROUTE_POLICY['h_process_list']=='owner'
    assert ROUTE_POLICY['h_process_detail']=='owner'
    assert ROUTE_POLICY['h_process_stop']=='owner_signed'
