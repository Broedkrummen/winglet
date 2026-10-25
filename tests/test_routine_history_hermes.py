"""Provider-free integration with the CI-pinned Hermes scheduler and SQLite ledger."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

executions=pytest.importorskip('cron.executions')
from cron import jobs
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from plugin import hermes_api
from plugin.routine_history import RoutineHistory


@pytest.fixture
def profile(tmp_path,monkeypatch):
    home=tmp_path/'synthetic-profile'; home.mkdir()
    monkeypatch.setenv('HERMES_HOME',str(home))
    monkeypatch.setenv('HERMES_DISABLE_LAZY_INSTALLS','1')
    monkeypatch.setattr(executions,'EXECUTIONS_FILE',None)
    token=set_hermes_home_override(home)
    with jobs.use_cron_store(home):
        try: yield home
        finally: reset_hermes_home_override(token)


def test_real_ledger_claim_running_finish_and_readonly_source(profile):
    job=jobs.create_job('Synthetic prompt','every 1h',name='Ledger test',deliver='local')
    run=executions.create_execution(job['id'],source='builtin',scheduled_instant='2026-10-25T10:00:00Z')
    first=hermes_api.routine_history_source(job['id'])
    assert first['executions'][0]['id']==run['id'] and first['executions'][0]['status']=='claimed'
    executions.mark_execution_running(run['id'])
    db=SessionDB(db_path=profile/'state.db')
    session_id='cron_'+job['id']+'_20261025_100000'
    db.create_session(session_id,source='cron')
    db.close()
    output=jobs.save_job_output(job['id'],'# Cron Job: Ledger test\n\n## Prompt\n\nSynthetic prompt\n\n## Response\n\nSynthetic result')
    executions.finish_execution(run['id'],success=True,delivery_outcome='local')
    before=(profile/'cron/executions.db').read_bytes()
    observed=hermes_api.routine_history_source(job['id'])
    assert (profile/'cron/executions.db').read_bytes()==before
    assert observed['executions'][0]['status']=='completed' and observed['sessions'][0]['id']==session_id
    h=RoutineHistory(profile/'mirror.db')
    try:
        h.sync(None,observed)
        row=h.detail(None,job['id'],run['id'])
        assert row['status']=='completed' and row['session_id']==session_id and 'Synthetic result' in row['output']
        jobs.remove_job(job['id'])
        assert not output.exists()
        h.sync(None,hermes_api.routine_history_source(job['id']))
        assert h.detail(None,job['id'],run['id'])['archived']
        assert 'Synthetic result' in h.detail(None,job['id'],run['id'])['output']
    finally: h.close()


@pytest.mark.parametrize('exit_code,status',[(0,'completed'),(7,'failed')])
def test_actual_scheduler_script_outcome(profile,monkeypatch,exit_code,status):
    from cron import scheduler
    # Dispatch stays in this test process; the real script runner/save/terminal lifecycle runs.
    monkeypatch.setattr(scheduler,'_launch_external_cron_worker',lambda job:False)
    (profile/'scripts').mkdir()
    script=profile/'scripts/synthetic.py'; script.write_text(f"print('synthetic script evidence')\nraise SystemExit({exit_code})\n")
    job=jobs.create_job(None,'every 1h',name='Script test',deliver='local',script=str(script),
                        interpreter=sys.executable,no_agent=True,workdir=str(profile))
    assert scheduler.run_one_job(job)
    observed=hermes_api.routine_history_source(job['id'])
    assert len(observed['executions'])==1
    row=observed['executions'][0]
    assert row['status']==status and row['source']=='direct'
    h=RoutineHistory(profile/'mirror.db')
    try:
        h.sync(None,observed); detail=h.detail(None,job['id'],row['id'])
        assert detail['status']==status and detail['trigger']=='manual'
        assert 'synthetic script evidence' in detail['output']
        assert not detail.get('session_id')
    finally: h.close()


def test_exited_real_owner_is_interrupted_without_rewriting_native_ledger(profile):
    child="from cron.executions import create_execution,mark_execution_running; r=create_execution('crashed',source='direct'); mark_execution_running(r['id']); print(r['id'])"
    result=subprocess.run([sys.executable,'-c',child],env={**os.environ,'HERMES_HOME':str(profile)},
                          capture_output=True,text=True,timeout=30,check=True)
    run_id=result.stdout.strip().splitlines()[-1]
    observed=hermes_api.routine_history_source('crashed')
    assert observed['executions'][0]['owner_gone']
    assert observed['executions'][0]['status']=='running'
    h=RoutineHistory(profile/'mirror.db')
    try:
        h.sync(None,observed)
        assert h.detail(None,'crashed',run_id)['status']=='interrupted'
        assert executions.get_execution(run_id)['status']=='running'
    finally: h.close()


def test_observer_does_not_repair_or_initialize_upstream(profile):
    (profile/'cron').mkdir()
    path=profile/'cron/jobs.json'; path.write_text('{"jobs": "corrupt synthetic shape"}')
    before=path.read_bytes()
    with pytest.raises(hermes_api.HermesUnavailable): hermes_api.routine_history_source()
    assert path.read_bytes()==before and not (profile/'cron/executions.db').exists()
    path.write_text('{"jobs": []}')
    assert hermes_api.routine_history_source()['executions']==[]
    assert not (profile/'cron/executions.db').exists()


def test_artifact_cap_and_path_refusal(profile):
    job=jobs.create_job('Synthetic','every 1h',deliver='local')
    output=jobs.save_job_output(job['id'],'x'*70000+'token=do-not-expose')
    observed=hermes_api.routine_history_source(job['id'])
    assert len(observed['outputs'][0]['text'])==65536 and observed['outputs'][0]['truncated']
    for value in ['../private','bad/path','..','a'*129]:
        with pytest.raises(hermes_api.HermesRefused): hermes_api.routine_history_source(value)


def test_native_terminal_pruning_supplies_trusted_finish_coverage(profile,monkeypatch):
    from datetime import datetime, timezone, timedelta
    monkeypatch.setattr(executions,'MAX_TERMINAL_EXECUTIONS',2)
    base=datetime(2026,10,25,10,0,tzinfo=timezone.utc)
    records=[]
    for index in range(3):
        monkeypatch.setattr(executions,'_hermes_now',lambda index=index:base+timedelta(seconds=index*30))
        row=executions.create_execution('job',source='builtin')
        executions.mark_execution_running(row['id'])
        records.append(executions.finish_execution(row['id'],success=True))
    observed=hermes_api.routine_history_source('job')
    assert {r['id'] for r in observed['executions']}=={r['id'] for r in records[1:]}
    assert observed['complete_executions'] and observed['complete_records']
    assert observed['coverage_from']==records[1]['finished_at']
