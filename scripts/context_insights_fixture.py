"""Disposable loopback UI fixture. All context/account figures are synthetic."""
import asyncio
import tempfile
import sys
import time
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from aiohttp import web
from plugin.context_insights import ContextInsights
from plugin.hub import Hub
from plugin.store import Store


class FixtureBridge:
    revision=1
    def capabilities(self):return {k:True for k in ('session_context','context_compression','provider_limits','usage_insights')}
    async def inspect(self,chat,device):
        return {'chat_id':chat['id'],'session_id':'fixture-context','revision':f'context-fixture-{self.revision}',
            'model':'sample/reasoning-model-for-context-layout','provider':'Fixture provider','busy':False,'can_compress':True,'sampled_at':time.time(),
            'context':{'used':8400 if self.revision==1 else 3200,'window':32000,'source':'provider_usage_plus_estimate','estimated_total':9000,
                       'categories':[{'id':'system','label':'System instructions','tokens':1800},{'id':'tools','label':'Tool definitions','tokens':1400},{'id':'skills','label':'Skills and rules','tokens':600},{'id':'chat','label':'Conversation','tokens':5200}]},
            'compression_count':self.revision-1,'last_operation':None,
            'usage':{'input_tokens':42100,'output_tokens':6200,'cache_read_tokens':18000,'cache_write_tokens':0,'reasoning_tokens':1200,'api_call_count':8,'cost':{'value':.0425,'currency':'USD','source':'estimated'}},
            'details':{'skills':[{'name':'Release review','index_tokens':35,'file_tokens':600}],'toolsets':[{'name':'Workspace tools','tokens':1400,'tools':12}]},
            'rate_limits':[{'label':'Requests / minute','limit':60,'remaining':48,'captured_at':time.time()-15,'resets_at':time.time()+45}],
            'warning':'Synthetic layout fixture. Category sizes are estimates; throughput is cumulative, not context.'}
    async def account_route(self,chat,device):return ('fixture-account','fixture',{},None)
    async def account(self,route):return {'available':True,'provider':'Fixture provider','kind':'credits','source':'synthetic','fetched_at':time.time(),'windows':[{'label':'Monetary quota','used_percent':25,'resets_at':None,'detail':'USD 15 of USD 20 remaining'}],'details':['Synthetic credits balance: USD 15.00']}
    async def compress(self,chat,device,expected,check):
        before=(await self.inspect(chat,device))['context']
        await asyncio.sleep(2);check();self.revision+=1
        return {'status':'completed','changed':True,'before':before,'after':(await self.inspect(chat,device))['context'],'revision':f'context-fixture-{self.revision}','outcome':'Synthetic compression completed; no provider or real session was changed.'}


async def main():
    scratch=Path(tempfile.mkdtemp(prefix='winglet-context-qa-'))
    store=Store(scratch/'winglet.sqlite');store.ensure_chat('general','Context QA')
    hub=Hub(store,web_root=ROOT/'app/dist',bot_info=lambda:{'name':'fixture','title':'Context Lab','description':'Synthetic UI fixture'})
    locks={};hub.branching=SimpleNamespace(available=lambda:False,_lock=lambda key:locks.setdefault(key,asyncio.Lock()),busy=lambda key:locks.setdefault(key,asyncio.Lock()).locked())
    hub.context_insights=ContextInsights(hub,None,FixtureBridge())
    store.add_message('general','user','Review the release notes and summarize the risks.')
    store.add_message('general','bot','The release review is ready. Open Context and usage to inspect the synthetic fixture.')
    runner=web.AppRunner(hub.build_app());await runner.setup();await web.TCPSite(runner,'127.0.0.1',9309).start()
    print(f'QA_PAIR http://127.0.0.1:9309/#pair={store.create_pair_code(ttl=7200)}&fp={hub.keys.fingerprint}',flush=True)
    try:await asyncio.Event().wait()
    finally:await hub.aclose();await runner.cleanup();store.close()


asyncio.run(main())
