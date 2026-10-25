"""Durable scheduler facts, conservative correlation, stable paging and fresh ACLs."""
import asyncio
import concurrent.futures
import threading

import pytest

from plugin.hub import Hub
from plugin.store import Store
from plugin.routine_history import RoutineHistory, _unique_links, clean
from test_trust import pair_phone


def execution(id='run-1', job_id='job', status='completed', **extra):
    return dict(id=id, job_id=job_id, status=status, source='builtin', scheduled_instant='2026-10-25T10:00:00Z',
                claimed_at=100, started_at=101, finished_at=110 if status in {'completed','failed','unknown'} else None, **extra)


def source(*rows, **extra):
    return dict(jobs=[{'id': 'job', 'name': 'Morning report', 'prompt': 'Read synthetic data', 'schedule_display': 'Every day at 09:00'}],
                executions=list(rows), outputs=[], sessions=[], complete_executions=True,
                complete_outputs=True, complete_sessions=True, timezone='Europe/London', **extra)


@pytest.fixture
def history(tmp_path):
    h = RoutineHistory(tmp_path / 'history.db')
    yield h
    h.close()


@pytest.mark.parametrize('raw,expected', [('claimed','pending'),('running','running'),('completed','completed'),('failed','failed'),('unknown','unknown')])
def test_only_ledger_status_establishes_outcome(history, raw, expected):
    row = execution(status=raw)
    history.sync(None, source(row))
    assert history.detail(None, 'job', 'run-1')['status'] == expected
    history.sync(None, source(row))
    assert len(history.page(None, 'job')['runs']) == 1


def test_trigger_is_explicit_pin_occurrence_not_latest_job_state(history):
    rows = [execution('scheduled'), execution('manual'), execution('direct'), execution('old'), execution('external')]
    rows[1]['scheduled_instant'] = None
    rows[2]['source'] = 'direct'; rows[2]['scheduled_instant'] = None
    del rows[3]['scheduled_instant']
    rows[4]['source'] = 'custom-provider'
    history.sync(None, source(*rows))
    assert {r['id']: r['trigger'] for r in history.page(None,'job')['runs']} == {
        'scheduled':'scheduled', 'manual':'manual', 'direct':'manual', 'old':'unknown', 'external':'unknown'}


def test_restart_and_interruption_never_promote_to_success(tmp_path):
    path = tmp_path / 'restart.db'
    h = RoutineHistory(path)
    h.sync(None, source(execution(status='running')))
    h.close()
    h = RoutineHistory(path)
    try:
        h.sync(None, source(execution(status='running', owner_gone=True)))
        run = h.detail(None,'job','run-1')
        assert run['status'] == 'interrupted' and 'unknown' in run['error']
        h.sync(None, source(execution(status='unknown')))
        assert h.detail(None,'job','run-1')['status'] == 'unknown'
    finally: h.close()


def test_terminal_cannot_regress_from_stale_active_observation(history):
    history.sync(None, source(execution()))
    history.sync(None, source(execution(status='running')))
    assert history.detail(None,'job','run-1')['status'] == 'completed'


def test_unique_artifact_and_actual_session_not_generated_session_id(history):
    doc = {'id':'doc','job_id':'job','at':109,'text':'# Cron Job: Original title\n\n## Prompt\n\nOriginal prompt\n\n## Response\n\nActual response'}
    s = source(execution()); s['outputs']=[doc]; s['sessions']=[{'id':'real-tip-session','job_id':'job','started_at':102}]
    history.sync(None,s)
    run=history.detail(None,'job','run-1')
    assert run['session_id']=='real-tip-session' and run['title']=='Original title'
    assert run['definition']['prompt']=='Original prompt' and run['definition_provenance']=='run_output'
    assert history.delivery_run(None,'job','Actual response')=='run-1'
    assert history.delivery_run('other','job','Actual response') is None
    assert history.delivery_run(None,'job','response') is None


@pytest.mark.parametrize('field', ['complete_executions','complete_outputs','complete_sessions'])
def test_incomplete_coverage_refuses_affected_links(history,field):
    s=source(execution()); s[field]=False
    s['outputs']=[{'id':'doc','job_id':'job','at':109,'text':'output'}]
    s['sessions']=[{'id':'actual','job_id':'job','started_at':102}]
    history.sync(None,s)
    run=history.detail(None,'job','run-1')
    if field!='complete_sessions': assert not run.get('output')
    if field!='complete_outputs': assert not run.get('session_id')
    assert len(history.page(None,'job')['runs']) == 1


def test_overlapping_runs_have_distinct_ids_and_no_guessed_artifacts(history):
    s=source(execution('a'),execution('b'))
    s['outputs']=[{'id':'doc','job_id':'job','at':109,'text':'overlapped'}]
    s['sessions']=[{'id':'real','job_id':'job','started_at':102}]
    history.sync(None,s)
    assert len(history.page(None,'job')['runs'])==2
    for row in history.page(None,'job')['runs']:
        assert not row.get('session_id') and not row['has_output']


def test_multiple_documents_and_repeated_response_never_guess(history):
    a=execution('a'); b=execution('b'); b.update(claimed_at=200,started_at=201,finished_at=210)
    s=source(a,b); s['outputs']=[{'id':'first','job_id':'job','at':109,'text':'\n## Response\n\nSame'}, {'id':'second','job_id':'job','at':209,'text':'\n## Response\n\nSame'}]
    history.sync(None,s)
    assert history.delivery_run(None,'job','Same') is None
    assert _unique_links([a], s['outputs']+[{'id':'extra','job_id':'job','at':108}]) == {}


def test_surviving_output_is_unknown_and_deleted_routine_is_discoverable(history):
    s=source(); s['jobs']=[]; s['outputs']=[{'id':'doc','job_id':'deleted','at':109,'text':'Old output'}]
    history.sync(None,s)
    page=history.page(None,'deleted')
    assert page['archived'] and page['runs'][0]['status']=='unknown' and not page['runs'][0]['recorded']
    assert history.archived(None)[0]['id']=='deleted'


def test_rename_delete_preserves_original_definition_and_captured_output(history):
    s=source(execution()); s['outputs']=[{'id':'doc','job_id':'job','at':109,'text':'retained'}]
    history.sync(None,s)
    s['jobs'][0]['name']='Renamed'; s['jobs'][0]['prompt']='New prompt'; s['outputs']=[]
    history.sync(None,s)
    assert history.detail(None,'job','run-1')['definition_changed']
    s['jobs']=[]; s['executions']=[]
    history.sync(None,s)
    run=history.detail(None,'job','run-1')
    assert run['archived'] and run['title']=='Morning report' and run['output']=='retained'
    assert history.archived(None)[0]['name']=='Renamed'


def test_stable_tied_pagination_survives_new_arrival_and_rejects_wrong_scope(history):
    history.sync(None,source(*(execution(str(i)) for i in range(7))))
    page=history.page(None,'job',limit=3)
    history.sync(None,source(execution('new')))
    older=history.page(None,'job',limit=3,cursor=page['next_cursor'])
    assert {r['id'] for r in page['runs']}.isdisjoint(r['id'] for r in older['runs'])
    for bot,job,cursor in [('other','job',page['next_cursor']), (None,'other',page['next_cursor']), (None,'job','corrupt')]:
        with pytest.raises(ValueError): history.page(bot,job,cursor=cursor)


def test_retention_bounds_terminal_rows_and_keeps_live_runs(tmp_path):
    h=RoutineHistory(tmp_path/'bounded.db',keep_runs=2,keep_bot_runs=3)
    try:
        h.sync(None,source(*(execution(str(i)) for i in range(8)),execution('live',status='running')))
        assert len(h.page(None,'job')['runs'])==3
        assert h.detail(None,'job','live')['status']=='running'
    finally: h.close()


def test_concurrent_duplicate_observations_are_one_durable_row(history):
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _:history.sync('researcher',source(execution())),range(12)))
    assert len(history.page('researcher','job')['runs'])==1
    assert history.page(None,'job') is None


def test_sanitization_controls_and_credentials():
    text=clean('\x1b[31mhello\x00 token=synthetic-secret https://user:pass@example.test sk-abcdefghijklmnop',500)
    assert 'hello' in text and 'synthetic-secret' not in text and 'user:pass' not in text and '\x00' not in text


class FakeHermes:
    HermesUnavailable=RuntimeError
    HermesRefused=ValueError
    def __init__(self):
        self.entered=threading.Event(); self.release=threading.Event(); self.hold=False; self.fail=False
    def routine_history_source(self, routine_id=None):
        if self.hold:
            self.entered.set(); assert self.release.wait(5)
        if self.fail: raise RuntimeError('private filesystem detail')
        return source(execution())


@pytest.fixture
def hub(tmp_path):
    store=Store(tmp_path/'store.db'); store.ensure_chat('general','General')
    h=Hub(store,web_root=tmp_path/'web',bot_info=lambda:{'name':'hermes','title':'Hermes'})
    h.hermes=FakeHermes(); h.routine_history=RoutineHistory(tmp_path/'history.db')
    yield h
    h.routine_history.close(); store.close()


@pytest.fixture
async def client(aiohttp_client,hub): return await aiohttp_client(hub.build_app())


async def test_owner_only_routes_and_unknown_bot(client,hub):
    owner=await pair_phone(client,hub); member=await pair_phone(client,hub,'Member',role='member')
    for path in ['/api/routine-history','/api/routine-history/job','/api/routine-history/job/run/run-1']:
        assert (await client.get(path)).status==401
        assert (await client.get(path,headers=member.auth)).status==403
        assert (await client.get(path,headers=owner.auth)).status==200
        assert (await client.get(path+'?bot=not-served',headers=owner.auth)).status in {403,404}
    assert (await client.get('/api/routine-history/job?cursor=bad',headers=owner.auth)).status==400


@pytest.mark.parametrize('path',['/api/routine-history','/api/routine-history/job','/api/routine-history/job/run/run-1'])
@pytest.mark.parametrize('change',['demote','unpair'])
async def test_actor_revalidated_after_held_source(client,hub,path,change):
    owner=await pair_phone(client,hub)
    await pair_phone(client,hub,'Remaining owner')
    hub.hermes.hold=True
    task=asyncio.create_task(client.get(path,headers=owner.auth))
    assert await asyncio.to_thread(hub.hermes.entered.wait,2)
    if change=='demote': hub.store.update_device(owner.id,role='member')
    else: hub.store.remove_device(owner.id)
    hub.hermes.release.set()
    response=await task
    assert response.status in {401,403}
    assert 'Read synthetic data' not in await response.text()


async def test_read_failure_keeps_previous_evidence_and_rechecks_actor(client,hub):
    owner=await pair_phone(client,hub)
    assert (await client.get('/api/routine-history/job',headers=owner.auth)).status==200
    hub.hermes.fail=True
    r=await client.get('/api/routine-history/job',headers=owner.auth)
    assert r.status==200 and (await r.json())['stale']
    assert (await client.get('/api/routine-history/never-seen',headers=owner.auth)).status==503


async def test_cancellation_drains_dispatched_mirror_before_close(hub):
    entered=threading.Event(); release=threading.Event()
    original=hub.routine_history.sync
    def slow(*args):
        entered.set(); assert release.wait(5); return original(*args)
    hub.routine_history.sync=slow
    task=asyncio.create_task(hub._sync_routine_history())
    assert await asyncio.to_thread(entered.wait,2)
    task.cancel(); await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError): await task
    assert hub.routine_history.detail(None,'job','run-1')


def test_missing_active_native_record_is_unknown_only_in_complete_requested_scope(history):
    history.sync(None, source(execution(status='running')))
    empty=source(); empty.update(complete_records=True,routine_id='other')
    history.sync(None,empty)
    assert history.detail(None,'job','run-1')['status']=='running'
    empty['routine_id']='job'; empty['complete_records']=False
    history.sync(None,empty)
    assert history.detail(None,'job','run-1')['status']=='running'
    empty['complete_records']=True
    history.sync(None,empty)
    assert history.detail(None,'job','run-1')['status']=='unknown'
    assert history.detail(None,'job','run-1')['finished_at'] is None


def test_correlation_precomputes_times_in_linear_number_of_parses(monkeypatch):
    from plugin import routine_history as module
    original=module.instant; calls=[]
    monkeypatch.setattr(module,'instant',lambda value:(calls.append(value),original(value))[1])
    rows=[execution(str(i),job_id='job-'+str(i)) for i in range(1000)]
    docs=[{'id':str(i),'job_id':'job-'+str(i),'at':105} for i in range(500)]
    assert len(_unique_links(rows,docs))==500
    assert len(calls)<=3500


def test_late_overlap_revokes_provisional_output_and_session_link(history):
    s=source(execution('a'))
    s['outputs']=[{'id':'doc','job_id':'job','at':109,'text':'# Cron Job: Captured title\n\n## Response\n\nResult'}]
    s['sessions']=[{'id':'session','job_id':'job','started_at':102}]
    history.sync(None,s)
    assert history.detail(None,'job','a')['session_id']=='session'
    s['executions'].append(execution('b'))
    history.sync(None,s)
    run=history.detail(None,'job','a')
    assert not run.get('output') and not run.get('session_id')
    assert run['title']=='Morning report' and run['definition_provenance']=='first_observed'


def test_direct_dispatch_with_scheduled_occurrence_keeps_scheduled_trigger(history):
    row=execution(); row['source']='direct'
    history.sync(None,source(row))
    assert history.detail(None,'job','run-1')['trigger']=='scheduled'


def test_list_summary_uses_response_instead_of_dispatch_document_or_prompt(history):
    s=source(execution()); s['outputs']=[{'id':'doc','job_id':'job','at':109,'text':'# Cron Job: title\n\n## Prompt\n\nPrivate synthetic instruction\n\n## Response\n\n## Health\n\nAll **12** checks passed.'}]
    history.sync(None,s)
    row=history.page(None,'job')['runs'][0]
    assert '12 checks passed' in row['summary']
    assert 'Private synthetic instruction' not in row['summary'] and 'Cron Job' not in row['summary']
    assert 'definition' not in row and 'observed_definition' not in row


def test_pruned_ledger_allows_only_artifacts_beyond_trusted_finish_boundary(history):
    s=source(execution()); s['coverage_from']=105
    s['outputs']=[{'id':'doc','job_id':'job','at':109,'text':'Newer retained response'}]
    s['sessions']=[{'id':'older-session','job_id':'job','started_at':102}]
    history.sync(None,s)
    row=history.detail(None,'job','run-1')
    assert row['output']=='Newer retained response' and not row.get('session_id')


def test_replaced_output_hash_keeps_only_current_association(history):
    s=source(execution())
    for index in range(12):
        s['outputs']=[{'id':f'doc-{index}','job_id':'job','at':109,'text':f'Observed revision {index}'}]
        history.sync(None,s)
    assert history.detail(None,'job','run-1')['output_id']=='doc-11'
    assert history.db.execute('SELECT COUNT(*) FROM routine_history_outputs').fetchone()[0]==1
