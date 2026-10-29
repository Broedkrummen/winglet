"""Revocable sync bytes, canonical pins and independently paired target copies."""
import hashlib
import json
import time
from contextlib import contextmanager

import aiohttp
import pytest

from plugin.hub import Hub
from plugin.store import Store
from plugin.user_sync import SyncError
from test_trust import pair_phone

DATA = b'%PDF-1.7\nprivate synthetic draft bytes'
DIGEST = hashlib.sha256(DATA).hexdigest()


@pytest.fixture
def hub(tmp_path):
    store = Store(tmp_path / 'home.db')
    store.ensure_chat('general', 'General')
    value = Hub(store, media_dir=tmp_path / 'media')
    yield value
    store.close()


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def put(client, phone, path, data=DATA):
    return await client.put(path, data=data, headers={**phone.signed('PUT', path, data), 'Content-Type': 'application/octet-stream'})


def write_files(hub, group, phone, blob, revision=0, op='files', deleted=False):
    return hub.user_sync.write(group, phone.id, 'draft', 'general', operation_id=op, base_revision=revision,
        changes={'files': {'deleted': True} if deleted else {'deleted': False, 'value': [{**blob, 'slot': 'file-1'}]},
                 'generation': {'deleted': False, 'value': 'draft-1'}})


def test_target_staging_writes_outside_transaction_and_rechecks_revocation(hub, monkeypatch):
    from plugin import sync_materialize
    device = hub.store.add_device('Desktop')[0]
    hub.store.add_device('Other owner')
    original = sync_materialize.staged_bytes

    @contextmanager
    def revoke_during_bulk_write(root, data):
        assert not hub.store._db.in_transaction
        with original(root, data) as staged:
            hub.store.remove_device(device['id'], keep_an_owner=True)
            yield staged

    monkeypatch.setattr(sync_materialize, 'staged_bytes', revoke_during_bulk_write)
    with pytest.raises(SyncError, match='no longer available'):
        sync_materialize.materialize(hub, device, hub.store.get_chat('general'), DIGEST, 'slot', DIGEST, 'file.pdf', DATA)
    assert hub.store.total_upload_bytes() == 0
    assert not list(hub.media_dir.iterdir())


def test_target_commit_failure_rolls_back_metadata_and_removes_only_its_new_copy(hub, monkeypatch):
    from plugin.sync_materialize import materialize
    device = hub.store.add_device('Desktop')[0]
    connection = hub.store._db

    class FailedCommit:
        def __getattr__(self, name):
            return getattr(connection, name)

        def commit(self):
            raise OSError('synthetic commit failure')

    monkeypatch.setattr(hub.store, '_db', FailedCommit())
    with pytest.raises(OSError, match='synthetic commit failure'):
        materialize(hub, device, hub.store.get_chat('general'), DIGEST, 'slot', DIGEST, 'file.pdf', DATA)
    assert not connection.in_transaction
    assert hub.store.total_upload_bytes() == 0
    assert not list(hub.media_dir.iterdir())


async def test_current_device_retention_is_private_and_stale_release_cannot_remove_a_renewed_hold(client, hub):
    owner = await pair_phone(client, hub, 'Owner')
    other = await pair_phone(client, hub, 'Other owner')
    hub.store.add_upload('current-held', owner.id, 'general', 'file.pdf', 'application/pdf', 'file', len(DATA))
    assert hub.store.hold_uploads(['current-held'], owner.id, 'general', 'current-hold')
    path = '/api/uploads/retained?scope=current'
    listing = await (await client.get(path, headers=owner.auth)).json()
    assert listing['scope'] == 'current'
    first = listing['files'][0]
    assert first['source_device'] == owner.id and first['version']
    assert (await (await client.get(path, headers=other.auth)).json())['files'] == []
    assert (await client.get('/api/uploads/retained?scope=all', headers=owner.auth)).status == 400
    assert hub.store.hold_uploads(['current-held'], owner.id, 'general', 'current-hold')
    release = '/api/chats/general/uploads/hold'
    legacy = json.dumps({'hold_id': first['hold_id']}).encode()
    assert (await client.delete(release, data=legacy, headers=owner.signed('DELETE', release, legacy))).status == 409
    assert hub.store.upload_held('current-held')
    body = json.dumps({'hold_id': first['hold_id'], 'upload_id': first['upload']['id'], 'expected_version': first['version']}).encode()
    assert (await client.delete(release, data=body, headers=owner.signed('DELETE', release, body))).status == 409
    assert hub.store.upload_held('current-held')
    current = (await (await client.get(path, headers=owner.auth)).json())['files'][0]
    body = json.dumps({'hold_id': current['hold_id'], 'upload_id': current['upload']['id'], 'expected_version': current['version']}).encode()
    assert (await client.delete(release, data=body, headers=other.signed('DELETE', release, body))).status == 409
    assert (await client.delete(release, data=body, headers=owner.signed('DELETE', release, body))).status == 200
    assert not hub.store.upload_held('current-held')


def test_legacy_upload_holds_gain_versions_without_losing_existing_retention(tmp_path):
    path = tmp_path / 'legacy.db'
    store = Store(path)
    store._exec('ALTER TABLE upload_holds DROP COLUMN version')
    store._exec('INSERT INTO upload_holds VALUES (?,?,?,?)', ('legacy-upload', 'legacy-device', 'general', 'legacy-hold'))
    store.close()
    reloaded = Store(path)
    row = reloaded._one('SELECT * FROM upload_holds WHERE upload_id=?', ('legacy-upload',))
    assert row['hold_id'] == 'legacy-hold' and row['device_id'] == 'legacy-device'
    assert len(row['version']) == 32
    version = row['version']
    reloaded.close()
    again = Store(path)
    assert again._one('SELECT version FROM upload_holds WHERE upload_id=?', ('legacy-upload',))['version'] == version
    again.close()


async def test_retention_release_rechecks_bot_scope_after_reading_body(client, hub, monkeypatch):
    from aiohttp import web
    owner = await pair_phone(client, hub, 'Owner')
    hub.store.add_upload('moved-file', owner.id, 'general', 'file.pdf', 'application/pdf', 'file', len(DATA))
    assert hub.store.hold_uploads(['moved-file'], owner.id, 'general', 'move-hold')
    row = hub.store.own_upload_holds(owner.id, '')[0]
    original = web.Request.json

    async def move_after_body(request, *args, **kwargs):
        result = await original(request, *args, **kwargs)
        hub.store._exec("UPDATE chats SET bot='another-bot' WHERE id='general'")
        return result

    monkeypatch.setattr(web.Request, 'json', move_after_body)
    path = '/api/chats/general/uploads/hold'
    body = json.dumps({'hold_id': row['hold_id'], 'upload_id': row['id'], 'expected_version': row['version']}).encode()
    response = await client.delete(path, data=body, headers=owner.signed('DELETE', path, body))
    assert response.status == 404
    assert hub.store.upload_held('moved-file')


async def test_private_bytes_require_signed_upload_and_explicit_group_membership(client, hub):
    a = await pair_phone(client, hub, 'Desktop')
    b = await pair_phone(client, hub, 'Phone')
    group = hub.user_sync.create(a.id)['group_id']
    path = f'/api/user-sync/{group}/blobs/{DIGEST}?name=private.pdf'
    assert (await client.put(path, data=DATA, headers=a.auth)).status == 403
    response = await put(client, a, path)
    assert response.status == 200
    blob = (await response.json())['blob']
    assert set(blob) == {'id', 'sha256', 'name', 'mime', 'kind', 'size'}
    assert blob['mime'] == 'application/pdf'
    assert (await (await put(client, a, path)).json())['blob'] == blob
    read = f"/api/user-sync/{group}/blobs/{blob['id']}"
    assert (await client.get(read)).status == 401
    assert (await client.get(read, headers=b.auth)).status == 403
    hub.user_sync.join(b.id, hub.user_sync.invite(group, a.id)['token'])
    response = await client.get(read, headers=b.auth)
    assert await response.read() == DATA
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.headers['Content-Type'] == 'application/octet-stream'
    hub.user_sync.revoke(group, a.id, b.id)
    assert (await client.get(read, headers=b.auth)).status == 403
    # A former public-media signature cannot bypass the private route's policy.
    assert (await client.get(read + '?sig=' + hub.media_signature(blob['id']))).status == 401


async def test_digest_and_quotas_fail_without_recording_a_file(client, hub):
    a = await pair_phone(client, hub)
    group = hub.user_sync.create(a.id)['group_id']
    assert (await put(client, a, f'/api/user-sync/{group}/blobs/{"0" * 64}?name=file.pdf')).status == 400
    hub.sync_blobs.max_total_bytes = len(DATA) - 1
    assert (await put(client, a, f'/api/user-sync/{group}/blobs/{DIGEST}?name=file.pdf')).status == 507
    assert hub.sync_blobs.total_bytes() == 0
    assert hub.store._one('SELECT COUNT(*) AS n FROM sync_blobs')['n'] == 0


async def test_shared_and_ordinary_uploads_use_the_same_device_daily_allowance(client, hub):
    phone = await pair_phone(client, hub)
    group = hub.user_sync.create(phone.id)['group_id']
    hub.sync_blobs.max_daily_bytes = len(DATA)
    path = f'/api/user-sync/{group}/blobs/{DIGEST}?name=file.pdf'
    assert (await put(client, phone, path)).status == 200
    assert (await put(client, phone, path)).status == 200  # immutable retry has no new allocation
    assert hub.sync_blobs.daily_bytes(phone.id, time.time() - 86400) == len(DATA)
    assert (await put(client, phone, path.replace('file.pdf', 'second.pdf'))).status == 429
    hub.device_daily_upload_bytes = len(DATA)
    form = aiohttp.FormData()
    form.add_field('file', b'new', filename='normal.txt')
    assert (await client.post('/api/chats/general/uploads', data=form, headers=phone.auth)).status == 429


async def test_draft_and_submission_pins_survive_cleanup(client, hub):
    a = await pair_phone(client, hub)
    group = hub.user_sync.create(a.id)['group_id']
    blob = hub.sync_blobs.put(group, a.id, DIGEST, 'file.pdf', DATA)
    record = write_files(hub, group, a, blob)
    hub.store._exec('UPDATE sync_blobs SET created_at=1')
    assert hub.sync_blobs.sweep(100000) == 0
    hub.user_sync.claim_submission(group, a.id, 'general', record['revision'])
    write_files(hub, group, a, blob, record['revision'], 'remove', deleted=True)
    assert hub.sync_blobs.sweep(100000) == 0
    assert hub.sync_blobs.get(group, a.id, blob['id'])[1].read_bytes() == DATA


async def test_conflicting_file_lists_pin_every_candidate_until_resolved(client, hub):
    a = await pair_phone(client, hub, 'Desktop')
    b = await pair_phone(client, hub, 'Phone')
    group = hub.user_sync.create(a.id)['group_id']
    hub.user_sync.join(b.id, hub.user_sync.invite(group, a.id)['token'])
    first = hub.sync_blobs.put(group, a.id, DIGEST, 'first.pdf', DATA)
    second = hub.sync_blobs.put(group, b.id, DIGEST, 'second.pdf', DATA)
    write_files(hub, group, a, first)
    conflict = write_files(hub, group, b, second, 0, 'competing')
    hub.store._exec('UPDATE sync_blobs SET created_at=1')
    assert hub.sync_blobs.sweep(100000) == 0
    hub.user_sync.write(group, a.id, 'draft', 'general', operation_id='choose', base_revision=conflict['revision'], resolve=True,
        changes={'files': {'deleted': False, 'value': [{**second, 'slot': 'file-1'}]}})
    assert hub.sync_blobs.sweep(100000) == 1
    with pytest.raises(SyncError):
        hub.sync_blobs.get(group, a.id, first['id'])
    assert hub.sync_blobs.get(group, a.id, second['id'])[1].read_bytes() == DATA


async def test_referencing_another_groups_file_fails_without_mutating_draft(client, hub):
    a = await pair_phone(client, hub)
    own = hub.user_sync.create(a.id)['group_id']
    other = hub.user_sync.create(a.id)['group_id']
    blob = hub.sync_blobs.put(other, a.id, DIGEST, 'other.pdf', DATA)
    with pytest.raises(SyncError, match='unavailable'):
        write_files(hub, own, a, blob)
    assert hub.user_sync.read(own, a.id, 'draft', 'general')['revision'] == 0


async def test_independent_target_copy_is_owned_retained_idempotent_and_claimable(aiohttp_client, client, hub, tmp_path):
    home_phone = await pair_phone(client, hub)
    group = hub.user_sync.create(home_phone.id)['group_id']
    blob = hub.sync_blobs.put(group, home_phone.id, DIGEST, 'private.pdf', DATA)
    target_store = Store(tmp_path / 'target.db')
    target_store.ensure_chat('general', 'Target')
    target = Hub(target_store, media_dir=tmp_path / 'target-media')
    received = []
    async def receive(chat, text, device, message, **extra):
        received.append(message['id'])
    target.on_user_message = receive
    try:
        target_client = await aiohttp_client(target.build_app())
        device = await pair_phone(target_client, target, 'Independent target pairing')
        path = f"/api/chats/general/staged-files/{blob['id']}?slot=file-1&sha256={DIGEST}&name=private.pdf"
        assert (await put(target_client, home_phone, path)).status in (401, 403)
        response = await put(target_client, device, path)
        assert response.status == 200
        upload = (await response.json())['upload']
        assert (await (await put(target_client, device, path)).json())['upload']['id'] == upload['id']
        target_store.release_uploads(device.id, 'general', upload['hold_id'])
        assert not target_store.upload_held(upload['id'])
        assert (await put(target_client, device, path)).status == 200
        row = target_store.get_upload(upload['id'])
        assert row['device_id'] == device.id
        assert target_store.upload_held(upload['id'])
        target_store._exec('UPDATE uploads SET created_at=1')
        target.sweep_uploads(time.time())
        assert (target.media_dir / upload['id'] / upload['name']).read_bytes() == DATA
        other_home = await pair_phone(client, hub, 'Second home pairing')
        hub.user_sync.join(other_home.id, hub.user_sync.invite(group, home_phone.id)['token'])
        record = write_files(hub, group, home_phone, blob)
        record = hub.user_sync.write(group, home_phone.id, 'draft', 'general', operation_id='destination', base_revision=record['revision'],
            changes={'server_id': {'deleted': False, 'value': target.server_id()},
                     'chat_id': {'deleted': False, 'value': 'general'}, 'text': {'deleted': False, 'value': 'same frozen draft'}})
        claim = hub.user_sync.claim_submission(group, home_phone.id, 'general', record['revision'])
        assert hub.user_sync.claim_submission(group, other_home.id, 'general', record['revision']) == claim
        other_target = await pair_phone(target_client, target, 'Second independent target pairing')
        second_upload = (await (await put(target_client, other_target, path)).json())['upload']
        assert second_upload['id'] != upload['id']
        responses = []
        for actor, attachment in ((device, upload), (other_target, second_upload)):
            response = await target_client.post('/api/chats/general/messages', headers=actor.auth,
                json={'text': 'same frozen draft', 'client_id': claim['submission_id'], 'attachments': [attachment['id']]})
            assert response.status == 200
            responses.append((await response.json())['message'])
        assert responses[0]['id'] == responses[1]['id']
        assert received == [responses[0]['id']]
        assert not target_store.upload_held(upload['id'])
        target_store.release_uploads(other_target.id, 'general', second_upload['hold_id'])
        assert target.sweep_uploads(time.time() + 86401) == 1
        assert target_store.get_upload(upload['id'])['message_id'] == responses[0]['id']
    finally:
        await target_client.close()
        target_store.close()


def test_sweeper_rechecks_a_new_claim_before_deleting_stale_snapshot(hub, monkeypatch):
    device = hub.store.add_device('Desktop')[0]
    directory = hub.media_dir / 'upload-race'
    directory.mkdir(parents=True)
    (directory / 'file.pdf').write_bytes(DATA)
    hub.store.add_upload('upload-race', device['id'], 'general', 'file.pdf', 'application/pdf', 'file', len(DATA))
    hub.store._exec('UPDATE uploads SET created_at=1')
    stale = hub.store.stale_uploads
    def claim_after_snapshot(cutoff):
        rows = stale(cutoff)
        hub.store.claim_uploads(['upload-race'], device['id'], 'general', 'message-won')
        return rows
    monkeypatch.setattr(hub.store, 'stale_uploads', claim_after_snapshot)
    assert hub.sweep_uploads(time.time()) == 0
    assert (directory / 'file.pdf').is_file()


async def test_signed_binary_limits_are_route_scoped_and_allow_files_above_two_megabytes(client, hub):
    phone = await pair_phone(client, hub)
    group = hub.user_sync.create(phone.id)['group_id']
    data = b'x' * (2 * 1024 * 1024 + 64)
    digest = hashlib.sha256(data).hexdigest()
    response = await put(client, phone, f'/api/user-sync/{group}/blobs/{digest}?name=large.bin', data)
    assert response.status == 200
    blob = (await response.json())['blob']
    target_path = f"/api/chats/general/staged-files/{blob['id']}?slot=large&sha256={digest}&name=large.bin"
    assert (await put(client, phone, target_path, data)).status == 200
    json_body = json.dumps({'padding': 'x' * (2 * 1024 * 1024)}).encode()
    assert (await client.post('/api/user-sync', data=json_body,
        headers=phone.signed('POST', '/api/user-sync', json_body))).status == 413
    hub.max_upload_bytes = 10
    assert (await put(client, phone, f'/api/user-sync/{group}/blobs/{DIGEST}?name=over-limit.pdf')).status == 413


async def test_normal_upload_rechecks_storage_after_a_competing_sync_transfer(client, hub, monkeypatch):
    from plugin import uploads
    phone = await pair_phone(client, hub)
    group = hub.user_sync.create(phone.id)['group_id']
    normal = b'normal text'
    hub.total_upload_bytes = len(DATA) + len(normal) - 1
    original_sniff = uploads.sniff_mime
    filled = False
    def complete_competing_upload(head, name):
        nonlocal filled
        if name == 'normal.txt' and not filled:
            filled = True
            hub.sync_blobs.put(group, phone.id, DIGEST, 'competing.pdf', DATA)
        return original_sniff(head, name)
    monkeypatch.setattr(uploads, 'sniff_mime', complete_competing_upload)
    form = aiohttp.FormData()
    form.add_field('file', normal, filename='normal.txt', content_type='application/octet-stream')
    response = await client.post('/api/chats/general/uploads', data=form, headers=phone.auth)
    assert response.status == 507
    assert hub.store.total_upload_bytes() == 0
    assert not list(hub.media_dir.iterdir())


async def test_target_bound_delivery_receipt_retires_submission_pins_without_erasing_live_drafts(client, hub):
    phone = await pair_phone(client, hub)
    group = hub.user_sync.create(phone.id)['group_id']
    blob = hub.sync_blobs.put(group, phone.id, DIGEST, 'file.pdf', DATA)
    record = write_files(hub, group, phone, blob)
    record = hub.user_sync.write(group, phone.id, 'draft', 'general', operation_id='target', base_revision=record['revision'],
        changes={'server_id': {'deleted': False, 'value': 'independent-target'}, 'chat_id': {'deleted': False, 'value': 'general'}})
    claim = hub.user_sync.claim_submission(group, phone.id, 'general', record['revision'])
    receipt = {'server_id': 'independent-target', 'chat_id': 'general', 'message_id': 'accepted', 'client_id': claim['submission_id']}
    with pytest.raises(SyncError, match='different target'):
        hub.user_sync.settle_submission(group, phone.id, 'general', claim['submission_id'], {**receipt, 'server_id': 'other'})
    assert hub.store._one('SELECT COUNT(*) AS n FROM sync_submission_blobs')['n'] == 1
    endpoint = f"/api/user-sync/{group}/drafts/general/submissions/{claim['submission_id']}/delivered"
    body = json.dumps(receipt).encode()
    response = await client.post(endpoint, data=body, headers=phone.signed('POST', endpoint, body))
    assert response.status == 200
    assert (await response.json())['status'] == 'linked_device_confirmed'
    assert hub.store._one('SELECT COUNT(*) AS n FROM sync_submission_blobs')['n'] == 0
    hub.store._exec('UPDATE sync_blobs SET created_at=1')
    assert hub.sync_blobs.sweep(100000) == 0
    write_files(hub, group, phone, blob, record['revision'], 'clear-after-confirmation', deleted=True)
    assert hub.sync_blobs.sweep(100000) == 1
    assert hub.user_sync.settle_submission(group, phone.id, 'general', claim['submission_id'], receipt)['receipt'] == receipt


async def test_removed_device_files_stay_recoverable_until_an_owner_explicitly_releases_them(client, hub):
    lost = await pair_phone(client, hub, 'Lost phone')
    current = await pair_phone(client, hub, 'Remaining owner')
    directory = hub.media_dir / 'retained-file'
    directory.mkdir(parents=True)
    (directory / 'file.pdf').write_bytes(DATA)
    hub.store.add_upload('retained-file', lost.id, 'general', 'file.pdf', 'application/pdf', 'file', len(DATA))
    hub.store.hold_uploads(['retained-file'], lost.id, 'general', 'recovery-hold')
    hub.store._exec('UPDATE uploads SET created_at=1')
    hub.store.remove_device(lost.id, keep_an_owner=True)
    assert hub.sweep_uploads(time.time()) == 0
    response = await client.get('/api/uploads/retained', headers=current.auth)
    files = (await response.json())['files']
    assert files[0]['upload']['id'] == 'retained-file'
    assert files[0]['source_device'] == lost.id
    path = '/api/chats/general/uploads/hold'
    body = json.dumps({'hold_id': 'recovery-hold', 'source_device': lost.id}).encode()
    response = await client.delete(path, data=body, headers=current.signed('DELETE', path, body))
    assert response.status == 200
    assert hub.sweep_uploads(time.time()) == 1
    assert not directory.exists()


async def test_unconfirmed_source_retention_requires_explicit_release_without_cancelling_execution(client, hub):
    phone = await pair_phone(client, hub)
    group = hub.user_sync.create(phone.id)['group_id']
    blob = hub.sync_blobs.put(group, phone.id, DIGEST, 'file.pdf', DATA)
    record = write_files(hub, group, phone, blob)
    claim = hub.user_sync.claim_submission(group, phone.id, 'general', record['revision'])
    with pytest.raises(SyncError, match='Explicit confirmation'):
        hub.user_sync.release_submission_files(group, phone.id, 'general', claim['submission_id'], 'cancel')
    assert hub.store._one('SELECT COUNT(*) AS n FROM sync_submission_blobs')['n'] == 1
    result = hub.user_sync.release_submission_files(group, phone.id, 'general', claim['submission_id'],
        'release-retained-files-without-confirmed-delivery')
    assert result == {'files_released': True, 'execution_cancelled': False}
    assert hub.user_sync.claim_submission(group, phone.id, 'general', record['revision'])['files_released'] is True


async def test_normal_upload_rechecks_revocation_before_accepting_bytes(client, hub, monkeypatch):
    from plugin import uploads
    phone = await pair_phone(client, hub)
    original_sniff = uploads.sniff_mime
    def revoke_before_commit(head, name):
        hub.store.remove_device(phone.id)
        return original_sniff(head, name)
    monkeypatch.setattr(uploads, 'sniff_mime', revoke_before_commit)
    form = aiohttp.FormData()
    form.add_field('file', b'synthetic', filename='file.txt')
    response = await client.post('/api/chats/general/uploads', data=form, headers=phone.auth)
    assert response.status == 403
    assert hub.store.total_upload_bytes() == 0
    assert not list(hub.media_dir.iterdir())
