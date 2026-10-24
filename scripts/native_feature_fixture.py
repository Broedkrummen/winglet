"""Disposable real-Hermes state, synthetic replies: native integration QA only."""
import asyncio
import json
import os
import sys
import tempfile
import subprocess
from pathlib import Path
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
scratch=Path(tempfile.mkdtemp(prefix='winglet-native-integration-'))
home=scratch/'home'; home.mkdir(exist_ok=True)
workspace=scratch/'release-notes'; workspace.mkdir(exist_ok=True)
(home/'config.yaml').write_text('checkpoints:\n  enabled: true\n  max_snapshots: 10\n',encoding='utf-8')
os.environ.update(HERMES_HOME=str(home),TERMINAL_CWD=str(workspace),HERMES_DISABLE_LAZY_INSTALLS='1')

from aiohttp import web
from gateway.config import GatewayConfig
from gateway.platforms.base import Platform, SessionSource
from gateway.session import AsyncSessionStore, SessionStore
from hermes_state import SessionDB
from tools.checkpoint_manager import CheckpointManager
from tools.process_registry import process_registry
from plugin import execution, hermes_api
from plugin.branching import BranchService
from plugin.hub import Hub
from plugin.store import Store
from plugin.processes import Processes

async def main():
    store=Store(scratch/'winglet.db')
    sessions=SessionStore(sessions_dir=scratch/'sessions',config=GatewayConfig())
    db=SessionDB(db_path=scratch/'hermes.db'); sessions._db=db
    runner=SimpleNamespace(session_store=sessions,async_session_store=AsyncSessionStore(sessions))
    hub=Hub(store,web_root=ROOT/'app/dist',media_dir=scratch/'media',
            bot_info=lambda:{'name':'hermes','title':'Integration Lab','description':'Disposable native QA'})
    hub.hermes=hermes_api
    hub.hermes_version=lambda:'pinned Hermes / synthetic replies'
    store.ensure_chat('general','Spring garden')
    store.ensure_chat('research','Release research')
    loop=asyncio.get_running_loop()
    def publish(event):
        loop.call_soon_threadsafe(lambda:asyncio.ensure_future(hub.broadcast(event)))
    tracker=execution.Tracker(lambda sid: next(({'chat_id':c['id'],'bot':None}
        for c in store.list_chats() if sessions.peek_session_id(f'agent:main:telegram:dm:{c["id"]}')==sid),None),publish=publish)
    hub.execution=tracker

    class Adapter:
        gateway_runner=runner
        def build_source(self,**kw):
            return SessionSource(platform=Platform.TELEGRAM,chat_id=kw['chat_id'],chat_type='dm',user_id=kw['user_id'])
        def _session_key(self,chat_id): return f'agent:main:telegram:dm:{chat_id}'
        def _chat_model(self,chat_id): return None
        async def _on_user_message(self,chat,text,device,message,**extra):
            source=self.build_source(chat_id=chat['id'],user_id='fixture')
            entry=await runner.async_session_store.get_or_create_session(source)
            sid=entry.session_id
            db.append_message(sid,'user',text,platform_message_id=message['id'])
            tracker.turn_started(sid,message['id'])
            await hub.set_typing(chat['id'],True)
            await asyncio.sleep(.3)
            answer='Native QA reply. Your original conversation remains unchanged; no model provider was called.'
            db.append_message(sid,'assistant',answer)
            await hub.post_message(chat['id'],answer,role='bot',push=False)
            tracker.turn_finished(sid,message['id'])
            await hub.set_typing(chat['id'],False)
    adapter=Adapter()
    hub.branching=BranchService(hub,adapter)
    hub.processes=Processes(adapter)
    hub.on_user_message=adapter._on_user_message
    async def exchange(chat_id,prompt,reply):
        entry=await runner.async_session_store.get_or_create_session(adapter.build_source(chat_id=chat_id,user_id='fixture'))
        if any(m.get('text')==prompt for m in store.all_messages(chat_id)):
            return entry.session_id
        u=store.add_message(chat_id,'user',prompt)
        store.add_message(chat_id,'bot',reply)
        db.append_message(entry.session_id,'user',prompt,platform_message_id=u['id'])
        db.append_message(entry.session_id,'assistant',reply)
        return entry.session_id
    await exchange('general','Help me plan a spring garden.','Start with a sunny bed, rich soil and a simple watering plan.')
    await exchange('general','What about tomatoes? I had blossom end rot last year.','Keep moisture consistent and check the soil before adding calcium. Choose two varieties to start.')
    sid=await exchange('research','Review the release notes.','I am checking the changes and preparing a short summary.')
    old_sid=os.environ.get('HERMES_SESSION_ID')
    os.environ['HERMES_SESSION_ID']=sid
    proc=subprocess.Popen([sys.executable,'-u','-c',
        'import time\nfor i in range(600):\n print(f"Watching release notes: check {i}",flush=True)\n time.sleep(2)'],
        stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',
        start_new_session=True,creationflags=0x08000000 if os.name=='nt' else 0)
    job=process_registry.adopt_local(proc,command='python watch_release_notes.py',cwd=str(workspace),
        task_id=sid,session_key=adapter._session_key('research'),output_so_far='Watching release notes...\n',notify_on_complete=False)
    if old_sid is None: os.environ.pop('HERMES_SESSION_ID',None)
    else: os.environ['HERMES_SESSION_ID']=old_sid
    tracker.turn_started(sid,'native-review')
    tracker.plan_updated(sid,json.dumps({'revision':1,'todos':[
        {'id':'1','content':'Read the release notes','status':'completed'},
        {'id':'2','content':'Check changes affecting the phone','status':'in_progress'},
        {'id':'3','content':'Prepare the short summary','status':'pending'}]}),turn_id='native-review')
    tracker.tool_started(sid,'read_file','native-read',{'path':'notes/release.md'},turn_id='native-review')
    tracker.tool_finished(sid,'read_file','native-read',turn_id='native-review',status='ok',duration_ms=240)
    tracker.subagent_started(sid,'native-child','native-sub',goal='Check renamed settings screens',parent_turn_id='native-review')
    tracker.subagent_finished(sid,child_session_id='native-child',status='failed',summary='Synthetic timeout used to validate the failure state.',parent_turn_id='native-review')
    f=workspace/'release.md'
    manager=CheckpointManager(enabled=True,max_snapshots=10)
    if not f.exists():
        f.write_text('# Release notes\n\nOriginal reviewed notes.\n',encoding='utf-8')
        assert manager.ensure_checkpoint(str(workspace),'Before editing release notes')
        f.write_text('# Release notes\n\nUpdated phone layout and task details.\n',encoding='utf-8')
        manager.record_agent_write(str(f))
    if hasattr(hub,'checkpoints'):
        from plugin.checkpoints import CheckpointService
        hub.checkpoints=CheckpointService(hermes_api,busy=lambda:[])
    app=hub.build_app()
    async def controls(request):
        action=request.match_info['action']
        if action=='finish':
            tracker.turn_finished(sid,'native-review',completed=True)
            await hub.set_typing('research',False)
        elif action=='fail':
            tracker.turn_finished(sid,'native-review',failed=True)
            await hub.set_typing('research',False)
        elif action=='snapshot': return web.json_response({'task':tracker.snapshot('research'),'chats':store.list_chats(),'workspace_file':f.read_text(encoding='utf-8')})
        else: raise web.HTTPNotFound()
        return web.json_response({'ok':True})
    control=web.Application()
    control.router.add_get('/qa/{action}',controls)
    qa=web.AppRunner(control); await qa.setup(); await web.TCPSite(qa,'127.0.0.1',9381).start()
    api=web.AppRunner(app); await api.setup(); await web.TCPSite(api,'127.0.0.1',9380).start()
    async def pulse():
        while True:
            if tracker.snapshot('research')['state']=='running':
                await hub.set_typing('research',True)
            await asyncio.sleep(4)
    asyncio.create_task(pulse())
    code=store.create_pair_code(ttl=14400)
    print(f'QA_PAIR http://127.0.0.1:9380/#pair={code}&fp={hub.keys.fingerprint}',flush=True)
    print(f'QA_SCRATCH {scratch}',flush=True)
    print(f'QA_FEATURES {hub.features()}',flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await hub.processes.close()
        await asyncio.to_thread(process_registry.kill_process,job.id,consume_output=False)
        await api.cleanup()
        await qa.cleanup()

asyncio.run(main())
