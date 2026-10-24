import json
import pytest
from plugin.hub import Hub, ROUTE_POLICY
from plugin.store import Store
from test_trust import pair_phone


class RoomFixture:
    def __init__(self): self.calls=[]
    def available(self): return True
    def listing(self,device): return {'rooms':[],'can_create':device['role']=='owner'}
    def state(self,device,room_id): return {'id':room_id}
    def log(self,*args): return {'events':[]}
    def mutate(self,device,action,room_id,body):
        from plugin.rooms import RoomError
        if action!='seen' and device['role']!='owner': raise RoomError('Only an owner can execute room turns.',403)
        self.calls.append((device['id'],action))
        return {'accepted':True}
    async def close(self): pass


@pytest.fixture
def hub(tmp_path):
    store=Store(tmp_path/'db.sqlite')
    hub=Hub(store,web_root=tmp_path/'web')
    hub.rooms=RoomFixture()
    yield hub
    store.close()


@pytest.fixture
async def client(aiohttp_client,hub): return await aiohttp_client(hub.build_app())


async def test_room_routes_require_pairing_signatures_and_fresh_owner_role(client,hub):
    assert (await client.get('/api/rooms')).status==401
    phone=await pair_phone(client,hub)
    assert (await client.get('/api/rooms',headers=phone.auth)).status==200
    path='/api/rooms/example/send'
    body=json.dumps({'operation_id':'test-operation-123','text':'@main hello'}).encode()
    assert (await client.post(path,headers=phone.auth,data=body)).status==403
    signed=phone.signed('POST',path,body)
    response=await client.post(path,headers={**signed,'Content-Type':'application/json'},data=body)
    assert response.status==200,await response.text()
    assert hub.rooms.calls==[(phone.id,'send')]
    hub.store.add_device('Remaining owner','test',role='owner',verified=True)
    hub.store.update_device(phone.id,role='member')
    signed=phone.signed('POST',path,body)
    assert (await client.post(path,headers={**signed,'Content-Type':'application/json'},data=body)).status==403
    assert len(hub.rooms.calls)==1


def test_room_policy_does_not_expose_unsigned_controls():
    assert ROUTE_POLICY['h_room_create']=='owner_signed'
    assert ROUTE_POLICY['h_room_action']=='signed'
