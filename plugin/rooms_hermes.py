"""Feature-owned hosted-room worker using the installed Hermes scheduler and RPCs."""
from pathlib import Path
import json
import sqlite3


def build_worker(adapter, db_path: Path, hub):
    from tui_gateway import server
    from tui_gateway.hosted_room_service import HostedRoomService
    from tui_gateway.hosted_room_server_rpc import HostedRoomServerRPC
    from hermes_cli.profiles import _get_default_hermes_home
    from tools.bot_relay import acquire_turn_lock

    required = ('session.list', 'session.create', 'session.resume', 'prompt.submit',
                'session.history', 'session.interrupt', 'approval.respond')
    if not all(callable(server._methods.get(name)) for name in required):
        raise RuntimeError('Hermes room session handlers are unavailable')

    class RoomRPC(HostedRoomServerRPC):
        def _guard(self, profile, sid):
            # A title is not proof of ownership. Check the actual profile DB before
            # adopting a persisted room session (including a compression tip).
            with server._profile_db({'profile': profile}, writer=False) as db:
                row = db.get_session(sid) if db is not None else None
            if row is not None:
                if row.get('source') != 'bot_room' or not row.get('hidden'):
                    raise RuntimeError('Refusing to adopt a non-room session')
                return
            record = self._session_record(sid)
            if (record is None or record.get('source') != 'bot_room'
                    or not record.get('room_plumbing') or not record.get('pending_hidden')):
                raise RuntimeError('Room session identity could not be verified')

        def resolve_exact(self, *, profile, title, source):
            result = self._call('session.list', {'profile': profile, 'title': title, 'include_hidden': True})
            rows = result.get('sessions') or []
            if not rows:
                return None
            row = rows[0]
            if row.get('source') != 'bot_room':
                raise RuntimeError('A private session has this room title; refusing to reuse it')
            sid = row.get('resolved_id') or row.get('id')
            self._guard(profile, sid)
            return {'session_id': sid, 'title': row.get('title') or title}

        def create(self, *, profile, title, source):
            result = super().create(profile=profile, title=title, source=source)
            self._guard(profile, result['session_id'])
            return result

        def resume(self, *, profile, session_id, source):
            self._guard(profile, session_id)
            return super().resume(profile=profile, session_id=session_id, source=source)

        def submit(self, **kwargs):
            self._guard(kwargs['profile'], kwargs['session_id'])
            return super().submit(**kwargs)

    class Worker(HostedRoomService):
        def bindings(self):
            metadata = db_path.with_name('rooms-meta.sqlite')
            if not metadata.exists():
                return ()
            with sqlite3.connect(metadata) as db:
                current = {json.loads(row[0])[-1] for row in db.execute('SELECT epochs FROM winglet_rooms WHERE archived=0')}
            return tuple(binding for binding in super().bindings() if binding.room_id in current)

        def prepare_room(self, binding):
            # A restart must not resume a queued privileged turn for an unpaired
            # or demoted author. Check on each policy cycle, including live turns.
            with sqlite3.connect(self.db_path) as db:
                last = db.execute("SELECT actor_json FROM hosted_room_events WHERE room_id=? AND kind='message.user' ORDER BY seq DESC LIMIT 1",
                                  (binding.room_id,)).fetchone()
            if last:
                actor_id = json.loads(last[0]).get('id','')
                actor = hub.store.get_device(actor_id.removeprefix('winglet:')) if actor_id.startswith('winglet:') else None
                if actor is None or actor.get('role')!='owner':
                    self.stop_room(binding.room_id,cancel_id='winglet-author-revoked')
                    return
            super().prepare_room(binding)

        def local_profiles(self):
            state = adapter._bots_state()
            return tuple(['default'] + [b['name'] for b in state['bots'] if b.get('served')])

        def _turn_lock(self, profile):
            return acquire_turn_lock(_get_default_hermes_home(), profile)

    worker = Worker(server, db_path=db_path)
    rpc = RoomRPC(server)
    worker.rpc = rpc
    worker.runtime.rpc = rpc
    return worker
