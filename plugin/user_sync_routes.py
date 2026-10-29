"""Signed owner mutations and private member reads for the designated sync home."""
import asyncio

from aiohttp import web

from .user_sync import SyncError


async def _run(request, action):
    hub = request.app['hub']
    device = hub._require(request)['id']
    group = request.match_info.get('group_id', '')
    service = hub.user_sync
    try:
        if action == 'groups':
            result = {'groups': await asyncio.to_thread(service.groups, device)}
        elif action == 'members':
            result = {'members': await asyncio.to_thread(service.members, group, device)}
        elif action == 'submissions':
            result = await asyncio.to_thread(service.submissions, group, device, request.query.get('after', ''))
        elif action == 'records':
            result = await asyncio.to_thread(service.listing, group, device,
                                             request.query.get('after_kind', ''), request.query.get('after_id', ''))
        elif action == 'read':
            result = await asyncio.to_thread(service.read, group, device,
                                             request.match_info['kind'], request.match_info['record_id'])
        elif action == 'preset_version':
            result = await asyncio.to_thread(service.preset_version, group, device,
                                             request.match_info['record_id'], request.match_info['version'])
        else:
            if request.content_length is not None and request.content_length > 512 * 1024:
                raise SyncError('Sync request is too large.', 413)
            try:
                body = await request.json()
            except (ValueError, UnicodeError):
                raise SyncError('Expected a JSON object.')
            if not isinstance(body, dict):
                raise SyncError('Expected a JSON object.')
            if action == 'create':
                result = await asyncio.to_thread(service.create, device)
            elif action == 'invite':
                result = await asyncio.to_thread(service.invite, group, device)
            elif action == 'join':
                result = await asyncio.to_thread(service.join, device, body.get('token'))
            elif action == 'revoke':
                await asyncio.to_thread(service.revoke, group, device, body.get('device_id', ''))
                result = {'revoked': True}
            elif action == 'submit':
                if set(body) != {'expected_revision'}:
                    raise SyncError('Expected the exact draft revision.')
                result = await asyncio.to_thread(service.claim_submission, group, device,
                    request.match_info['record_id'], body['expected_revision'])
            elif action == 'settle':
                result = await asyncio.to_thread(service.settle_submission, group, device,
                    request.match_info['record_id'], request.match_info['submission_id'], body)
            elif action == 'release_files':
                if set(body) != {'confirmation'}:
                    raise SyncError('Expected explicit source-file release confirmation.')
                result = await asyncio.to_thread(service.release_submission_files, group, device,
                    request.match_info['record_id'], request.match_info['submission_id'], body['confirmation'])
            else:
                allowed = {'operation_id', 'base_revision', 'changes', 'resolve', 'base_fields'}
                if set(body) - allowed or not {'operation_id', 'base_revision', 'changes'} <= body.keys():
                    raise SyncError('Invalid sync mutation fields.')
                result = await asyncio.to_thread(service.write, group, device, request.match_info['kind'],
                                                 request.match_info['record_id'], **body)
        return web.json_response(result, headers={'Cache-Control': 'no-store'})
    except SyncError as exc:
        return web.json_response({'error': str(exc)}, status=exc.status, headers={'Cache-Control': 'no-store'})


async def h_user_sync_groups(request): return await _run(request, 'groups')
async def h_user_sync_members(request): return await _run(request, 'members')
async def h_user_sync_submissions(request): return await _run(request, 'submissions')
async def h_user_sync_create(request): return await _run(request, 'create')
async def h_user_sync_invite(request): return await _run(request, 'invite')
async def h_user_sync_join(request): return await _run(request, 'join')
async def h_user_sync_revoke(request): return await _run(request, 'revoke')
async def h_user_sync_records(request): return await _run(request, 'records')
async def h_user_sync_read(request): return await _run(request, 'read')
async def h_user_sync_preset_version(request): return await _run(request, 'preset_version')
async def h_user_sync_write(request): return await _run(request, 'write')
async def h_user_sync_submit(request): return await _run(request, 'submit')
async def h_user_sync_settle(request): return await _run(request, 'settle')
async def h_user_sync_release_files(request): return await _run(request, 'release_files')


def register_routes(app):
    app.router.add_get('/api/user-sync', h_user_sync_groups)
    app.router.add_post('/api/user-sync', h_user_sync_create)
    app.router.add_post('/api/user-sync/join', h_user_sync_join)
    app.router.add_post('/api/user-sync/{group_id}/invite', h_user_sync_invite)
    app.router.add_get('/api/user-sync/{group_id}/members', h_user_sync_members)
    app.router.add_get('/api/user-sync/{group_id}/submissions', h_user_sync_submissions)
    app.router.add_post('/api/user-sync/{group_id}/revoke', h_user_sync_revoke)
    app.router.add_post('/api/user-sync/{group_id}/drafts/{record_id}/submit', h_user_sync_submit)
    app.router.add_post('/api/user-sync/{group_id}/drafts/{record_id}/submissions/{submission_id}/delivered', h_user_sync_settle)
    app.router.add_post('/api/user-sync/{group_id}/drafts/{record_id}/submissions/{submission_id}/release-files', h_user_sync_release_files)
    app.router.add_get('/api/user-sync/{group_id}/records', h_user_sync_records)
    app.router.add_get('/api/user-sync/{group_id}/records/{kind}/{record_id}', h_user_sync_read)
    app.router.add_get('/api/user-sync/{group_id}/presets/{record_id}/versions/{version}', h_user_sync_preset_version)
    app.router.add_post('/api/user-sync/{group_id}/records/{kind}/{record_id}', h_user_sync_write)
