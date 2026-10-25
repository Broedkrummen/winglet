"""Disposable loopback UI fixture; synthetic data, no Hermes/provider operations.

Export app to app/dist-web-preview, then run this file from the repository root.
Open http://127.0.0.1:8310 and pair with http://127.0.0.1:9310 using printed code.
Temporary databases are removed when the process exits normally.
"""
import asyncio
import copy
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from aiohttp import web
from plugin.hub import Hub
from plugin.store import Store
from plugin.routine_history import RoutineHistory


class SyntheticScheduler:
    HermesUnavailable=RuntimeError
    HermesRefused=ValueError
    def __init__(self):
        stamp=time.time()-7200
        self.jobs=[{'id':'daily','name':'Daily workspace report and follow-ups','prompt':'Review the synthetic workspace health report. List completed checks and anything needing attention.',
                    'schedule_display':'Every day at 09:00','state':'scheduled','enabled':True,'next_run_at':stamp+86400},
                   {'id':'empty','name':'New weekly review','prompt':'Summarize synthetic notes.','schedule_display':'Every Friday at 17:00','state':'scheduled','enabled':True}]
        self.rows=[]; self.outputs=[]; self.sessions=[]
        statuses=['completed','failed','unknown','completed','running','claimed']
        for index in range(42):
            start=stamp-index*86400; status=statuses[index] if index<6 else 'completed'
            if status in {'running','claimed'}: start=time.time()-10
            run_id=f'fixture-{index:03}'
            self.rows.append(dict(id=run_id,job_id='daily',status=status,source='builtin',scheduled_instant=None if index%3==0 else start-30,
                                  claimed_at=start,started_at=start+1 if status!='claimed' else None,
                                  finished_at=start+19 if status not in {'claimed','running'} else None,
                                  error='Synthetic script exited with code 7.' if status=='failed' else None))
            if status=='completed':
                response='## Workspace health\n\nAll **12 synthetic checks** passed.\n\n- Backups verified\n- No pending maintenance\n- Next review tomorrow\n'
                if index==0: response+='\n'.join(f'Check {n}: synthetic evidence retained.' for n in range(250))
                self.outputs.append({'id':f'output-{index}','job_id':'daily','at':start+18,
                    'text':f'# Cron Job: Daily workspace report\n\n## Prompt\n\nReview synthetic workspace health.\n\n## Response\n\n{response}'})
                self.sessions.append({'id':f'cron_daily_fixture_{index:03}','job_id':'daily','started_at':start+2})
        self.rows.append(dict(id='archived-run',job_id='removed',status='failed',source='direct',claimed_at=stamp-100,started_at=stamp-99,finished_at=stamp-90,error='Synthetic archived failure.'))
    def routine_history_source(self,routine_id=None):
        return copy.deepcopy(dict(jobs=self.jobs,executions=[r for r in self.rows if not routine_id or r['job_id']==routine_id],
             outputs=[r for r in self.outputs if not routine_id or r['job_id']==routine_id],sessions=[r for r in self.sessions if not routine_id or r['job_id']==routine_id],
             routine_id=routine_id,complete_jobs=True,complete_records=True,complete_executions=True,complete_outputs=True,complete_sessions=True,timezone='Europe/London'))
    def list_schedule(self): return copy.deepcopy(self.jobs)
    def change_routine(self,routine_id,action,fields=None):
        job=next((j for j in self.jobs if j['id']==routine_id),None)
        if not job: return None
        if action=='run': job['manual_run_at']='2026-10-25T10:00:00Z'
        elif action in {'pause','resume'}: job.update(state='paused' if action=='pause' else 'scheduled',enabled=action=='resume')
        elif action=='delete': self.jobs.remove(job);return {'deleted':True}
        elif action=='update': job.update(fields or {})
        return copy.deepcopy(job)
    def configured_model(self): return {'model':'Synthetic fixture','provider':'local','label':'Local fixture'}
    def sessions_available(self): return True
    def session_transcript(self,session_id):
        return {'session':{'id':session_id,'title':'Synthetic workspace review','source':'cron','started_at':time.time()-7200},
                'messages':[{'id':'user-1','role':'user','text':'Review synthetic workspace health.','at':time.time()-7200,'failed':False},{'id':'assistant-1','role':'assistant','text':'All 12 synthetic checks passed.','at':time.time()-7180,'failed':False}], 'truncated':False}


async def main():
    with tempfile.TemporaryDirectory(prefix='winglet-routine-fixture-') as directory:
        path=Path(directory); store=Store(path/'fixture.db'); store.ensure_chat('home','Updates'); store.ensure_chat('general','General')
        hub=Hub(store,web_root=Path(__file__).resolve().parents[1]/'app/dist-web-preview',bot_info=lambda:{'name':'routine-lab','title':'Routine lab','description':'Synthetic local fixture'})
        hub.hermes=SyntheticScheduler(); hub.routine_history=RoutineHistory(path/'routine-history.sqlite')
        hub.routine_history.sync(None,hub.hermes.routine_history_source())
        await hub.post_message('home','Synthetic routine results are ready. Open Schedule to inspect recorded runs.',push=False)
        code=store.create_pair_code()
        print(f'UI http://127.0.0.1:8310  API http://127.0.0.1:9310  disposable pair code {code}',flush=True)
        runner=web.AppRunner(hub.build_app()); await runner.setup()
        await web.TCPSite(runner,'127.0.0.1',8310).start(); await web.TCPSite(runner,'127.0.0.1',9310).start()
        try: await asyncio.Event().wait()
        finally: await runner.cleanup(); await hub.aclose(); hub.routine_history.close(); store.close()


if __name__=='__main__':
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
