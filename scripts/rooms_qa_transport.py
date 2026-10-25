"""Non-network agent transport for the disposable native room fixture only.

The real Hermes driver owns scheduling/persistence/cancellation. This transport
deliberately uses synthetic replies and does not establish provider behavior.
"""
import threading


class RoomFixtureRPC:
    def __init__(self, delay=1.5):
        self.delay = delay
        self.sessions = {}
        self.pending = {}
        self.lock = threading.RLock()
        self.calls = []

    def resolve_exact(self, *, profile, title, source):
        assert source == 'bot_room'
        return self.sessions.get((profile,title))

    def create(self, *, profile, title, source):
        assert source == 'bot_room'
        with self.lock:
            row={'session_id':f'qa-room-{profile}-{len(self.sessions)}','title':title}
            self.sessions[profile,title]=row
            return row

    def resume(self, *, profile, session_id, source):
        assert source == 'bot_room'
        return {'session_id':session_id}

    def submit(self, **kwargs):
        with self.lock:
            self.calls.append((kwargs['profile'],kwargs['task'].room_id))
            self.pending[kwargs['session_id']]=kwargs
        timer=threading.Timer(self.delay,self.finish,args=(kwargs['session_id'],))
        timer.daemon=True
        timer.start()
        return {'accepted':True}

    def finish(self, session_id):
        with self.lock:
            turn=self.pending.pop(session_id,None)
        if turn:
            text=('The release checklist is ready.\n\n- Check connection recovery\n- Keep drafts after a restart\n- Confirm Stop before ending work'
                  if turn['profile']=='default' else
                  'I checked the rollout plan.\n\n**Ready for device review:** signatures, room isolation and retries.\n\nThese are synthetic QA replies; no provider was called.')
            turn['on_terminal']({'status':'settled','text':text})

    def history(self, **kwargs):
        return []

    def info(self, *, session_id, **kwargs):
        with self.lock:
            turn=self.pending.get(session_id)
            return {'active':bool(turn),'task_id':turn['task'].task_id if turn else None}

    def interrupt(self, *, session_id, expected_task_id, **kwargs):
        with self.lock:
            turn=self.pending.get(session_id)
            if turn and turn['task'].task_id!=expected_task_id:
                raise RuntimeError('Fixture refused a mismatched task cancellation')
            self.pending.pop(session_id,None)
        if turn:
            turn['on_terminal']({'status':'cancelled','reason':'Stopped from the QA room'})
        return {'interrupted':True}
