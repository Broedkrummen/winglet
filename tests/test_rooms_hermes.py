"""Actual pinned room policy/runtime, with a non-network session transport."""
import json
import threading
import time
from types import SimpleNamespace

import pytest

pytest.importorskip('gateway.hosted_rooms')
from gateway import hosted_rooms
from tui_gateway.hosted_room_service import HostedRoomService
from plugin.rooms import Rooms, RoomError
from plugin.hub import Hub
from plugin.store import Store


class RPC:
    def __init__(self):
        self.sessions = {}
        self.calls = []
        self.pending = {}
        self.hold = False
    def resolve_exact(self, **kw): return self.sessions.get((kw['profile'],kw['title']))
    def create(self, **kw):
        assert kw['source']=='bot_room'
        result={'session_id':kw['profile']+'-'+str(len(self.sessions)), 'title':kw['title']}
        self.sessions[kw['profile'],kw['title']]=result
        return result
    def resume(self, **kw): return {'session_id':kw['session_id']}
    def submit(self, **kw):
        self.calls.append(kw)
        if self.hold:
            self.pending[kw['session_id']]=kw
        else:
            kw['on_terminal']({'status':'settled','text':f"Reply from {kw['profile']}"})
        return {'accepted':True}
    def history(self, **kw): return []
    def info(self, **kw):
        pending=self.pending.get(kw['session_id'])
        return {'active':bool(pending),'task_id':pending['task'].task_id if pending else None}
    def interrupt(self, **kw):
        pending=self.pending.pop(kw['session_id'],None)
        if pending:
            assert pending['task'].task_id==kw['expected_task_id']
            pending['on_terminal']({'status':'cancelled','reason':'Stopped from Winglet'})
        return {'interrupted':True}


@pytest.fixture
def room_env(tmp_path,monkeypatch):
    monkeypatch.setenv('HERMES_HOME',str(tmp_path/'hermes'))
    store=Store(tmp_path/'winglet.db')
    owner,_=store.add_device('Owner','test',role='owner',verified=True)
    member,_=store.add_device('Reader','test',role='member',verified=True)
    hub=Hub(store,web_root=tmp_path/'web',bot_info=lambda:{'title':'Main'})
    hub.bots_provider=lambda:{'bots':[{'name':'ops','title':'Ops','served':True},
                                    {'name':'quiet','title':'Quiet','served':False}],'multiplex':True}
    worker=HostedRoomService(SimpleNamespace(_methods={},_sessions={},_sessions_lock=threading.Lock()),db_path=tmp_path/'rooms.db')
    rpc=RPC()
    worker.rpc=worker.runtime.rpc=rpc
    worker.local_profiles=lambda:('default','ops')
    worker.runtime.poll_interval_seconds=.02
    worker.runtime.active_poll_interval_seconds=.01
    worker.start()
    rooms=Rooms(hub,worker,tmp_path/'rooms-meta.db')
    yield rooms,store.get_device(owner['id']),store.get_device(member['id']),rpc
    assert worker.stop(timeout=5)
    store.close()


def create(rooms,owner):
    return rooms.mutate(owner,'create','',{'operation_id':'create-operation-123','title':'Release room','bots':['default','ops']})['id']


def wait_for(predicate):
    until=time.monotonic()+5
    while time.monotonic()<until:
        if predicate(): return
        time.sleep(.01)
    raise AssertionError('Room did not settle')


def test_real_room_dispatch_is_addressed_durable_and_idempotent(room_env):
    rooms,owner,member,rpc=room_env
    rid=create(rooms,owner)
    assert create(rooms,owner)==rid
    request={'operation_id':'send-operation-123','revision':1,'text':'@ops inspect the release'}
    assert rooms.mutate(owner,'send',rid,request)=={'accepted':True}
    wait_for(lambda: any(e['kind']=='message.member' for e in rooms.log(owner,rid)['events']))
    assert rooms.mutate(owner,'send',rid,request)=={'accepted':True}
    assert [call['profile'] for call in rpc.calls]==['ops']
    log=rooms.log(owner,rid)
    user=[e for e in log['events'] if e['kind']=='message.user']
    assert len(user)==1 and user[0]['actor']['id']=='winglet:'+owner['id']
    assert all(call['source']=='bot_room' for call in rpc.calls)
    assert rooms.listing(member)['rooms']==[]
    with pytest.raises(RoomError): rooms.log(member,rid)


def test_member_read_grants_do_not_grant_execution_and_revocation_is_immediate(room_env):
    rooms,owner,member,rpc=room_env
    rid=create(rooms,owner)
    rooms.mutate(owner,'update',rid,{'operation_id':'share-operation-123','revision':1,'readers':[member['id']]})
    state=rooms.state(member,rid)
    assert not state['can_send'] and not state['member_write_supported']
    for action in ('send','stop','retry','approve','update','create'):
        with pytest.raises(RoomError) as error:
            rooms.mutate(member,action,rid,{'operation_id':'member-operation-123'})
        assert error.value.status==403
    cursor=state['latest']
    rooms.mutate(member,'seen',rid,{'operation_id':'seen-operation-123','cursor':cursor})
    assert not rooms.state(member,rid)['unread']
    rooms.mutate(owner,'update',rid,{'operation_id':'revoke-operation-123','revision':2,'readers':[]})
    with pytest.raises(RoomError): rooms.state(member,rid)
    with pytest.raises(RoomError):
        rooms.mutate(member,'seen',rid,{'operation_id':'seen-operation-123','cursor':cursor})


def test_unaddressed_unavailable_and_stale_requests_never_dispatch(room_env):
    rooms,owner,_,rpc=room_env
    rid=create(rooms,owner)
    for text,revision in [('hello room',1),('@nobody hello',1),('@ops hello',0)]:
        with pytest.raises(RoomError):
            rooms.mutate(owner,'send',rid,{'operation_id':'reject-operation-123','revision':revision,'text':text})
    with pytest.raises(RoomError):
        rooms.mutate(owner,'create','',{'operation_id':'invalid-create-123','title':'Broken','bots':['default','quiet']})
    assert not rpc.calls


def test_stop_and_roster_change_preserve_old_transcript(room_env):
    rooms,owner,_,rpc=room_env
    rid=create(rooms,owner)
    rpc.hold=True
    rooms.mutate(owner,'send',rid,{'operation_id':'held-operation-123','revision':1,'text':'@ops inspect'})
    wait_for(lambda:bool(rpc.pending))
    rooms.mutate(owner,'stop',rid,{'operation_id':'stop-operation-123'})
    wait_for(lambda:not rooms.state(owner,rid)['driver']['working'])
    assert not rpc.pending
    rooms.mutate(owner,'update',rid,{'operation_id':'roster-operation-123','revision':1,'bots':['ops','default']})
    assert rooms.state(owner,rid)['epoch_count']==2
    page=rooms.log(owner,rid)
    assert any(e['kind']=='message.user' for e in page['events'])
    assert page['has_more'] and page['cursor']==[1,0]
    assert rooms.log(owner,rid,*page['cursor'])['cursor'][0]==1


def test_restart_replays_receipts_without_new_dispatch(room_env):
    rooms,owner,_,rpc=room_env
    rid=create(rooms,owner)
    request={'operation_id':'durable-operation-123','revision':1,'text':'@main review'}
    rooms.mutate(owner,'send',rid,request)
    wait_for(lambda:any(e['kind']=='message.member' for e in rooms.log(owner,rid)['events']))
    restarted=Rooms(rooms.hub,rooms.worker,rooms.path)
    assert restarted.mutate(owner,'send',rid,request)=={'accepted':True}
    assert len(rpc.calls)==1
    changed={**request,'text':'@main changed request'}
    with pytest.raises(RoomError): restarted.mutate(owner,'send',rid,changed)
    rooms.hub.store.add_device('Other owner','test',role='owner',verified=True)
    rooms.hub.store.update_device(owner['id'],role='member')
    with pytest.raises(RoomError): restarted.mutate(owner,'send',rid,request)


def test_real_session_rpc_creates_room_identity_and_refuses_private_title_collision(room_env,tmp_path,monkeypatch):
    from hermes_state import SessionDB
    from tui_gateway import server
    from plugin.rooms_hermes import build_worker
    rooms,owner,_,_=room_env
    db=SessionDB(tmp_path/'session-guard.db')
    monkeypatch.setattr(server,'_get_db',lambda:db)
    # The server caches its launch home at import; other integration tests may
    # have imported it under a different disposable HERMES_HOME.
    monkeypatch.setattr(server,'_hermes_home',str(tmp_path/'hermes'))
    monkeypatch.setattr(server,'_sessions',{})
    monkeypatch.setattr(server,'_sessions_lock',threading.Lock())
    monkeypatch.setattr(server,'_schedule_agent_build',lambda sid:None)
    monkeypatch.setattr(server,'_schedule_session_cap_enforcement',lambda:None)
    adapter=SimpleNamespace(_bots_state=lambda:{'bots':[]})
    worker=build_worker(adapter,tmp_path/'guard-runtime.db',rooms.hub)
    try:
        created=worker.rpc.create(profile='default',title='Group: opaque-test-room',source='bot_room')
        record=worker.rpc._session_record(created['session_id'])
        assert record['source']=='bot_room' and record['room_plumbing'] and record['pending_hidden']
        db.create_session(record['session_key'],source='bot_room')
        db.set_session_hidden(record['session_key'],True)
        record.pop('pending_hidden')  # consumed when the first real prompt persists
        worker.rpc._guard('default',created['session_id'])
        db.create_session('private-collision',source='winglet')
        db.set_session_title('private-collision','Group: collision')
        with pytest.raises(RuntimeError,match='private session'):
            worker.rpc.resolve_exact(profile='default',title='Group: collision',source='bot_room')
        with pytest.raises(RuntimeError,match='non-room'):
            worker.rpc.resume(profile='default',session_id='private-collision',source='bot_room')
    finally:
        assert worker.stop(timeout=5)
        db.close()


def test_live_author_revocation_stops_held_turn_without_a_manual_policy_cycle(room_env,tmp_path):
    from plugin.rooms_hermes import build_worker
    rooms,owner,_,_=room_env
    rooms.hub.store.add_device('Remaining owner','test',role='owner',verified=True)
    adapter=SimpleNamespace(_bots_state=lambda:{'bots':[{'name':'ops','served':True}]})
    runtime_dir=tmp_path/'live-revocation'
    runtime_dir.mkdir()
    worker=build_worker(adapter,runtime_dir/'rooms-runtime.sqlite',rooms.hub)
    held=RPC();held.hold=True
    worker.install_rpc(held)
    scoped=Rooms(rooms.hub,worker,runtime_dir/'rooms-meta.sqlite')
    worker.runtime.poll_interval_seconds=.02
    worker.runtime.active_poll_interval_seconds=.01
    worker.start()
    try:
        rid=create(scoped,owner)
        scoped.mutate(owner,'send',rid,{'operation_id':'live-revoke-turn-123','revision':1,'text':'@ops wait'})
        wait_for(lambda:bool(held.pending))
        assert worker.rpc is worker.runtime.rpc
        rooms.hub.store.update_device(owner['id'],role='member')
        # No explicit prepare_room/Stop call here: only the real observation loop.
        wait_for(lambda:not held.pending)
        with scoped._db() as db:
            row=db.execute('SELECT epochs FROM winglet_rooms WHERE id=?',(rid,)).fetchone()
        upstream_id=json.loads(row[0])[-1]
        wait_for(lambda:not worker.status(upstream_id)['working'])
        assert worker.status(upstream_id)['counts'].get('cancelled')==1
        assert len(held.calls)==1
    finally:
        assert worker.stop(timeout=5)


def test_offline_roster_member_does_not_block_archive_or_access_revocation(room_env):
    rooms,owner,member,rpc=room_env
    rid=create(rooms,owner)
    rooms.mutate(owner,'update',rid,{'operation_id':'offline-share-1234','revision':1,'readers':[member['id']]})
    rooms.hub.bots_provider=lambda:{'bots':[{'name':'ops','title':'Ops','served':False}],'multiplex':True}
    rooms.hub.bots_state(fresh=True)
    rooms.mutate(owner,'update',rid,{'operation_id':'offline-archive-1234','revision':2,'archived':True,'readers':[]})
    assert rooms.state(owner,rid)['archived']
    with pytest.raises(RoomError): rooms.state(member,rid)


def test_real_prompt_submit_dispatches_isolated_room_session_without_a_provider(room_env,tmp_path,monkeypatch):
    from hermes_state import SessionDB
    from tui_gateway import server
    from tui_gateway import launch_profile_policy
    from agent import secret_scope
    from plugin.rooms_hermes import build_worker
    rooms,owner,_,_=room_env
    ops_home=tmp_path/'hermes'/'profiles'/'ops'
    ops_home.mkdir(parents=True)
    (ops_home/'config.yaml').write_text('model: {}\n',encoding='utf-8')
    db=SessionDB(tmp_path/'real-room-submit.db')
    monkeypatch.setattr(server,'_get_db',lambda:db)
    monkeypatch.setattr(server,'_hermes_home',str(tmp_path/'hermes'))
    # Exercise real multi-profile activation, then restore process-wide state
    # so this disposable host does not scope the tests that follow it.
    monkeypatch.setattr(server,'_served_profile_homes',set())
    monkeypatch.setattr(launch_profile_policy,'_snapshot',None)
    monkeypatch.setattr(secret_scope,'_MULTIPLEX_ACTIVE',secret_scope._MULTIPLEX_ACTIVE)
    monkeypatch.setattr(server,'_sessions',{})
    monkeypatch.setattr(server,'_sessions_lock',threading.RLock())
    monkeypatch.setattr(server,'_schedule_agent_build',lambda sid:None)
    monkeypatch.setattr(server,'_schedule_session_cap_enforcement',lambda:None)
    monkeypatch.setattr(server,'_start_agent_build',lambda *args:None)
    calls=[]
    def non_network_agent(rid,sid,session,text,kind,metadata,on_terminal,author):
        calls.append((session['session_key'],session['source'],text))
        # Run the real completion hook that commits the session's pending room
        # title. Skipping it would make the next turn create another session.
        server._after_complete_turn(sid,session,SimpleNamespace(tts_queue=object()),'')
        with session['history_lock']:
            session['running']=False
        on_terminal({'status':'settled','text':'Reply from the non-network test agent'})
    monkeypatch.setattr(server,'_run_after_agent_ready',non_network_agent)
    directory=tmp_path/'real-submit';directory.mkdir()
    adapter=SimpleNamespace(_bots_state=lambda:{'bots':[{'name':'ops','served':True}]})
    worker=build_worker(adapter,directory/'rooms-runtime.sqlite',rooms.hub)
    scoped=Rooms(rooms.hub,worker,directory/'rooms-meta.sqlite')
    worker.runtime.poll_interval_seconds=.02
    worker.runtime.active_poll_interval_seconds=.01
    worker.start()
    try:
        rid=create(scoped,owner)
        for index,handle in enumerate(('main','main','ops','ops')):
            scoped.mutate(owner,'send',rid,{'operation_id':f'real-submit-turn-{index}-123','revision':1,'text':f'@{handle} inspect this isolated room'})
            wait_for(lambda:len(calls)>index)
            wait_for(lambda:not scoped.state(owner,rid)['driver']['working'])
        assert len(calls)==4 and all(source=='bot_room' for _,source,_ in calls)
        assert calls[0][0]==calls[1][0] and calls[2][0]==calls[3][0]
        assert calls[0][0]!=calls[2][0]
        row=db.get_session(calls[0][0])
        assert row['source']=='bot_room' and row['hidden']
        ops_db=SessionDB(ops_home/'state.db')
        try:
            ops_row=ops_db.get_session(calls[2][0])
            assert ops_row['source']=='bot_room' and ops_row['hidden']
            assert db.get_session(calls[2][0]) is None
            assert ops_db.get_session(calls[0][0]) is None
        finally:
            ops_db.close()
        with pytest.raises(RuntimeError,match='another bot profile'):
            worker.rpc._guard('ops',next(key for key,value in server._sessions.items() if value['session_key']==calls[0][0]))
        assert sum(e['kind']=='message.member' for e in scoped.log(owner,rid)['events'])==4
    finally:
        assert worker.stop(timeout=5)
        db.close()
