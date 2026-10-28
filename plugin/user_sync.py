"""Private personal-state storage. Conflicting fields require explicit resolution.

This is composition storage, never an executable outbox. Callers authenticate the
device before invoking the service; membership is checked again on every read/write.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
import uuid
from contextlib import contextmanager

from .store import Store


class SyncError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sync_groups (id TEXT PRIMARY KEY, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sync_members (
    group_id TEXT NOT NULL, device_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(group_id, device_id)
);
CREATE TABLE IF NOT EXISTS sync_invites (
    digest TEXT PRIMARY KEY, group_id TEXT NOT NULL, expires_at REAL NOT NULL,
    issued_by TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_records (
    group_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
    revision INTEGER NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(group_id, kind, record_id)
);
CREATE TABLE IF NOT EXISTS sync_operations (
    group_id TEXT NOT NULL, device_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(group_id, device_id, operation_id)
);
CREATE TABLE IF NOT EXISTS sync_submissions (
    group_id TEXT NOT NULL, record_id TEXT NOT NULL, generation TEXT NOT NULL,
    submission_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(group_id, record_id, generation)
);
"""

KINDS = frozenset({'preferences', 'draft', 'organization', 'bookmark', 'preset', 'read_position'})
MAX_BYTES = 256 * 1024


def _json(value):
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise SyncError('Expected finite JSON data.') from exc
    if len(encoded.encode()) > MAX_BYTES:
        raise SyncError('Sync record is too large.', 413)
    return encoded


def _identifier(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 160 or any(ord(c) < 32 for c in value):
        raise SyncError('Invalid sync identifier.')
    return value


class UserSync:
    def __init__(self, store: Store):
        self.store = store
        with store._lock:
            store._db.executescript(_SCHEMA)

    @contextmanager
    def _transaction(self):
        with self.store._lock:
            db = self.store._db
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
            except BaseException:
                db.rollback()
                raise
            else:
                db.commit()

    @staticmethod
    def _member(db, group, device):
        # Device deletion revokes access even before sync membership is cleaned up.
        row = db.execute('SELECT 1 FROM sync_members m JOIN devices d ON d.id=m.device_id '
                         "WHERE m.group_id=? AND m.device_id=? AND m.active=1 AND d.role='owner'", (group, device)).fetchone()
        if not row:
            raise SyncError('This device is not linked to that sync home.', 403)

    def create(self, device):
        with self._transaction() as db:
            if not db.execute("SELECT 1 FROM devices WHERE id=? AND role='owner'", (device,)).fetchone():
                raise SyncError('Pair this device first.', 403)
            if db.execute('SELECT COUNT(*) FROM sync_members WHERE device_id=? AND active=1', (device,)).fetchone()[0] >= 5:
                raise SyncError('This device already has five sync groups.', 409)
            group = str(uuid.uuid4())
            db.execute('INSERT INTO sync_groups VALUES (?,?)', (group, time.time()))
            db.execute('INSERT INTO sync_members VALUES (?,?,1)', (group, device))
            return {'group_id': group}

    def invite(self, group, device):
        with self._transaction() as db:
            self._member(db, group, device)
            token = secrets.token_urlsafe(32)
            expires = time.time() + 600
            db.execute('INSERT INTO sync_invites VALUES (?,?,?,?,0)',
                       (hashlib.sha256(token.encode()).hexdigest(), group, expires, device))
            return {'token': token, 'expires_at': expires}

    def join(self, device, token):
        if not isinstance(token, str) or len(token) > 128:
            raise SyncError('Invalid sync invitation.')
        with self._transaction() as db:
            invite = db.execute('SELECT * FROM sync_invites WHERE digest=?',
                                (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
            if not invite or invite['used'] or invite['expires_at'] <= time.time():
                raise SyncError('Sync invitation expired or already used.', 409)
            self._member(db, invite['group_id'], invite['issued_by'])
            if not db.execute("SELECT 1 FROM devices WHERE id=? AND role='owner'", (device,)).fetchone():
                raise SyncError('Pair this device first.', 403)
            db.execute('INSERT INTO sync_members VALUES (?,?,1) ON CONFLICT(group_id,device_id) '
                       'DO UPDATE SET active=1', (invite['group_id'], device))
            db.execute('UPDATE sync_invites SET used=1 WHERE digest=?', (invite['digest'],))
            return {'group_id': invite['group_id']}

    def revoke(self, group, device, target):
        _identifier(target)
        with self._transaction() as db:
            self._member(db, group, device)
            db.execute('UPDATE sync_members SET active=0 WHERE group_id=? AND device_id=?', (group, target))
            db.execute('UPDATE sync_invites SET used=1 WHERE group_id=? AND issued_by=?', (group, target))

    def read(self, group, device, kind, record_id):
        with self._transaction() as db:
            self._member(db, group, device)
            return self._read(db, group, kind, record_id)

    def groups(self, device):
        with self._transaction() as db:
            return [row['group_id'] for row in db.execute(
                "SELECT m.group_id FROM sync_members m JOIN devices d ON d.id=m.device_id "
                "WHERE m.device_id=? AND m.active=1 AND d.role='owner' ORDER BY m.group_id", (device,))]

    def listing(self, group, device, after_kind='', after_id=''):
        if not isinstance(after_kind, str) or not isinstance(after_id, str) or len(after_kind) > 160 or len(after_id) > 160:
            raise SyncError('Invalid sync cursor.')
        with self._transaction() as db:
            self._member(db, group, device)
            rows = db.execute('SELECT kind,record_id,revision,state FROM sync_records WHERE group_id=? '
                              'AND (kind,record_id)>(?,?) ORDER BY kind,record_id LIMIT 101',
                              (group, after_kind, after_id)).fetchall()
            return {'records': [{'kind': r['kind'], 'id': r['record_id'], 'revision': r['revision'],
                                 'fields': json.loads(r['state'])} for r in rows[:100]],
                    'next': {'kind': rows[99]['kind'], 'id': rows[99]['record_id']} if len(rows) > 100 else None}

    def claim_submission(self, group, device, record_id, expected_revision):
        """Return one stable send ID for an explicitly submitted draft generation.

        The client must use this ID in the target chat's existing idempotent send.
        Claiming does not enqueue or execute anything on either server.
        """
        if type(expected_revision) is not int or expected_revision < 1:
            raise SyncError('Invalid draft revision.')
        with self._transaction() as db:
            self._member(db, group, device)
            record = self._read(db, group, 'draft', record_id)
            if record['revision'] != expected_revision:
                raise SyncError('Refresh the draft before sending.', 409)
            if any(len(field['candidates']) != 1 for field in record['fields'].values()):
                raise SyncError('Choose the conflicting draft values before sending.', 409)
            values = {key: field['candidates'][0] for key, field in record['fields'].items()}
            generation = values.get('generation', {})
            if generation.get('deleted', True):
                raise SyncError('The draft needs a submission generation.')
            generation = _identifier(generation.get('value'))
            fingerprint = hashlib.sha256(_json({key: {k: value[k] for k in ('deleted', 'value') if k in value}
                for key, value in values.items()}).encode()).hexdigest()
            existing = db.execute('SELECT submission_id,fingerprint FROM sync_submissions '
                                  'WHERE group_id=? AND record_id=? AND generation=?',
                                  (group, record_id, generation)).fetchone()
            if existing:
                if existing['fingerprint'] != fingerprint:
                    raise SyncError('This draft generation was already submitted with different content. '
                                    'Start a new draft generation to send the edited message.', 409)
                return {'submission_id': existing['submission_id'], 'revision': expected_revision}
            submission = str(uuid.uuid4())
            db.execute('INSERT INTO sync_submissions VALUES (?,?,?,?,?,?)',
                       (group, record_id, generation, submission, fingerprint, time.time()))
            return {'submission_id': submission, 'revision': expected_revision}

    @staticmethod
    def _read(db, group, kind, record_id):
        if kind not in KINDS:
            raise SyncError('Unsupported sync record kind.')
        _identifier(record_id)
        row = db.execute('SELECT revision,state FROM sync_records WHERE group_id=? AND kind=? AND record_id=?',
                         (group, kind, record_id)).fetchone()
        return {'revision': row['revision'], 'fields': json.loads(row['state'])} if row else {'revision': 0, 'fields': {}}

    def write(self, group, device, kind, record_id, *, operation_id, base_revision, changes, resolve=False):
        _identifier(operation_id)
        if type(resolve) is not bool:
            raise SyncError('Invalid resolution flag.')
        if type(base_revision) is not int or base_revision < 0:
            raise SyncError('Invalid base revision.')
        if not isinstance(changes, dict) or not 1 <= len(changes) <= 100:
            raise SyncError('Expected 1 to 100 changed fields.')
        for field, value in changes.items():
            _identifier(field)
            if not isinstance(value, dict) or set(value) - {'value', 'deleted'} or type(value.get('deleted')) is not bool:
                raise SyncError('Each field needs a deleted flag and optional JSON value.')
            if (not value['deleted'] and 'value' not in value) or (value['deleted'] and 'value' in value):
                raise SyncError('Deleted fields cannot carry a value; live fields require one.')
        fingerprint = hashlib.sha256(_json([kind, record_id, base_revision, changes, resolve]).encode()).hexdigest()
        with self._transaction() as db:
            self._member(db, group, device)
            previous = db.execute('SELECT fingerprint,result FROM sync_operations WHERE group_id=? AND device_id=? '
                                  'AND operation_id=?', (group, device, operation_id)).fetchone()
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise SyncError('Operation ID was already used for different changes.', 409)
                return json.loads(previous['result'])
            record = self._read(db, group, kind, record_id)
            if base_revision > record['revision'] or (resolve and base_revision != record['revision']):
                raise SyncError('Refresh before resolving these changes.', 409)
            revision = record['revision'] + 1
            for field, value in changes.items():
                old = record['fields'].get(field)
                candidate = {**value, 'device_id': device, 'operation_id': operation_id, 'at': time.time()}
                if old and not resolve and (old['revision'] > base_revision or len(old['candidates']) > 1):
                    candidates = old['candidates'] + [candidate]
                    # Equal values do not require a choice; keep the existing provenance.
                    unique = { _json({k: c[k] for k in ('value', 'deleted') if k in c}) for c in candidates }
                    if len(unique) == 1:
                        candidates = old['candidates']
                else:
                    candidates = [candidate]
                record['fields'][field] = {'revision': revision, 'candidates': candidates}
            record['revision'] = revision
            state = _json(record['fields'])
            result = _json(record)
            db.execute('INSERT INTO sync_records VALUES (?,?,?,?,?) ON CONFLICT(group_id,kind,record_id) '
                       'DO UPDATE SET revision=excluded.revision,state=excluded.state',
                       (group, kind, record_id, revision, state))
            db.execute('INSERT INTO sync_operations VALUES (?,?,?,?,?)',
                       (group, device, operation_id, fingerprint, result))
            return record
