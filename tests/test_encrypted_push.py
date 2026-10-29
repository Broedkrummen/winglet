import base64
import json
import os
import struct
import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from plugin import encrypted_push as push
from plugin.hub import Hub
from plugin.store import Store
from test_trust import Phone, pair_phone, seal as provision_seal

KEY=push.b64(bytes(range(32)))
KID='a'*32


def enrollment(kid=KID, key=KEY, endpoint='https://ntfy.sh/up/fixture'):
    pub=ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint)
    return {'v':1,'kid':kid,'key':key,'previous_kid':None,'revision':1,'subscription':{'endpoint':endpoint,'keys':{'p256dh':push.b64(pub),'auth':push.b64(os.urandom(16))}}}


def open_envelope(envelope,server='server',device='phone',key=KEY):
    # Independent length framing for cross-language contract checks.
    fields=['winglet.push','1',server,device,envelope['kid'],'notification']
    aad=b''.join(struct.pack('!I',len(text.encode()))+text.encode() for text in fields)
    return json.loads(AESGCM(push.unb64(key)).decrypt(push.unb64(envelope['nonce']),push.unb64(envelope['ct']),aad))


def test_roundtrip_nonce_uniqueness_private_headers_and_bounded_unicode():
    note={'title':'Private bot','body':'🌱'*600,'url':'/chat/server/chat','actions':[{'choice':'approve'}],'secret':'never'}
    envelopes=[push.seal(KEY,KID,'server','phone',note,now=100,event_id='b'*32) for _ in range(40)]
    assert len({env['nonce'] for env in envelopes})==40
    assert all(len(json.dumps(env).encode())<=push.MAX_ENVELOPE for env in envelopes)
    value=open_envelope(envelopes[0]);assert value['id']=='b'*32 and value['expires']==86500
    assert value['note']['body']=='🌱'*150
    assert 'actions' not in value['note'] and 'secret' not in value['note']
    assert 'Private bot' not in json.dumps(envelopes[0]) and 'server' not in json.dumps(envelopes[0])


def test_tamper_wrong_key_server_device_and_key_identifier_are_refused():
    env=push.seal(KEY,KID,'server','phone',{'body':'private'})
    for fields in [{'server':'other'},{'device':'other'},{'key':push.b64(os.urandom(32))}]:
        with pytest.raises(InvalidTag):open_envelope(env,**fields)
    for field in ['nonce','ct']:
        changed=dict(env);raw=bytearray(push.unb64(changed[field]));raw[0]^=1;changed[field]=push.b64(bytes(raw))
        with pytest.raises(InvalidTag):open_envelope(changed)
    with pytest.raises(InvalidTag):open_envelope({**env,'kid':'b'*32})


@pytest.mark.parametrize('value',['AA==','not base64','_','',None])
def test_noncanonical_malformed_keys_are_rejected(value):
    with pytest.raises((ValueError,TypeError)):push.unb64(value,32)


def test_rotation_device_scope_idempotency_and_sticky_privacy(tmp_path):
    store=Store(tmp_path/'push.db')
    first,_=store.add_device('One','android',sign_key=Phone('One').public,verified=True)
    second,_=store.add_device('Two','android',sign_key=Phone('Two').public,verified=True)
    data=enrollment();push.enroll(store,first['id'],data,'https://ntfy.sh')
    data['previous_kid']=KID
    push.enroll(store,first['id'],data,'https://ntfy.sh')
    assert len(store.list_push_subs(push.KIND))==1
    with pytest.raises(ValueError):push.enroll(store,second['id'],data,'https://ntfy.sh')
    with pytest.raises(ValueError):push.enroll(store,first['id'],{**data,'key':push.b64(os.urandom(32))},'https://ntfy.sh')
    rotated=enrollment('b'*32,push.b64(os.urandom(32)),'https://ntfy.sh/up/new')
    rotated['previous_kid']=KID
    push.enroll(store,first['id'],rotated,'https://ntfy.sh')
    assert push.enrolled(store,first['id'])['data']['kid']=='b'*32
    assert 'key' not in json.dumps(push.status(store,first['id'],{}))
    push.revoke(store,first['id']);assert push.enrolled(store,first['id']) is None
    assert push.status(store,first['id'],{})['encrypted_required']
    rotated['previous_kid']=None
    push.enroll(store,first['id'],rotated,'https://ntfy.sh');store.remove_device(first['id'])
    assert push.enrolled(store,first['id']) is None
    store.close()


def test_late_rotation_endpoint_sync_and_revoked_enrollment_cannot_roll_back_state(tmp_path):
    store=Store(tmp_path/'compare.db');device,_=store.add_device('Phone','android',sign_key=Phone('One').public,verified=True)
    first=enrollment();push.enroll(store,device['id'],first,'https://ntfy.sh')
    newer={**first,'previous_kid':KID,'revision':2,'subscription':{**first['subscription'],'endpoint':'https://ntfy.sh/up/migrated'}}
    push.enroll(store,device['id'],newer,'https://ntfy.sh')
    with pytest.raises(ValueError):push.enroll(store,device['id'],{**first,'previous_kid':KID},'https://ntfy.sh')
    rotated=enrollment('b'*32);rotated['previous_kid']=KID
    push.enroll(store,device['id'],rotated,'https://ntfy.sh')
    with pytest.raises(ValueError):push.enroll(store,device['id'],newer,'https://ntfy.sh')
    push.revoke(store,device['id'])
    with pytest.raises(ValueError):push.enroll(store,device['id'],{**rotated,'previous_kid':'b'*32},'https://ntfy.sh')
    store.close()


@pytest.mark.parametrize('endpoint',['http://ntfy.sh/up/x','https://localhost/private','https://ntfy.sh.evil.example/up/x',
    'https://user:pass@ntfy.sh/up/x','https://ntfy.sh/up/x#fragment','https://ntfy.sh:443@evil.example/up/x','https://ntfy.sh/'])
def test_enrollment_cannot_post_to_unconfigured_targets(endpoint):
    with pytest.raises(ValueError):push.validate_enrollment(enrollment(endpoint=endpoint),'https://ntfy.sh')


async def test_http_requires_current_signature_sealing_scope_and_blocks_old_plaintext(tmp_path,aiohttp_client):
    store=Store(tmp_path/'api.db');hub=Hub(store,web_root=tmp_path/'web')
    client=await aiohttp_client(hub.build_app());phone=await pair_phone(client,hub)
    key_info=await(await client.get('/api/server-key')).json()
    data=enrollment()
    blob={'sealed':provision_seal(key_info,'push-key',data,phone.id)}
    body=json.dumps(blob).encode()
    response=await client.post('/api/push/encrypted',data=body,headers=phone.auth);assert response.status==403
    response=await client.post('/api/push/encrypted',data=body,headers=phone.signed('POST','/api/push/encrypted',body))
    assert response.status==200,await response.text()
    result=await response.json();assert result['enrolled'] and result['kid']==KID
    assert 'fixture' not in json.dumps(result) and KEY not in json.dumps(result)
    response=await client.get('/api/push/ntfy',headers=phone.auth);assert response.status==409
    # Even a copied sealed enrollment cannot be used by another signed pairing.
    other=await pair_phone(client,hub,name='Other')
    response=await client.post('/api/push/encrypted',data=body,headers=other.signed('POST','/api/push/encrypted',body));assert response.status==400
    response=await client.delete('/api/push/encrypted',headers=phone.signed('DELETE','/api/push/encrypted'))
    assert response.status==200
    response=await client.get('/api/push/ntfy',headers=phone.auth);assert response.status==409
    await client.close();store.close()


async def test_dispatch_uses_encrypted_webpush_without_plaintext_route_fallback(tmp_path,monkeypatch):
    store=Store(tmp_path/'dispatch.db');hub=Hub(store,web_root=tmp_path/'web')
    device,_=store.add_device('Phone','android',role='owner',sign_key=Phone('One').public,verified=True)
    push.enroll(store,device['id'],enrollment(),'https://ntfy.sh')
    store.add_push_sub(device['id'],'ntfy','https://ntfy.sh/legacy',{'topic':'legacy'})
    captured=[]
    async def send(client,sub,note,*args,**kwargs):captured.append(note);return 201
    monkeypatch.setattr('plugin.webpush.send',send)
    result=await hub.push_now({'title':'Secret title','body':'Secret body','kind':'test'},tag='test',device_id=device['id'])
    assert result=={'accepted':1,'failed':0,'expired':0}
    assert len(captured)==1 and captured[0]['v']==1
    assert open_envelope(captured[0],hub.server_id(),device['id'])['note']['body']=='Secret body'
    push.revoke(store,device['id'])
    assert (await hub.push_now({'kind':'test'},tag='again',device_id=device['id']))['accepted']==0
    assert len(captured)==1
    await hub.aclose();store.close()


async def test_encrypted_delivery_keeps_mutes_and_foreground_message_deduplication(tmp_path,monkeypatch):
    store=Store(tmp_path/'prefs.db');hub=Hub(store,web_root=tmp_path/'web')
    device,_=store.add_device('Phone','android',role='owner',sign_key=Phone('One').public,verified=True)
    push.enroll(store,device['id'],enrollment(),'https://ntfy.sh')
    sent=[]
    async def send(*args,**kwargs):sent.append(args[2]);return 201
    monkeypatch.setattr('plugin.webpush.send',send)
    store.set_push_prefs(device['id'],{'muted':{'*':0}})
    assert (await hub.push_now({'kind':'message'},tag='muted'))['accepted']==0
    store.set_push_prefs(device['id'],{})
    class Socket:
        closed=False
    hub._sockets[Socket()]={'device':device,'visible':True}
    assert (await hub.push_now({'kind':'message'},tag='foreground'))['accepted']==0
    assert (await hub.push_now({'kind':'test'},tag='explicit-test'))['accepted']==1
    assert len(sent)==1
    hub._sockets.clear();await hub.aclose();store.close()


async def test_webpush_guard_version_is_negotiated_and_scope_is_derived(tmp_path,monkeypatch):
    store=Store(tmp_path/'web.db');hub=Hub(store,web_root=tmp_path/'web')
    device,_=store.add_device('Web','web')
    subscription=enrollment(endpoint='https://fcm.googleapis.com/fixture')['subscription'];store.add_push_sub(device['id'],'webpush',subscription['endpoint'],{**subscription,'guard_v':1})
    captured=[]
    async def send(client,sub,note,*args,**kwargs):captured.append(note);return 201
    monkeypatch.setattr('plugin.webpush.send',send)
    await hub.push_now({'kind':'test','title':'Web test','body':'private','url':'/','device_id':'forged'},tag='web')
    note=captured.pop();assert note['guard_v']==1 and len(note['id'])==32
    assert note['device_id']==device['id'] and note['server_id']==hub.server_id()
    assert note['expires']-note['issued']==86400
    store.remove_push_sub(endpoint=subscription['endpoint'])
    store.add_push_sub(device['id'],'webpush',subscription['endpoint'],subscription)
    await hub.push_now({'kind':'test','title':'Legacy','body':'private','url':'/'},tag='legacy')
    assert 'guard_v' not in captured.pop()
    await hub.aclose();store.close()
