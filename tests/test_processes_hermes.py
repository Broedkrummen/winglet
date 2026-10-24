"""Actual pinned Hermes registry, transcript ownership, output and process termination."""
import asyncio
import os
import subprocess
import sys
from types import SimpleNamespace
import pytest

pytest.importorskip('tools.process_registry',reason='requires the real pinned Hermes checkout')
from tools.process_registry import ProcessRegistry
from gateway.config import GatewayConfig
from gateway.session import SessionStore
from hermes_state import SessionDB
from plugin.processes import HermesProcesses, ProcessRefused, Processes, sanitized


@pytest.fixture
def real(tmp_path,monkeypatch):
    home=tmp_path/'home'; home.mkdir()
    monkeypatch.setenv('HERMES_HOME',str(home))
    monkeypatch.setenv('HERMES_SESSION_ID','parent')
    monkeypatch.setenv('HERMES_DISABLE_LAZY_INSTALLS','1')
    db=SessionDB(db_path=tmp_path/'state.db')
    for sid,parent in [('parent',None),('other',None),('child','parent')]:
        db.create_session(sid,source='telegram',parent_session_id=parent)
    store=SessionStore(sessions_dir=tmp_path/'sessions',config=GatewayConfig())
    store._db=db
    key='agent:main:telegram:dm:general'
    store.peek_session_id=lambda wanted:'parent' if wanted==key else 'other'
    registry=ProcessRegistry()
    class Bridge(HermesProcesses):
        @property
        def registry(self): return registry
    adapter=SimpleNamespace(gateway_runner=SimpleNamespace(session_store=store),
                            _session_key=lambda chat:key if chat=='general' else 'agent:main:telegram:dm:other')
    bridge=Bridge(adapter)
    service=Processes(adapter,bridge=bridge)
    spawned=[]
    def spawn(script,*,session_key=key,parent='parent',initial=''):
        monkeypatch.setenv('HERMES_SESSION_ID',parent)
        child=subprocess.Popen([sys.executable,'-u','-c',script],stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',
                               start_new_session=True)
        spawned.append(child)
        return registry.adopt_local(child,command='python native-process-test',cwd=str(tmp_path),
                                    task_id=parent,session_key=session_key,output_so_far=initial,
                                    notify_on_complete=False)
    try:
        yield service,bridge,registry,spawn,key
    finally:
        for child in spawned:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)
        db.close()


async def test_real_registry_is_scoped_and_observation_does_not_consume_completion(real):
    service,bridge,registry,spawn,key=real
    own=spawn('import time; time.sleep(60)',initial='ready\n')
    nested=spawn('import time; time.sleep(60)',parent='child',initial='nested\n')
    other=spawn('import time; time.sleep(60)',session_key='another-bot',parent='other')
    assert service.available()
    listing=await service.listing({'id':'general'})
    assert len(listing['processes'])==2
    own_handle=next(row['handle'] for row in listing['processes']
                    if service._leases[row['handle']].generation[0]==own.id)
    detail=await service.detail({'id':'general'},own_handle)
    assert detail['output']['text']=='ready\n'
    assert own.id not in registry._completion_consumed
    assert other.id not in [x.generation[0] for x in service._leases.values()]
    with pytest.raises(ProcessRefused):
        await service.detail({'id':'other'},own_handle)
    result=await service.stop({'id':'general'},own_handle,'real-stop-operation-123')
    assert result['status']=='stopping'
    await service.close()
    assert own.process.poll() is not None
    detail=await service.detail({'id':'general'},own_handle)
    assert detail['process']['stop']['status'] in ('stopped','already_exited')
    assert own.id not in registry._completion_consumed


async def test_real_output_arrives_and_natural_exit_is_reported_without_kill(real):
    service,bridge,registry,spawn,key=real
    own=spawn('print("ready",flush=True); print("done",flush=True)')
    for _ in range(200):
        if own.exited: break
        await asyncio.sleep(.01)
    listing=await service.listing({'id':'general'})
    row=listing['processes'][0]
    assert row['status']=='exited' and row['exit_code']==0
    detail=await service.detail({'id':'general'},row['handle'])
    assert 'ready' in detail['output']['text'] and 'done' in detail['output']['text']
    result=await service.stop({'id':'general'},row['handle'],'real-exited-operation-123')
    assert result['status']=='already_exited'
    assert own.id not in registry._completion_consumed


def test_actual_hermes_redactor_cleans_complete_output_and_terminal_controls(monkeypatch,tmp_path):
    home=tmp_path/'home'; home.mkdir()
    monkeypatch.setenv('HERMES_HOME',str(home))
    secret='sk-proj-'+('aB9x'*20)
    text=f'\x1b[31mhello\x1b[0m\nAuthorization: Bearer {secret}\nhttps://user:password@example.test/\n'
    result=sanitized(text,16384)
    assert secret not in result and 'user:password@' not in result
    assert '\x1b' not in result and 'hello' in result


def test_process_id_prefix_resolution_is_never_accepted_as_an_exact_handle(real,monkeypatch):
    _,bridge,registry,spawn,key=real
    item=spawn('import time; time.sleep(60)')
    assert registry.get(item.id[:10]) is item
    assert bridge.get(item.id[:10]) is None
