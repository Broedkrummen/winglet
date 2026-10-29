"""Copy verified bytes into this device's target chat without trusting another server."""
import hashlib
import shutil
import time

from . import uploads
from .store import new_id
from .sync_blobs import _hash
from .user_sync import SyncError, _identifier


def materialize(hub, device, chat, source_id, slot, digest, name, data, voice=False):
    _hash(source_id)
    _hash(digest)
    _identifier(slot)
    if not data or len(data) > hub.max_upload_bytes:
        raise SyncError('The shared file is empty or exceeds the upload limit.', 413)
    if hashlib.sha256(data).hexdigest() != digest:
        raise SyncError('The shared file did not match its content digest.')
    name = uploads.safe_name(name)
    mime = uploads.sniff_mime(data[:512], name)
    if voice:
        mime = uploads.voice_mime(mime)
    kind = uploads.kind_of(mime, voice)
    hold_id = 'sync:' + hashlib.sha256(f'{source_id}\0{slot}'.encode()).hexdigest()
    with hub.store.transaction():
        device = hub.store.get_device(device['id'])
        chat = hub.store.get_chat(chat['id'])
        if not hub.can_see(device, chat) or device['role'] != 'owner' or not hub._in_bot(chat['id']):
            raise SyncError('This target chat is no longer available to this owner.', 403)
        prior = hub.store._one('SELECT * FROM sync_materializations WHERE device_id=? AND chat_id=? AND source_id=? AND slot=?',
                               (device['id'], chat['id'], source_id, slot))
        if prior:
            row = hub.store.get_upload(prior['upload_id'])
            if not row or prior['sha256'] != digest or (row['name'], row['mime'], row['kind'], row['size']) != (name, mime, kind, len(data)):
                raise SyncError('This shared file slot was already used for different content.', 409)
            path = hub.media_dir / row['id'] / row['name']
            if not path.is_file():
                raise SyncError('The target copy is missing. Restore that file before retrying.', 409)
            if row['message_id'] is None and not hub.store.hold_uploads([row['id']], device['id'], chat['id'], hold_id):
                raise SyncError('The target copy is held by another message. Keep the shared original and retry.', 409)
            return {**hub._upload_public(row), 'hold_id': hold_id}
        if hub.store.upload_bytes_since(device['id'], time.time() - 86400) + hub.sync_blobs.daily_bytes(device['id'], time.time() - 86400) + len(data) > hub.device_daily_upload_bytes:
            raise SyncError("You've reached today's upload limit for this device.", 429)
        if hub.store.total_upload_bytes() + hub.sync_blobs.total_bytes() + len(data) > hub.total_upload_bytes:
            raise SyncError('The target server upload storage is full. Your shared original is kept.', 507)
        upload_id = new_id()
        directory = hub.media_dir / upload_id
        try:
            directory.mkdir(parents=True, exist_ok=False)
            partial = directory / '.partial'
            partial.write_bytes(data)
            partial.rename(directory / name)
            hub.store.add_upload(upload_id, device['id'], chat['id'], name, mime, kind, len(data))
            hub.store._exec('INSERT INTO sync_materializations VALUES (?,?,?,?,?,?)',
                           (device['id'], chat['id'], source_id, slot, upload_id, digest))
            if not hub.store.hold_uploads([upload_id], device['id'], chat['id'], hold_id):
                raise SyncError('The target copy could not be retained. Your shared original is kept.', 409)
            return {**hub._upload_public(hub.store.get_upload(upload_id)), 'hold_id': hold_id}
        except BaseException:
            # Only this newly generated directory can be removed on a failed copy.
            shutil.rmtree(directory, ignore_errors=True)
            raise
