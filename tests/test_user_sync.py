"""Sync membership, field conflicts and retry durability without a Hermes runtime."""
import pytest

from plugin.store import Store
from plugin.user_sync import SyncError, UserSync


@pytest.fixture
def linked(tmp_path):
    store = Store(tmp_path / 'sync.db')
    a = store.add_device('desktop')[0]['id']
    b = store.add_device('phone')[0]['id']
    service = UserSync(store)
    group = service.create(a)['group_id']
    service.join(b, service.invite(group, a)['token'])
    yield store, service, group, a, b
    store.close()


def write(service, group, device, op, base, **values):
    return service.write(group, device, 'draft', 'chat-1', operation_id=op,
                         base_revision=base, changes={k: {'deleted': False, 'value': v} for k, v in values.items()})


def test_disjoint_changes_merge_but_competing_text_requires_choice(linked):
    _, service, group, a, b = linked
    write(service, group, a, 'text-a', 0, text='hello')
    merged = write(service, group, b, 'title-b', 0, title='trip')
    assert len(merged['fields']['text']['candidates']) == 1
    conflict = write(service, group, b, 'text-b', 0, text='different')
    assert [v['value'] for v in conflict['fields']['text']['candidates']] == ['hello', 'different']
    # Receiving a conflict is not permission to silently overwrite it.
    repeated = write(service, group, a, 'text-c', conflict['revision'], text='third')
    assert len(repeated['fields']['text']['candidates']) == 3
    with pytest.raises(SyncError, match='Refresh'):
        service.write(group, a, 'draft', 'chat-1', operation_id='stale-resolution', base_revision=3,
                      changes={'text': {'deleted': False, 'value': 'chosen'}}, resolve=True)
    chosen = service.write(group, a, 'draft', 'chat-1', operation_id='resolution', base_revision=4,
                           changes={'text': {'deleted': False, 'value': 'combined'}}, resolve=True)
    assert [v['value'] for v in chosen['fields']['text']['candidates']] == ['combined']
    assert chosen['fields']['title']['candidates'][0]['value'] == 'trip'


def test_retry_is_durable_and_payload_bound(linked):
    store, service, group, a, _ = linked
    first = write(service, group, a, 'retry', 0, text='one')
    reloaded = UserSync(store)
    assert write(reloaded, group, a, 'retry', 0, text='one') == first
    with pytest.raises(SyncError, match='different changes'):
        write(reloaded, group, a, 'retry', 0, text='two')
    assert reloaded.read(group, a, 'draft', 'chat-1')['revision'] == 1


def test_revoke_blocks_reads_retries_and_outstanding_invites(linked):
    _, service, group, a, b = linked
    write(service, group, b, 'before-revoke', 0, text='private')
    invitation = service.invite(group, b)['token']
    service.revoke(group, a, b)
    for action in (lambda: service.read(group, b, 'draft', 'chat-1'),
                   lambda: write(service, group, b, 'before-revoke', 0, text='private'),
                   lambda: service.join(b, invitation)):
        with pytest.raises(SyncError):
            action()


def test_owner_devices_are_not_implicitly_group_members(linked):
    store, service, group, a, _ = linked
    other = store.add_device('other owner')[0]['id']
    with pytest.raises(SyncError) as error:
        service.read(group, other, 'draft', 'chat-1')
    assert error.value.status == 403
    token = service.invite(group, a)['token']
    service.join(other, token)
    with pytest.raises(SyncError, match='already used'):
        service.join(other, token)


def test_delete_edit_conflict_and_invalid_payload_rollback(linked):
    _, service, group, a, b = linked
    write(service, group, a, 'initial', 0, text='kept')
    deleted = service.write(group, b, 'draft', 'chat-1', operation_id='delete', base_revision=0,
                            changes={'text': {'deleted': True}})
    assert [v['deleted'] for v in deleted['fields']['text']['candidates']] == [False, True]
    with pytest.raises(SyncError):
        write(service, group, a, 'invalid', 2, text=float('nan'))
    assert service.read(group, a, 'draft', 'chat-1')['revision'] == 2


def test_process_restart_keeps_conflicts_and_operation_receipts(tmp_path):
    path = tmp_path / 'restart.db'
    with_store = Store(path)
    a = with_store.add_device('desktop')[0]['id']
    b = with_store.add_device('phone')[0]['id']
    service = UserSync(with_store)
    group = service.create(a)['group_id']
    service.join(b, service.invite(group, a)['token'])
    write(service, group, a, 'a', 0, text='desktop')
    conflict = write(service, group, b, 'b', 0, text='phone')
    with_store.close()
    reopened = Store(path)
    try:
        service = UserSync(reopened)
        assert service.read(group, a, 'draft', 'chat-1') == conflict
        assert write(service, group, b, 'b', 0, text='phone') == conflict
    finally:
        reopened.close()


def test_concurrent_connections_preserve_both_edits(linked):
    from concurrent.futures import ThreadPoolExecutor

    store, service, group, a, b = linked
    other_store = Store(store.path)
    try:
        other = UserSync(other_store)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(write, service, group, a, 'a', 0, text='desktop'),
                       pool.submit(write, other, group, b, 'b', 0, text='phone')]
            for future in futures:
                future.result()
        record = service.read(group, a, 'draft', 'chat-1')
        assert {c['value'] for c in record['fields']['text']['candidates']} == {'desktop', 'phone'}
    finally:
        other_store.close()


def test_role_downgrade_and_deleted_device_revoke_membership(linked):
    store, service, group, a, b = linked
    store.update_device(b, role='member')
    with pytest.raises(SyncError):
        service.read(group, b, 'draft', 'chat-1')
    store.remove_device(b)
    with pytest.raises(SyncError):
        service.read(group, b, 'draft', 'chat-1')


def test_listing_is_bounded_and_cursor_does_not_skip_records(linked):
    _, service, group, a, _ = linked
    for index in range(101):
        service.write(group, a, 'bookmark', f'{index:03}', operation_id=f'op-{index}', base_revision=0,
                      changes={'note': {'deleted': False, 'value': index}})
    first = service.listing(group, a)
    assert len(first['records']) == 100
    second = service.listing(group, a, first['next']['kind'], first['next']['id'])
    assert [r['id'] for r in second['records']] == ['100']
    assert second['next'] is None


def test_shared_draft_submission_is_stable_without_enqueuing_work(linked):
    store, service, group, a, b = linked
    draft = write(service, group, a, 'draft', 0, text='hello', generation='composition-1')
    first = service.claim_submission(group, a, 'chat-1', draft['revision'])
    assert service.claim_submission(group, b, 'chat-1', draft['revision']) == first
    assert store._db.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 0
    edited = write(service, group, a, 'edit', draft['revision'], text='new content')
    with pytest.raises(SyncError, match='different content'):
        service.claim_submission(group, a, 'chat-1', edited['revision'])
    fresh = write(service, group, a, 'new-generation', edited['revision'], generation='composition-2')
    assert service.claim_submission(group, a, 'chat-1', fresh['revision'])['submission_id'] != first['submission_id']


def test_submission_rejects_stale_or_conflicted_drafts(linked):
    _, service, group, a, b = linked
    write(service, group, a, 'draft', 0, text='hello', generation='composition-1')
    conflict = write(service, group, b, 'conflict', 0, text='other')
    with pytest.raises(SyncError, match='Refresh'):
        service.claim_submission(group, a, 'chat-1', 1)
    with pytest.raises(SyncError, match='conflicting'):
        service.claim_submission(group, a, 'chat-1', conflict['revision'])
