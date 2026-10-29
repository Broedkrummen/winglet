"""Immutable private draft files. No bearer media URLs or remote URL fetching."""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path

from . import uploads
from .user_sync import BLOB_FIELDS, SyncError, UserSync

UNREFERENCED_SECONDS = 86400
GROUP_BYTES = 256 * 1024 * 1024


def _hash(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise SyncError('Invalid file digest.')
    return value


class SyncBlobs:
    def __init__(self, sync: UserSync, root: Path, *, max_file_bytes: int, total_bytes: int, daily_bytes: int):
        self.sync = sync
        self.root = root.resolve()
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = total_bytes
        self.max_daily_bytes = daily_bytes

    def total_bytes(self):
        with self.sync.store._lock:
            return self.sync.store._db.execute('SELECT COALESCE(SUM(size),0) FROM '
                '(SELECT id,MAX(size) AS size FROM sync_blobs GROUP BY id)').fetchone()[0]

    def daily_bytes(self, device, since):
        with self.sync.store._lock:
            return self.sync.store._db.execute('SELECT COALESCE(SUM(size),0) FROM sync_blob_usage '
                'WHERE device_id=? AND created_at>=?', (device, since)).fetchone()[0]

    def put(self, group, device, digest, name, data, voice=False):
        _hash(digest)
        if not data or len(data) > self.max_file_bytes:
            raise SyncError('The shared file is empty or exceeds the per-file upload limit.', 413)
        if hashlib.sha256(data).hexdigest() != digest:
            raise SyncError('The shared file did not match its content digest.')
        name = uploads.safe_name(name)
        mime = uploads.sniff_mime(data[:512], name)
        if voice:
            mime = uploads.voice_mime(mime)
        blob_id = hashlib.sha256(json.dumps([digest, name, bool(voice)], separators=(',', ':')).encode()).hexdigest()
        with self.sync._transaction() as db:
            self.sync._member(db, group, device)
            old = db.execute('SELECT * FROM sync_blobs WHERE group_id=? AND id=?', (group, blob_id)).fetchone()
            since = time.time() - 86400
            used = self.daily_bytes(device, since) + self.sync.store.upload_bytes_since(device, since)
            if used + (0 if old else len(data)) > self.max_daily_bytes:
                raise SyncError("You've reached today's upload limit for this device. Your source file is kept.", 429)
            group_used = db.execute('SELECT COALESCE(SUM(size),0) FROM sync_blobs WHERE group_id=?', (group,)).fetchone()[0]
            exists = db.execute('SELECT 1 FROM sync_blobs WHERE id=?', (blob_id,)).fetchone()
            if group_used + (0 if old else len(data)) > GROUP_BYTES:
                raise SyncError('Your sync home file allowance is full. Keep the local file and free storage before retrying.', 507)
            total = self.total_bytes() + self.sync.store.total_upload_bytes()
            if total + (0 if exists else len(data)) > self.max_total_bytes:
                raise SyncError('The server upload storage is full. Your local file has not been removed.', 507)
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = self.root / f'{uuid.uuid4().hex}.partial'
            try:
                with temporary.open('xb') as out:
                    out.write(data)
                os.chmod(temporary, 0o600)
                os.replace(temporary, self.root / blob_id)
            finally:
                temporary.unlink(missing_ok=True)
            db.execute('INSERT INTO sync_blobs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(group_id,id) '
                       'DO UPDATE SET created_at=excluded.created_at',
                       (group, blob_id, digest, name, mime, uploads.kind_of(mime, voice), len(data), time.time()))
            if not old:
                db.execute('INSERT INTO sync_blob_usage VALUES (?,?,?,?,?) ON CONFLICT(group_id,blob_id) '
                           'DO UPDATE SET device_id=excluded.device_id,size=excluded.size,created_at=excluded.created_at',
                           (group, blob_id, device, len(data), time.time()))
            row = db.execute('SELECT * FROM sync_blobs WHERE group_id=? AND id=?', (group, blob_id)).fetchone()
            return {key: row[key] for key in BLOB_FIELDS}

    def get(self, group, device, blob_id):
        _hash(blob_id)
        with self.sync._transaction() as db:
            self.sync._member(db, group, device)
            row = db.execute('SELECT * FROM sync_blobs WHERE group_id=? AND id=?', (group, blob_id)).fetchone()
            file_path = self.root / blob_id
            if not row or not file_path.is_file():
                raise SyncError('This shared file is unavailable. Keep the original and upload it again.', 404)
            return {key: row[key] for key in BLOB_FIELDS}, file_path

    def sweep(self, now=None):
        removed = 0
        with self.sync._transaction() as db:
            rows = db.execute('SELECT group_id,id FROM sync_blobs WHERE created_at<?',
                              ((time.time() if now is None else now) - UNREFERENCED_SECONDS,)).fetchall()
            for row in rows:
                scope = (row['group_id'], row['id'])
                # The same transaction excludes a concurrent draft write or submission claim.
                pinned = db.execute('SELECT 1 FROM sync_blob_refs WHERE group_id=? AND blob_id=? '
                    'UNION ALL SELECT 1 FROM sync_submission_blobs WHERE group_id=? AND blob_id=? LIMIT 1', (*scope, *scope)).fetchone()
                if pinned:
                    continue
                others = db.execute('SELECT 1 FROM sync_blobs WHERE id=? AND group_id!=?', (row['id'], row['group_id'])).fetchone()
                if not others:
                    (self.root / _hash(row['id'])).unlink(missing_ok=True)
                db.execute('DELETE FROM sync_blobs WHERE group_id=? AND id=?', scope)
                removed += 1
            # Recover bytes left by a process exit between atomic file replacement and DB commit.
            if self.root.is_dir():
                for file_path in self.root.iterdir():
                    if not re.fullmatch(r'(?:[0-9a-f]{64}|[0-9a-f]{32}\.partial)', file_path.name) or not file_path.is_file():
                        continue
                    if file_path.stat().st_mtime >= (time.time() if now is None else now) - UNREFERENCED_SECONDS:
                        continue
                    if not db.execute('SELECT 1 FROM sync_blobs WHERE id=?', (file_path.name,)).fetchone():
                        file_path.unlink()
            db.execute('DELETE FROM sync_blob_usage WHERE created_at<?', ((time.time() if now is None else now) - 86400,))
        return removed
