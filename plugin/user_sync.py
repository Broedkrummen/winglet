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
CREATE TABLE IF NOT EXISTS sync_preset_versions (
    group_id TEXT NOT NULL, record_id TEXT NOT NULL, version TEXT NOT NULL, definition TEXT NOT NULL,
    PRIMARY KEY(group_id, record_id, version)
);
CREATE TABLE IF NOT EXISTS sync_submissions (
    group_id TEXT NOT NULL, record_id TEXT NOT NULL, generation TEXT NOT NULL,
    submission_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(group_id, record_id, generation)
);
CREATE TABLE IF NOT EXISTS sync_blobs (
    group_id TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL, name TEXT NOT NULL,
    mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(group_id,id)
);
CREATE TABLE IF NOT EXISTS sync_blob_refs (
    group_id TEXT NOT NULL, record_id TEXT NOT NULL, blob_id TEXT NOT NULL,
    PRIMARY KEY(group_id,record_id,blob_id)
);
CREATE TABLE IF NOT EXISTS sync_submission_blobs (
    group_id TEXT NOT NULL, submission_id TEXT NOT NULL, blob_id TEXT NOT NULL,
    PRIMARY KEY(group_id,submission_id,blob_id)
);
CREATE TABLE IF NOT EXISTS sync_submission_payloads (
    group_id TEXT NOT NULL, submission_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(group_id,submission_id)
);
CREATE TABLE IF NOT EXISTS sync_submission_receipts (
    group_id TEXT NOT NULL, submission_id TEXT NOT NULL, receipt TEXT NOT NULL,
    device_id TEXT NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(group_id,submission_id)
);
CREATE TABLE IF NOT EXISTS sync_blob_usage (
    group_id TEXT NOT NULL, blob_id TEXT NOT NULL, device_id TEXT NOT NULL,
    size INTEGER NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(group_id,blob_id)
);
CREATE TABLE IF NOT EXISTS sync_submission_file_releases (
    group_id TEXT NOT NULL, submission_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(group_id,submission_id)
);
"""

KINDS = frozenset({'preferences', 'draft', 'organization', 'bookmark', 'preset', 'read_position'})
MAX_BYTES = 256 * 1024
BLOB_FIELDS = ('id', 'sha256', 'name', 'mime', 'kind', 'size')
DRAFT_CONTENT = frozenset({'text', 'files', 'files_ready', 'reply', 'send_prefix', 'server_id', 'chat_id', 'server_fingerprint'})


def _draft_content(fields):
    return _json({key: [{k: candidate[k] for k in ('deleted', 'value') if k in candidate}
                        for candidate in field['candidates']]
                  for key, field in fields.items() if key in DRAFT_CONTENT})


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
        with self.store.transaction():
            yield self.store._db

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

    def preset_version(self, group, device, record_id, version):
        _identifier(record_id)
        _identifier(version)
        with self._transaction() as db:
            self._member(db, group, device)
            row = db.execute('SELECT definition FROM sync_preset_versions WHERE group_id=? AND record_id=? AND version=?',
                             (group, record_id, version)).fetchone()
            if not row:
                raise SyncError('This preset version is unavailable.', 404)
            return {'definition': json.loads(row['definition'])}

    def groups(self, device):
        with self._transaction() as db:
            return [row['group_id'] for row in db.execute(
                "SELECT m.group_id FROM sync_members m JOIN devices d ON d.id=m.device_id "
                "WHERE m.device_id=? AND m.active=1 AND d.role='owner' ORDER BY m.group_id", (device,))]

    def members(self, group, device):
        with self._transaction() as db:
            self._member(db, group, device)
            return [dict(row) for row in db.execute(
                'SELECT d.id,d.name,d.platform,d.last_seen FROM sync_members m JOIN devices d ON d.id=m.device_id '
                "WHERE m.group_id=? AND m.active=1 AND d.role='owner' ORDER BY d.name,d.id", (group,))]

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

    def submissions(self, group, device, after=''):
        if not isinstance(after, str) or len(after) > 160:
            raise SyncError('Invalid submission cursor.')
        with self._transaction() as db:
            self._member(db, group, device)
            rows = db.execute('SELECT s.submission_id,s.record_id,s.created_at,p.payload,'
                'EXISTS(SELECT 1 FROM sync_submission_receipts r WHERE r.group_id=s.group_id AND r.submission_id=s.submission_id) AS delivered,'
                'EXISTS(SELECT 1 FROM sync_submission_file_releases f WHERE f.group_id=s.group_id AND f.submission_id=s.submission_id) AS released '
                'FROM sync_submissions s JOIN sync_submission_payloads p ON p.group_id=s.group_id AND p.submission_id=s.submission_id '
                'WHERE s.group_id=? AND s.submission_id>? ORDER BY s.submission_id LIMIT 21', (group, after)).fetchall()
            result = []
            for row in rows[:20]:
                payload = json.loads(row['payload'])
                def value(key, fallback):
                    field = payload.get(key, {})
                    return fallback if field.get('deleted', True) else field.get('value', fallback)
                text = value('text', '')
                result.append({'id': row['submission_id'], 'record_id': row['record_id'], 'created_at': row['created_at'],
                    'server_id': value('server_id', ''), 'chat_id': value('chat_id', ''),
                    'preview': text[:240] if isinstance(text, str) else '', 'files': value('files', []),
                    'delivery_confirmed': bool(row['delivered']), 'files_released': bool(row['released'])})
            return {'submissions': result, 'next': rows[19]['submission_id'] if len(rows) > 20 else None}

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
            ready = values.get('files_ready')
            if ready and not ready['deleted'] and ready.get('value') is not True:
                raise SyncError('Finish preparing the draft attachments before sending.', 409)
            generation = values.get('generation', {})
            if generation.get('deleted', True):
                raise SyncError('The draft needs a submission generation.')
            generation = _identifier(generation.get('value'))
            snapshot = {key: {k: value[k] for k in ('deleted', 'value') if k in value} for key, value in values.items()}
            fingerprint = hashlib.sha256(_json(snapshot).encode()).hexdigest()
            existing = db.execute('SELECT submission_id,fingerprint FROM sync_submissions '
                                  'WHERE group_id=? AND record_id=? AND generation=?',
                                  (group, record_id, generation)).fetchone()
            if existing:
                if existing['fingerprint'] != fingerprint:
                    raise SyncError('This draft generation was already submitted with different content. '
                                    'Start a new draft generation to send the edited message.', 409)
                result = {'submission_id': existing['submission_id'], 'revision': expected_revision}
                settled = db.execute('SELECT receipt FROM sync_submission_receipts WHERE group_id=? AND submission_id=?',
                                     (group, existing['submission_id'])).fetchone()
                if settled:
                    result['receipt'] = json.loads(settled['receipt'])
                if db.execute('SELECT 1 FROM sync_submission_file_releases WHERE group_id=? AND submission_id=?',
                              (group, existing['submission_id'])).fetchone():
                    result['files_released'] = True
                return result
            submission = str(uuid.uuid4())
            db.execute('INSERT INTO sync_submissions VALUES (?,?,?,?,?,?)',
                       (group, record_id, generation, submission, fingerprint, time.time()))
            db.execute('INSERT INTO sync_submission_payloads VALUES (?,?,?)', (group, submission, _json(snapshot)))
            for blob_id in self._file_refs(db, group, record['fields']):
                db.execute('INSERT INTO sync_submission_blobs VALUES (?,?,?)', (group, submission, blob_id))
            return {'submission_id': submission, 'revision': expected_revision}

    def settle_submission(self, group, device, record_id, submission_id, receipt):
        """A linked device confirms its target message; this is not remote server attestation."""
        if not isinstance(receipt, dict) or set(receipt) != {'server_id', 'chat_id', 'message_id', 'client_id'}:
            raise SyncError('Expected a target message receipt.')
        for value in receipt.values():
            _identifier(value)
        if receipt['client_id'] != submission_id:
            raise SyncError('The receipt does not identify this submission.', 409)
        encoded = _json(receipt)
        with self._transaction() as db:
            self._member(db, group, device)
            row = db.execute('SELECT p.payload FROM sync_submission_payloads p JOIN sync_submissions s '
                'ON s.group_id=p.group_id AND s.submission_id=p.submission_id '
                'WHERE s.group_id=? AND s.record_id=? AND s.submission_id=?', (group, record_id, submission_id)).fetchone()
            if not row:
                raise SyncError('This submission snapshot is unavailable.', 404)
            payload = json.loads(row['payload'])
            for key in ('server_id', 'chat_id'):
                field = payload.get(key, {})
                if field.get('deleted', True) or field.get('value') != receipt[key]:
                    raise SyncError('The receipt belongs to a different target.', 409)
            previous = db.execute('SELECT receipt FROM sync_submission_receipts WHERE group_id=? AND submission_id=?',
                                  (group, submission_id)).fetchone()
            if previous and previous['receipt'] != encoded:
                raise SyncError('A different target receipt was already recorded.', 409)
            if not previous:
                db.execute('INSERT INTO sync_submission_receipts VALUES (?,?,?,?,?)',
                           (group, submission_id, encoded, device, time.time()))
            db.execute('DELETE FROM sync_submission_blobs WHERE group_id=? AND submission_id=?', (group, submission_id))
            return {'status': 'linked_device_confirmed', 'receipt': receipt}

    def release_submission_files(self, group, device, record_id, submission_id, confirmation):
        """Explicitly discard source retention; this never cancels work or authorizes a new run."""
        if confirmation != 'release-retained-files-without-confirmed-delivery':
            raise SyncError('Explicit confirmation is required to release unconfirmed source files.')
        with self._transaction() as db:
            self._member(db, group, device)
            if not db.execute('SELECT 1 FROM sync_submissions WHERE group_id=? AND record_id=? AND submission_id=?',
                              (group, record_id, submission_id)).fetchone():
                raise SyncError('This submission is unavailable.', 404)
            db.execute('INSERT OR IGNORE INTO sync_submission_file_releases VALUES (?,?,?,?)',
                       (group, submission_id, device, time.time()))
            db.execute('DELETE FROM sync_submission_blobs WHERE group_id=? AND submission_id=?', (group, submission_id))
            return {'files_released': True, 'execution_cancelled': False}

    @staticmethod
    def _file_refs(db, group, fields):
        ids = set()
        for candidate in fields.get('files', {}).get('candidates', []):
            if candidate['deleted']:
                continue
            files = candidate.get('value')
            if not isinstance(files, list) or len(files) > 20:
                raise SyncError('A draft can share at most 20 files.')
            slots = set()
            for item in files:
                if not isinstance(item, dict) or set(item) != {*BLOB_FIELDS, 'slot'}:
                    raise SyncError('Invalid shared file metadata.')
                if type(item['size']) is not int or item['size'] <= 0:
                    raise SyncError('Invalid shared file size.')
                slot = _identifier(item['slot'])
                blob_id = _identifier(item['id'])
                row = db.execute('SELECT * FROM sync_blobs WHERE group_id=? AND id=?', (group, blob_id)).fetchone()
                if not row or any(item[key] != row[key] for key in BLOB_FIELDS):
                    raise SyncError('A shared file is unavailable. Keep your local file and upload it again.', 409)
                if slot in slots:
                    raise SyncError('Each shared file needs its own draft slot.')
                slots.add(slot)
                ids.add(blob_id)
        return ids

    @staticmethod
    def _read(db, group, kind, record_id):
        if kind not in KINDS:
            raise SyncError('Unsupported sync record kind.')
        _identifier(record_id)
        row = db.execute('SELECT revision,state FROM sync_records WHERE group_id=? AND kind=? AND record_id=?',
                         (group, kind, record_id)).fetchone()
        return {'revision': row['revision'], 'fields': json.loads(row['state'])} if row else {'revision': 0, 'fields': {}}

    def write(self, group, device, kind, record_id, *, operation_id, base_revision, changes, resolve=False, base_fields=None):
        _identifier(operation_id)
        if type(resolve) is not bool:
            raise SyncError('Invalid resolution flag.')
        if type(base_revision) is not int or base_revision < 0:
            raise SyncError('Invalid base revision.')
        if not isinstance(changes, dict) or not 1 <= len(changes) <= 100:
            raise SyncError('Expected 1 to 100 changed fields.')
        if base_fields is not None and (not isinstance(base_fields, dict) or set(base_fields) != set(changes)
                or any(type(v) is not int or not 0 <= v <= base_revision for v in base_fields.values())):
            raise SyncError('Expected a base revision for each changed field.')
        for field, value in changes.items():
            _identifier(field)
            if field in {'__proto__', 'prototype', 'constructor'}:
                raise SyncError('Reserved sync field name.')
            if not isinstance(value, dict) or set(value) - {'value', 'deleted'} or type(value.get('deleted')) is not bool:
                raise SyncError('Each field needs a deleted flag and optional JSON value.')
            if (not value['deleted'] and 'value' not in value) or (value['deleted'] and 'value' in value):
                raise SyncError('Deleted fields cannot carry a value; live fields require one.')
            if kind == 'preset':
                if field not in {'definition', 'removed'}:
                    raise SyncError('Invalid task preset field.')
                if not value['deleted']:
                    if field == 'removed':
                        if type(value['value']) is not bool:
                            raise SyncError('Invalid preset removal flag.')
                    else:
                        from .presets import validate_definition
                        try:
                            validate_definition(value['value'])
                        except ValueError as exc:
                            raise SyncError(str(exc)) from exc
            if kind == 'bookmark':
                if field not in {'source', 'snapshot', 'title', 'note', 'tags', 'removed'}:
                    raise SyncError('Invalid bookmark field. Source text and credentials stay on the source server.')
                if not value['deleted']:
                    item = value['value']
                    if field == 'source':
                        if not isinstance(item, dict) or set(item) != {'server_id', 'server_fingerprint', 'chat_id', 'message_id'}:
                            raise SyncError('A bookmark needs its exact source identity.')
                        for part in item.values():
                            _identifier(part)
                    elif field == 'snapshot':
                        if not isinstance(item, dict) or set(item) != {'id', 'sha256'}:
                            raise SyncError('A bookmark snapshot contains only a source-local reference.')
                        _identifier(item['id'])
                        if not isinstance(item['sha256'], str) or len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256']):
                            raise SyncError('Invalid bookmark snapshot hash.')
                    elif field in {'title', 'note'}:
                        if not isinstance(item, str) or len(item) > (160 if field == 'title' else 8000):
                            raise SyncError('Bookmark title or note is too long.')
                    elif field == 'tags':
                        if not isinstance(item, list) or len(item) > 20 or any(not isinstance(tag, str) or not 1 <= len(tag) <= 64 for tag in item):
                            raise SyncError('Use at most 20 bookmark tags of 1–64 characters.')
                    elif type(item) is not bool:
                        raise SyncError('Invalid bookmark removal flag.')
            if kind == 'read_position':
                if field not in {'watermark', 'resume', 'server_id', 'server_fingerprint', 'chat_id'}:
                    raise SyncError('Invalid reading-state field.')
                item = value.get('value')
                if field == 'watermark' and (value['deleted'] or type(item) is not int or not 0 <= item <= 9007199254740991):
                    raise SyncError('Read progress requires a nonnegative safe integer and cannot be deleted.')
                if field == 'resume' and not value['deleted']:
                    if not isinstance(item, dict) or set(item) not in ({'message_id'}, {'message_id', 'position'}):
                        raise SyncError('Invalid reading resume anchor.')
                    _identifier(item['message_id'])
                    if 'position' in item and (type(item['position']) is not int or not 1 <= item['position'] <= 9007199254740991):
                        raise SyncError('Invalid reading resume position.')
                if field in {'server_id', 'server_fingerprint', 'chat_id'}:
                    if value['deleted']:
                        raise SyncError('Reading identity cannot be deleted.')
                    _identifier(item)
        payload = [kind, record_id, base_revision, changes, resolve]
        if base_fields is not None:
            payload.append(base_fields)
        fingerprint = hashlib.sha256(_json(payload).encode()).hexdigest()
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
            definition = changes.get('definition') if kind == 'preset' else None
            if definition and not definition['deleted']:
                value = definition['value']
                encoded = _json(value)
                prior = db.execute('SELECT definition FROM sync_preset_versions WHERE group_id=? AND record_id=? AND version=?',
                                   (group, record_id, value['version'])).fetchone()
                if prior and prior['definition'] != encoded:
                    raise SyncError('This preset version already has different contents. Create a new version.', 409)
                if not prior:
                    count = db.execute('SELECT COUNT(*) FROM sync_preset_versions WHERE group_id=?', (group,)).fetchone()[0]
                    if count >= 10000:
                        raise SyncError('This sync group has reached its 10,000 preset-version limit. Existing versions are kept.', 413)
                    db.execute('INSERT INTO sync_preset_versions VALUES (?,?,?,?)', (group, record_id, value['version'], encoded))
            revision = record['revision'] + 1
            old_content = _draft_content(record['fields']) if kind == 'draft' else None
            old_generation = record['fields'].get('generation')
            for field, value in changes.items():
                old = record['fields'].get(field)
                if kind == 'read_position' and field == 'watermark':
                    history = old['candidates'] if old else []
                    if any(c['deleted'] or type(c.get('value')) is not int or not 0 <= c['value'] <= 9007199254740991 for c in history):
                        raise SyncError('Invalid saved read progress. Keep the record for recovery.')
                    previous = max(history, key=lambda c: c['value'], default=None)
                    if previous and previous['value'] >= value['value']:
                        if len(history) > 1:
                            record['fields'][field] = {'revision': revision, 'candidates': [previous]}
                        continue
                    record['fields'][field] = {'revision': revision, 'candidates': [{**value, 'device_id': device,
                        'operation_id': operation_id, 'at': time.time()}]}
                    continue
                if old and not resolve and any(_json({k: c[k] for k in ('value', 'deleted') if k in c}) == _json(value)
                                               for c in old['candidates']):
                    # Repeating an observed value is not a new edit or conflict-resolution authority.
                    continue
                candidate = {**value, 'device_id': device, 'operation_id': operation_id, 'at': time.time()}
                field_base = base_fields[field] if base_fields is not None else base_revision
                if old and not resolve and (old['revision'] > field_base or len(old['candidates']) > 1):
                    candidates = old['candidates'] + [candidate]
                else:
                    candidates = [candidate]
                record['fields'][field] = {'revision': revision, 'candidates': candidates}
            if kind == 'draft':
                generation = record['fields'].get('generation')
                claimed = False
                if old_generation and generation == old_generation and len(generation['candidates']) == 1:
                    previous_generation = generation['candidates'][0]
                    if not previous_generation['deleted']:
                        claimed = db.execute('SELECT 1 FROM sync_submissions WHERE group_id=? AND record_id=? AND generation=?',
                            (group, record_id, previous_generation['value'])).fetchone() is not None
                unambiguous = all(len(field['candidates']) == 1 for key, field in record['fields'].items() if key in DRAFT_CONTENT)
                if generation is None or (claimed and unambiguous and old_content != _draft_content(record['fields'])):
                    record['fields']['generation'] = {'revision': revision, 'candidates': [{
                        'deleted': False, 'value': str(uuid.uuid4()), 'device_id': device,
                        'operation_id': operation_id, 'at': time.time()}]}
            if len(record['fields']) > 100:
                raise SyncError('A sync record can contain at most 100 fields.', 413)
            record['revision'] = revision
            if kind == 'draft':
                file_refs = self._file_refs(db, group, record['fields'])
                db.execute('DELETE FROM sync_blob_refs WHERE group_id=? AND record_id=?', (group, record_id))
                for blob_id in file_refs:
                    db.execute('INSERT INTO sync_blob_refs VALUES (?,?,?)', (group, record_id, blob_id))
            state = _json(record['fields'])
            result = _json(record)
            db.execute('INSERT INTO sync_records VALUES (?,?,?,?,?) ON CONFLICT(group_id,kind,record_id) '
                       'DO UPDATE SET revision=excluded.revision,state=excluded.state',
                       (group, kind, record_id, revision, state))
            db.execute('INSERT INTO sync_operations VALUES (?,?,?,?,?)',
                       (group, device, operation_id, fingerprint, result))
            return record
