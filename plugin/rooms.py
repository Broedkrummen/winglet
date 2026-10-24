"""Gateway-local rooms. Hermes owns execution; Winglet owns access and presentation."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import re
import sqlite3
import time
from pathlib import Path

from .execution import redact

_ID = re.compile(r'^[A-Za-z0-9._:-]{16,96}$')
_MENTION = re.compile(r'@([A-Za-z0-9][A-Za-z0-9._:-]*)', re.I)
_SCHEMA = '''
CREATE TABLE IF NOT EXISTS winglet_rooms (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, members TEXT NOT NULL,
 epochs TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
 readers TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
 created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS winglet_room_ops (
 id TEXT PRIMARY KEY, device TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS winglet_room_seen (
 room TEXT NOT NULL, device TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
 PRIMARY KEY(room,device));
'''


class RoomError(ValueError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def clean_title(value):
    title = ' '.join(str(value or '').split())
    if not title or len(title) > 80:
        raise RoomError('Use a room title between 1 and 80 characters.', 400)
    return title


class Rooms:
    def __init__(self, hub, worker, metadata_path):
        self.hub, self.worker, self.path = hub, worker, str(metadata_path)
        self.key = hub.store.secret('room_identity_key').encode()
        with self._db() as db:
            from hermes_state_wal import apply_database_pragmas
            apply_database_pragmas(db, db_label='rooms-meta.sqlite')
            db.executescript(_SCHEMA)

    @contextlib.contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def available(self):
        state = self.worker.runtime.status()
        return bool(state.get('running') and not state.get('stopping'))

    def _actor(self, device, owner=False):
        current = self.hub.store.get_device(device['id'])
        if current is None or (owner and current['role'] != 'owner'):
            raise RoomError('Your room permission changed. Reconnect and try again.', 403)
        return current

    def _room(self, db, device, room_id):
        row = db.execute('SELECT * FROM winglet_rooms WHERE id=?', (room_id,)).fetchone()
        if row is None or (device['role'] != 'owner' and device['id'] not in json.loads(row['readers'])):
            raise RoomError('This room is unavailable or your access was removed.', 404)
        return dict(row)

    def _opaque(self, device, operation, suffix=''):
        return 'wr-' + hmac.new(self.key, f"{device['id']}:{operation}:{suffix}".encode(), hashlib.sha256).hexdigest()[:40]

    def catalog(self, fresh=False):
        # The default profile belongs to this gateway. Named profiles must be live,
        # not merely present as configuration directories.
        state = self.hub.bots_state(fresh=fresh)
        return [{'name': 'default', 'title': self.hub._bot_info().get('title') or 'Main bot', 'served': True}] + [
            {'name': b['name'], 'title': b.get('title') or b['name'], 'served': bool(b.get('served'))}
            for b in state['bots']]

    def _members(self, value):
        from gateway.hosted_room_discussion import validate_roster
        live = {b['name']: b for b in self.catalog(fresh=True) if b['served']}
        if not isinstance(value, list) or not 2 <= len(value) <= 6 or not all(isinstance(x, str) for x in value):
            raise RoomError('Choose between two and six bots on this gateway.', 400)
        if len(set(value)) != len(value) or any(name not in live for name in value):
            raise RoomError('A selected bot is unavailable or listed twice.', 400)
        members = [{'member_id': name, 'profile': name, 'handle': 'main' if name == 'default' else name,
                    'display_name': live[name]['title']} for name in value]
        validate_roster(members, local_profiles=tuple(live))
        return members

    def _state(self, row, device, db):
        from gateway.hosted_rooms import room_state
        epochs = json.loads(row['epochs'])
        latest = room_state(self.worker.db_path, room_id=epochs[-1])
        status = self.worker.status(epochs[-1])
        from gateway.hosted_room_driver import list_tasks
        turns = [{'profile':task['payload']['target_profile'], 'status':task['status']}
                 for task in list_tasks(self.worker.db_path,room_id=epochs[-1])
                 if task['status'] not in {'settled','failed','cancelled'}]
        seen = db.execute('SELECT epoch,seq FROM winglet_room_seen WHERE room=? AND device=?', (row['id'], device['id'])).fetchone()
        latest_cursor = [len(epochs)-1, latest['latest_seq']]
        return {'id': row['id'], 'title': row['title'], 'members': json.loads(row['members']),
                'archived': bool(row['archived']), 'revision': row['revision'],
                'readers': json.loads(row['readers']) if device['role'] == 'owner' else [],
                'can_manage': device['role'] == 'owner', 'can_send': device['role'] == 'owner' and not row['archived'],
                'member_write_supported': False, 'updated_at': row['updated_at'],
                'unread': seen is None or list(seen) < latest_cursor, 'latest': latest_cursor,
                'epoch_count': len(epochs), 'driver': {**self._driver(status),'turns':turns},
                'available_profiles': self.catalog() if device['role']=='owner' else []}

    @staticmethod
    def _driver(status):
        # No session IDs, peer credentials or raw prompts leave the service.
        result = {k: status.get(k) for k in ('running', 'working', 'blocked', 'counts')}
        fields = ('kind', 'task_id', 'member_id', 'execution_generation', 'request_id')
        result['pending_actions'] = []
        for action in status.get('pending_actions') or []:
            public = {k: action[k] for k in fields if k in action}
            if action.get('approval'):
                approval = action['approval']
                public['summary'] = redact(approval.get('command') or approval.get('description'), 500)
            result['pending_actions'].append(public)
        return result

    def listing(self, device):
        device = self._actor(device)
        with self._db() as db:
            rows = db.execute('SELECT * FROM winglet_rooms ORDER BY updated_at DESC').fetchall()
            rooms = [self._state(dict(row), device, db) for row in rows
                     if device['role'] == 'owner' or device['id'] in json.loads(row['readers'])]
        return {'rooms': rooms, 'bots': self.catalog() if device['role'] == 'owner' else [],
                'can_create': device['role'] == 'owner', 'member_write_supported': False}

    def state(self, device, room_id):
        device = self._actor(device)
        with self._db() as db:
            return self._state(self._room(db, device, room_id), device, db)

    def log(self, device, room_id, epoch=0, after=0):
        from gateway.hosted_rooms import read_events
        device = self._actor(device)
        with self._db() as db:
            row = self._room(db, device, room_id)
        epochs = json.loads(row['epochs'])
        if epoch is None:
            from gateway.hosted_rooms import room_state
            epoch = len(epochs)-1
            after = max(0,room_state(self.worker.db_path,room_id=epochs[epoch])['latest_seq']-100)
        try:
            epoch, after = int(epoch), int(after)
        except (TypeError, ValueError):
            raise RoomError('Invalid room cursor.', 400)
        if not 0 <= epoch < len(epochs) or after < 0:
            raise RoomError('Invalid room cursor.', 400)
        page = read_events(self.worker.db_path, room_id=epochs[epoch], since_seq=after, limit=100)
        from gateway.hosted_rooms import room_state
        roster = {m['member_id']:m for m in room_state(self.worker.db_path,room_id=epochs[epoch])['members']}
        allowed = {'message.user', 'message.member', 'turn.failed', 'turn.cancelled',
                   'turn.settled', 'room.stop_requested', 'room.renamed', 'room.activity'}
        events = []
        for event in page['events']:
            if event['kind'] not in allowed:
                continue
            payload = event['payload']
            fields = ('text', 'member_id', 'discussion_event_id', 'round_index', 'error', 'reason', 'status', 'passed', 'name')
            public_payload = {k: payload[k] for k in fields if k in payload}
            member = roster.get(payload.get('member_id'))
            if member:
                public_payload['display_name'] = member.get('display_name') or member['profile']
            actor = dict(event['actor'])
            if actor.get('kind')=='user' and actor.get('id','').startswith('winglet:'):
                device_row = self.hub.store.get_device(actor['id'].removeprefix('winglet:'))
                actor['label'] = device_row['name'] if device_row else 'Former participant'
            events.append({'id': f"{epoch}:{event['seq']}", 'seq': event['seq'], 'epoch': epoch,
                           'kind': event['kind'], 'actor': actor, 'created_at': event['created_at'],
                           'payload': public_payload})
        cursor = [epoch, page['cursor']]
        more = page.get('has_more', False)
        if not more and epoch + 1 < len(epochs):
            cursor, more = [epoch+1, 0], True
        older = [epoch,max(0,after-100)] if after else None
        if older is None and epoch:
            from gateway.hosted_rooms import room_state
            older = [epoch-1,max(0,room_state(self.worker.db_path,room_id=epochs[epoch-1])['latest_seq']-100)]
        return {'events': events, 'cursor': cursor, 'has_more': more, 'older':older}

    def mutate(self, device, action, room_id, body):
        from gateway import hosted_rooms
        from tui_gateway.hosted_room_driver import HostedRoomBinding
        from gateway.hosted_room_discussion import validate_user_payload, resolve_mentions, validate_roster
        device = self._actor(device, owner=action != 'seen')
        operation = body.get('operation_id')
        if not isinstance(operation, str) or not _ID.fullmatch(operation):
            raise RoomError('A valid room request ID is required.', 400)
        canonical = json.dumps([device['role'], action, room_id, body], sort_keys=True, separators=(',', ':'))
        event_id = self._opaque(device, operation, action)
        with self._db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                old = db.execute('SELECT * FROM winglet_room_ops WHERE id=?', (operation,)).fetchone()
                # Check visibility before replaying even a previously successful read/write.
                row = self._room(db, device, room_id) if room_id else None
                if old:
                    if old['device'] != device['id'] or old['payload'] != canonical:
                        raise RoomError('That request ID was used for another room operation.')
                    return json.loads(old['result'])
                if action!='seen' and db.execute('SELECT COUNT(*) FROM winglet_room_ops').fetchone()[0]>=100_000:
                    raise RoomError('Room operation history is full. Export it before server maintenance.')
                if action != 'seen' and not self.available():
                    raise RoomError('Room execution is unavailable. Reconnect before changing this room.')
                if row and action in ('update', 'send') and body.get('revision') != row['revision']:
                    raise RoomError('This room changed. Reload it before continuing.')
                if action == 'create':
                    if db.execute('SELECT COUNT(*) FROM winglet_rooms').fetchone()[0] >= 128:
                        raise RoomError('This gateway has reached its 128 room limit.')
                    members, title = self._members(body.get('bots')), clean_title(body.get('title'))
                    root_id = self._opaque(device, operation, 'identity')
                    epoch_id = root_id + '-initial'
                    self.worker.create_room(room_id=epoch_id, name=title, members=members)
                    now = time.time()
                    db.execute('INSERT INTO winglet_rooms(id,title,members,epochs,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                               (root_id, title, json.dumps(members), json.dumps([epoch_id]), now, now))
                    answer = {'id': root_id}
                elif action == 'seen':
                    current = self._state(row, device, db)['latest']
                    cursor = body.get('cursor')
                    if (not isinstance(cursor, list) or len(cursor) != 2
                            or not all(type(x) is int and x >= 0 for x in cursor) or cursor > current):
                        raise RoomError('Invalid room read position.', 400)
                    db.execute('INSERT INTO winglet_room_seen VALUES(?,?,?,?) ON CONFLICT(room,device) DO UPDATE SET '
                               'epoch=excluded.epoch,seq=excluded.seq WHERE excluded.epoch>epoch OR (excluded.epoch=epoch AND excluded.seq>seq)',
                               (room_id, device['id'], *cursor))
                    answer = {'seen': cursor}
                else:
                    epochs = json.loads(row['epochs'])
                    active = epochs[-1]
                    if action == 'send':
                        if row['archived']:
                            raise RoomError('Restore this room before sending.')
                        text = body.get('text')
                        payload = validate_user_payload({'text': text, 'thread_id': room_id})
                        roster = validate_roster(json.loads(row['members']), local_profiles=self.worker.local_profiles())
                        recipients = resolve_mentions((payload['text'],), roster, default_all=False)
                        if not recipients:
                            raise RoomError('Address a bot with @mention before sending.', 400)
                        if any(member.profile not in {b['name'] for b in self.catalog() if b['served']} for member in recipients):
                            raise RoomError('An addressed bot is unavailable.')
                        # Bound concurrent human submissions; the upstream scheduler bounds
                        # each discussion to three rounds and ten bot messages.
                        # A crash can occur after upstream append/admission but before
                        # our receipt commits. Recognize that exact immutable event
                        # before applying the busy check to a retry.
                        with sqlite3.connect(self.worker.db_path) as runtime_db:
                            accepted = runtime_db.execute('SELECT payload_json FROM hosted_room_events WHERE room_id=? AND event_id=?',
                                                          (active,event_id)).fetchone()
                        if accepted and json.loads(accepted[0]) != payload:
                            raise RoomError('That room event ID was used for another message.')
                        if not accepted and self.worker.status(active).get('working'):
                            raise RoomError('Wait for this room turn to finish or Stop it first.')
                        state = hosted_rooms.room_state(self.worker.db_path, room_id=active)
                        hosted_rooms.append_event(self.worker.db_path, room_id=active, event_id=event_id,
                            kind='message.user', actor={'kind':'user','id':'winglet:'+device['id']}, payload=payload,
                            authority_gateway_id=state['authority_gateway_id'], authority_epoch=state['authority_epoch'])
                        self.worker.prepare_room(HostedRoomBinding(active,state['authority_gateway_id'],state['authority_epoch']))
                        self.worker.wakeup()
                        answer = {'accepted': True}
                    elif action == 'update':
                        title = clean_title(body.get('title', row['title']))
                        existing_members = json.loads(row['members'])
                        existing_profiles = [m['profile'] for m in existing_members]
                        requested_profiles = body.get('bots', existing_profiles)
                        # An unavailable roster member must not prevent renaming,
                        # access revocation or archiving an existing room.
                        members = existing_members if requested_profiles==existing_profiles else self._members(requested_profiles)
                        archived = body.get('archived', bool(row['archived']))
                        readers = body.get('readers', json.loads(row['readers']))
                        if type(archived) is not bool or not isinstance(readers, list) or len(readers)>100 or not all(isinstance(x,str) for x in readers):
                            raise RoomError('Invalid room access settings.', 400)
                        readers = sorted(set(readers))
                        if any(self.hub.store.get_device(x) is None for x in readers):
                            raise RoomError('A selected participant is no longer paired.', 400)
                        if members != json.loads(row['members']) or archived:
                            self.worker.stop_room(active, cancel_id=event_id, require_acknowledged=True)
                        if members != json.loads(row['members']):
                            if len(epochs)>=32:
                                raise RoomError('This room has reached its 32 roster changes. Create a new room.')
                            successor = self._opaque(device, operation, 'roster')
                            self.worker.create_room(room_id=successor, name=title, members=members)
                            epochs.append(successor)
                        elif title != row['title']:
                            hosted_rooms.rename_room(self.worker.db_path, room_id=active,event_id=event_id,name=title)
                        db.execute('UPDATE winglet_rooms SET title=?,members=?,epochs=?,archived=?,readers=?,revision=revision+1,updated_at=? WHERE id=?',
                            (title,json.dumps(members),json.dumps(epochs),int(archived),json.dumps(readers),time.time(),room_id))
                        answer = {'updated': True}
                    elif action == 'stop':
                        self.worker.stop_room(active,cancel_id=event_id)
                        answer = {'status':'stopping' if self.worker.status(active).get('working') else 'stopped'}
                    elif action in ('retry','approve'):
                        if callable(getattr(self.worker,'author_allowed',None)) and not self.worker.author_allowed(active):
                            self.worker.stop_room(active,cancel_id='winglet-author-revoked')
                            raise RoomError('The turn author no longer has owner permission. Start a new addressed discussion.')
                        pending = self.worker.status(active).get('pending_actions') or []
                        fields = ('task_id',) if action=='retry' else ('task_id','member_id','execution_generation','request_id')
                        expected_kind = 'retry' if action=='retry' else 'approval'
                        if not any(p.get('kind')==expected_kind and all(p.get(k)==body.get(k) for k in fields) for p in pending):
                            raise RoomError('That room request is no longer pending.')
                        if action=='retry':
                            self.worker.retry_room_task(active,task_id=body['task_id'])
                        else:
                            self.worker.approve_room_task(active,**{k:body[k] for k in fields},choice=body.get('choice'))
                        answer = {'accepted': True}
                    else:
                        raise RoomError('Unknown room operation.', 400)
                    if action=='send':
                        db.execute('UPDATE winglet_rooms SET updated_at=? WHERE id=?',(time.time(),room_id))
                if action!='seen':
                    # Retain mutation identities rather than evicting an old request
                    # and making it executable again. Read cursors are monotonic by nature.
                    db.execute('INSERT INTO winglet_room_ops VALUES(?,?,?,?)',(operation,device['id'],canonical,json.dumps(answer)))
                db.commit()
            except Exception:
                db.rollback()
                raise
        self.hub.audit('room.'+action, device, summary=f'Room {room_id or answer.get("id", "")}')
        return answer

    async def close(self):
        await asyncio.to_thread(self.worker.stop, timeout=5)
