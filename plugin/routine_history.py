"""Bounded, bot-scoped mirror of authoritative Hermes execution evidence.

This is an observer, never an executor or retry queue. A request is not a run;
only a scheduler execution id or a surviving output document establishes one.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

MAX_OUTPUT = 64 * 1024
MAX_RUNS = 500
MAX_BOT_RUNS = 5000
TERMINAL = {'completed', 'failed', 'interrupted', 'unknown', 'cancelled'}
_SECRET = re.compile(r"(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?i:bearer)\s+[A-Za-z0-9._-]{8,}|(?i:(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s]+)")
_URL = re.compile(r'(?<=://)[^/\s:@]+:[^/\s@]+@')
_CONTROL = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def clean(value: Any, limit: int) -> str:
    text = _CONTROL.sub('', str(value or '')).replace('\r\n', '\n').replace('\r', '\n')
    return _URL.sub('[redacted]@', _SECRET.sub('[redacted]', text))[:limit]


def instant(value: Any):
    try:
        result = float(value) if isinstance(value, (int, float)) else datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _fingerprint(job: dict) -> str:
    fields = {k: job.get(k) for k in ('name', 'prompt', 'schedule', 'schedule_display', 'script', 'no_agent')}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, default=str).encode()).hexdigest()[:24]


def _definition(job: dict) -> dict:
    return {**{k: job.get(k) for k in ('id', 'name', 'prompt', 'schedule_display', 'enabled', 'state', 'next_run_at', 'last_run_at', 'manual_run_at', 'paused_reason', 'no_agent')},
            'name': clean(job.get('name'), 160), 'prompt': clean(job.get('prompt'), 8000),
            'schedule_display': clean(job.get('schedule_display'), 500),
            'revision': _fingerprint(job)}


def _unique_links(attempts: list[dict], artifacts: list[dict], *, session=False, covered=None) -> dict[str, dict]:
    """Sweep per-job intervals once. Ambiguous overlapping windows have no link."""
    import heapq
    groups = {}
    now = time.time()
    for row in attempts:
        start = instant(row.get('started_at')) or instant(row.get('claimed_at'))
        if start is None: continue
        end = instant(row.get('finished_at')) or now
        groups.setdefault(str(row['job_id']), []).append((start - 1, end + 2, str(row['id'])))
    documents = {}
    for artifact in artifacts:
        stamp = instant(artifact.get('started_at') if session else artifact.get('at'))
        if stamp is not None:
            documents.setdefault(str(artifact['job_id']), []).append((stamp, artifact))
    candidates = {}
    for job_id, items in documents.items():
        windows = sorted(groups.get(job_id, []))
        active, expires, index = set(), [], 0
        for stamp, artifact in sorted(items, key=lambda item: item[0]):
            while index < len(windows) and windows[index][0] <= stamp:
                _, end, run_id = windows[index]; index += 1
                active.add(run_id); heapq.heappush(expires, (end, run_id))
            while expires and expires[0][0] < stamp:
                _, run_id = heapq.heappop(expires); active.discard(run_id)
            if active and covered is not None: covered.add(str(artifact['id']))
            if len(active) == 1:
                candidates.setdefault(next(iter(active)), []).append(artifact)
    return {run_id: items[0] for run_id, items in candidates.items() if len(items) == 1}


class RoutineHistory:
    def __init__(self, path: Path, *, keep_runs=MAX_RUNS, keep_bot_runs=MAX_BOT_RUNS):
        self._lock = threading.RLock()
        self.keep_runs = max(1, int(keep_runs))
        self.keep_bot_runs = max(1, int(keep_bot_runs))
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA busy_timeout=3000')
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS routine_history_routines (
            bot TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
            observed_at REAL NOT NULL, PRIMARY KEY(bot,id));
          CREATE TABLE IF NOT EXISTS routine_history_runs (
            bot TEXT NOT NULL, job_id TEXT NOT NULL, id TEXT NOT NULL, claim REAL NOT NULL,
            body TEXT NOT NULL, terminal INTEGER NOT NULL, PRIMARY KEY(bot,id));
          CREATE TABLE IF NOT EXISTS routine_history_outputs (
            bot TEXT NOT NULL, output_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(bot,output_id));
          CREATE INDEX IF NOT EXISTS routine_history_page ON routine_history_runs(bot,job_id,claim DESC,id DESC);
        """)

    def close(self):
        with self._lock:
            if self.db is not None:
                self.db.close()
                self.db = None

    def sync(self, bot: str | None, source: dict) -> list[dict]:
        """Commit a complete observed source batch. Failures never erase earlier evidence."""
        scope = bot or ''
        jobs = {str(j['id']): j for j in source.get('jobs', []) if j.get('id')}
        rows = [x for x in source.get('executions', []) if x.get('id') and x.get('job_id')]
        coverage = source.get('complete_executions', False)
        covered_outputs = set()
        output_links = _unique_links(rows, source.get('outputs', []), covered=covered_outputs)
        if not coverage or not source.get('complete_outputs', False): output_links = {}
        session_links = _unique_links(rows, source.get('sessions', []), session=True) if coverage and source.get('complete_sessions', False) else {}
        linked_outputs = {x['id'] for x in output_links.values()}
        changed = []
        with self._lock, self.db:
            if source.get('complete_jobs', True):
                self.db.execute('UPDATE routine_history_routines SET archived=1 WHERE bot=?', (scope,))
            for job_id, raw in jobs.items():
                body = _definition(raw)
                body['timezone'] = source.get('timezone') or 'Server local time'
                self.db.execute('INSERT INTO routine_history_routines VALUES(?,?,?,0,?) ON CONFLICT(bot,id) DO UPDATE SET body=excluded.body,archived=0,observed_at=excluded.observed_at',
                                (scope, job_id, json.dumps(body), time.time()))
            for raw in rows:
                run_id, job_id = str(raw['id']), str(raw['job_id'])
                previous = self.db.execute('SELECT body FROM routine_history_runs WHERE bot=? AND id=?', (scope, run_id)).fetchone()
                old = json.loads(previous['body']) if previous else {}
                definition = old.get('definition') or _definition(jobs.get(job_id, {'id': job_id}))
                status = str(raw.get('status') or 'unknown')
                mapped = {'claimed': 'pending', 'running': 'running', 'completed': 'completed', 'failed': 'failed', 'unknown': 'unknown'}.get(status, 'unknown')
                error = clean(raw.get('error'), 2000)
                if raw.get('owner_gone') and mapped in {'running', 'pending'}:
                    mapped = 'interrupted'
                    error = 'Execution owner exited without a durable terminal outcome. Side effects are unknown.'
                if mapped == 'failed' and error.startswith('Interrupted by gateway shutdown'):
                    mapped = 'interrupted'
                if status == 'unknown':
                    error = error or 'The scheduler could not establish an outcome after restart.'
                # The pin explicitly clears scheduled_instant for a manual ticker fire.
                if raw.get('source') == 'direct': trigger = 'manual'
                elif raw.get('source') == 'builtin' and 'scheduled_instant' in raw:
                    trigger = 'scheduled' if raw.get('scheduled_instant') else 'manual'
                else: trigger = 'unknown'
                body = {**old, 'id': run_id, 'routine_id': job_id, 'recorded': True,
                        'status': mapped, 'scheduler_status': status, 'source': raw.get('source'), 'trigger': trigger,
                        'claimed_at': instant(raw.get('claimed_at')), 'started_at': instant(raw.get('started_at')),
                        'finished_at': instant(raw.get('finished_at')), 'scheduled_at': instant(raw.get('scheduled_instant')),
                        'error': error or None, 'delivery_outcome': clean(raw.get('delivery_outcome'), 120) or None,
                        'definition': definition, 'title': definition.get('name') or job_id,
                        'definition_provenance': old.get('definition_provenance') or 'first_observed',
                        'timezone': source.get('timezone') or 'Server local time'}
                output = output_links.get(run_id)
                if output:
                    body.update(output=clean(output.get('text'), MAX_OUTPUT), output_truncated=bool(output.get('truncated')),
                                output_id=output['id'], output_evidence='unique_execution_window')
                    header = re.search(r'^# Cron Job: (.+)$', body['output'], re.M)
                    prompt = re.search(r'\n## Prompt\n\n(.*?)\n\n## ', body['output'], re.S)
                    if header:
                        body['title'] = clean(header[1], 160)
                        body['definition'] = {**definition, 'name': body['title']}
                        body['definition_provenance'] = 'run_output'
                    if prompt:
                        body['definition'] = {**body['definition'], 'prompt': clean(prompt[1], 8000)}
                session = session_links.get(run_id)
                if session: body.update(session_id=str(session['id']), session_evidence='unique_execution_window')
                if old.get('status') in TERMINAL and status in {'claimed', 'running'} and not raw.get('owner_gone'):
                    # A stale observation cannot roll back a terminal mirror row.
                    body = old
                encoded = json.dumps(body, sort_keys=True)
                self.db.execute('INSERT INTO routine_history_runs VALUES(?,?,?,?,?,?) ON CONFLICT(bot,id) DO UPDATE SET body=excluded.body,terminal=excluded.terminal',
                                (scope, job_id, run_id, body.get('claimed_at') or 0, encoded, int(body['status'] in TERMINAL)))
                if body.get('output_id'):
                    self.db.execute('INSERT OR REPLACE INTO routine_history_outputs VALUES(?,?,?)', (scope, body['output_id'], run_id))
                    self.db.execute('DELETE FROM routine_history_runs WHERE bot=? AND id=?', (scope, 'output-' + str(body['output_id'])))
                if encoded != (json.dumps(old, sort_keys=True) if old else ''):
                    changed.append({'type': 'routine.run', 'routine_id': job_id, 'run_id': run_id, 'status': body['status']})
            if source.get('complete_records', False):
                seen = {str(row['id']) for row in rows}
                requested = source.get('routine_id')
                for row in self.db.execute('SELECT id,job_id,body FROM routine_history_runs WHERE bot=? AND terminal=0', (scope,)).fetchall():
                    if row['id'] in seen or (requested is not None and row['job_id'] != requested): continue
                    body = json.loads(row['body'])
                    body.update(status='unknown', error='This execution is no longer in the scheduler ledger. Its final outcome is unavailable.')
                    self.db.execute('UPDATE routine_history_runs SET body=?,terminal=1 WHERE bot=? AND id=?', (json.dumps(body,sort_keys=True),scope,row['id']))
                    changed.append({'type':'routine.run','routine_id':row['job_id'],'run_id':row['id'],'status':'unknown'})
            for output in source.get('outputs', []):
                if output['id'] in linked_outputs: continue
                # A document inside any retained run window is ambiguous evidence,
                # never an additional execution. Previously captured links survive pruning.
                if str(output['id']) in covered_outputs: continue
                if self.db.execute('SELECT 1 FROM routine_history_outputs WHERE bot=? AND output_id=?', (scope, str(output['id']))).fetchone(): continue
                job_id, run_id = str(output['job_id']), 'output-' + str(output['id'])
                # Never call a surviving document a successful execution without a ledger fact.
                body = {'id': run_id, 'routine_id': job_id, 'recorded': False, 'status': 'unknown',
                        'trigger': 'unknown', 'claimed_at': instant(output.get('at')), 'started_at': None, 'finished_at': None,
                        'scheduled_at': None, 'definition': _definition(jobs.get(job_id, {'id': job_id})),
                        'definition_provenance': 'surviving_output', 'title': jobs.get(job_id, {}).get('name') or job_id,
                        'output': clean(output.get('text'), MAX_OUTPUT), 'output_truncated': bool(output.get('truncated')),
                        'output_id': output['id'], 'error': 'Surviving output; the scheduler execution record is unavailable.',
                        'timezone': source.get('timezone') or 'Server local time'}
                self.db.execute('INSERT OR IGNORE INTO routine_history_runs VALUES(?,?,?,?,?,1)',
                                (scope, job_id, run_id, body['claimed_at'] or 0, json.dumps(body)))
            for job_id in {x['job_id'] for x in self.db.execute('SELECT DISTINCT job_id FROM routine_history_runs WHERE bot=?', (scope,))}:
                self.db.execute('INSERT OR IGNORE INTO routine_history_routines VALUES(?,?,?,1,?)',
                                (scope, job_id, json.dumps(_definition({'id': job_id})), time.time()))
                self.db.execute('DELETE FROM routine_history_runs WHERE bot=? AND job_id=? AND terminal=1 AND id IN (SELECT id FROM routine_history_runs WHERE bot=? AND job_id=? AND terminal=1 ORDER BY claim DESC,id DESC LIMIT -1 OFFSET ?)',
                                (scope, job_id, scope, job_id, self.keep_runs))
            self.db.execute('DELETE FROM routine_history_runs WHERE bot=? AND terminal=1 AND id IN (SELECT id FROM routine_history_runs WHERE bot=? AND terminal=1 ORDER BY claim DESC,id DESC LIMIT -1 OFFSET ?)',
                            (scope, scope, self.keep_bot_runs))
            self.db.execute('DELETE FROM routine_history_outputs WHERE bot=? AND run_id NOT IN (SELECT id FROM routine_history_runs WHERE bot=?)', (scope, scope))
            self.db.execute('DELETE FROM routine_history_routines WHERE bot=? AND archived=1 AND id NOT IN (SELECT job_id FROM routine_history_runs WHERE bot=?)', (scope, scope))
        return changed

    def page(self, bot, routine_id, *, limit=30, cursor=None):
        limit = max(1, min(int(limit), 50))
        scope = bot or ''
        params: list = [scope, routine_id]
        after = ''
        if cursor:
            try:
                decoded = json.loads(base64.urlsafe_b64decode(str(cursor) + '=' * (-len(str(cursor)) % 4)))
                if decoded['bot'] != scope or decoded['routine'] != routine_id: raise ValueError()
                stamp, run_id = float(decoded['claim']), str(decoded['id'])
                if not math.isfinite(stamp) or len(run_id) > 250: raise ValueError()
            except Exception as exc: raise ValueError('History cursor is invalid for this routine.') from exc
            after = ' AND (claim < ? OR (claim = ? AND id < ?))'
            params.extend([stamp, stamp, run_id])
        with self._lock:
            routine = self.db.execute('SELECT body,archived FROM routine_history_routines WHERE bot=? AND id=?', (scope, routine_id)).fetchone()
            rows = self.db.execute('SELECT * FROM routine_history_runs WHERE bot=? AND job_id=?' + after + ' ORDER BY claim DESC,id DESC LIMIT ?', (*params, limit + 1)).fetchall()
            if routine is None and not rows: return None
            definition = json.loads(routine['body']) if routine else {'id': routine_id, 'name': routine_id}
            archived = bool(routine['archived']) if routine else True
            items = [self._view(json.loads(row['body']), definition, archived, detail=False) for row in rows[:limit]]
            nxt = None
            if len(rows) > limit:
                row = rows[limit - 1]
                nxt = base64.urlsafe_b64encode(json.dumps({'bot': scope, 'routine': routine_id, 'claim': row['claim'], 'id': row['id']}).encode()).decode().rstrip('=')
            return {'routine': definition, 'archived': archived, 'runs': items, 'next_cursor': nxt,
                    'retention': {'per_routine': self.keep_runs, 'per_bot': self.keep_bot_runs},
                    'history_notice': 'Only retained execution evidence is shown. Earlier runs may be unavailable.'}

    def detail(self, bot, routine_id, run_id):
        with self._lock:
            row = self.db.execute('SELECT body FROM routine_history_runs WHERE bot=? AND job_id=? AND id=?', (bot or '', routine_id, run_id)).fetchone()
            if row is None: return None
            routine = self.db.execute('SELECT body,archived FROM routine_history_routines WHERE bot=? AND id=?', (bot or '', routine_id)).fetchone()
            current = json.loads(routine['body']) if routine else None
            return self._view(json.loads(row['body']), current, bool(routine['archived']) if routine else True, detail=True)

    @staticmethod
    def _view(body, current, archived, *, detail):
        out = dict(body)
        out['archived'] = archived
        out['definition_changed'] = bool(current and body.get('definition', {}).get('revision') != current.get('revision'))
        out['has_output'] = bool(body.get('output'))
        out['duration_seconds'] = max(0, body['finished_at'] - (body.get('started_at') or body.get('claimed_at') or body['finished_at'])) if body.get('finished_at') else None
        if not detail:
            out['summary'] = clean(body.get('output') or body.get('error'), 180).replace('\n', ' ')
            out.pop('output', None)
            out.pop('definition', None)
        return out

    def archived(self, bot):
        with self._lock:
            rows = self.db.execute('SELECT body FROM routine_history_routines WHERE bot=? AND archived=1 ORDER BY observed_at DESC LIMIT 100', (bot or '',)).fetchall()
            return [json.loads(x['body']) for x in rows]

    def archive(self, bot, job_id):
        with self._lock, self.db:
            self.db.execute('UPDATE routine_history_routines SET archived=1 WHERE bot=? AND id=?', (bot or '', job_id))

    def delivery_run(self, bot, job_id, text):
        """Exact retained response evidence only; repeated content is ambiguous.

        Upstream delivery metadata contains a job id, not an execution id. A sole
        running attempt does not prove that a delayed delivery belongs to it.
        """
        target = clean(text, MAX_OUTPUT).strip()
        if not target: return None
        with self._lock:
            rows = self.db.execute('SELECT id,body FROM routine_history_runs WHERE bot=? AND job_id=?', (bot or '', job_id)).fetchall()
            matches = []
            for row in rows:
                body = json.loads(row['body'])
                if not body.get('recorded') or body.get('output_truncated'): continue
                output = body.get('output') or ''
                response = re.search(r'\n## (?:Response|Output|Script Output)\n\n(.*)\Z', output, re.S)
                if response and response[1].strip() == target: matches.append(row['id'])
            return matches[0] if len(matches) == 1 else None
