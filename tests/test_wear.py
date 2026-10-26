import asyncio
import hashlib
import json
import secrets
import struct
import time
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from plugin.encrypted_push import b64, unb64
from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone, seal


def aad(hub, device, nonce, purpose):
    fields=['winglet.wear.'+purpose,'1',hub.server_id(),device,nonce]
    return b''.join(struct.pack('!I',len(v.encode()))+v.encode() for v in fields)


@pytest.fixture
async def env(tmp_path,aiohttp_client):
    store=Store(tmp_path/'wear.db');store.ensure_chat('general','General')
    hub=Hub(store,web_root=tmp_path/'web');received=[]
    async def receive(chat,text,device,message,**extra):received.append((chat['id'],text,device['id']))
    hub.on_user_message=receive
    client=await aiohttp_client(hub.build_app());phone=await pair_phone(client,hub)
    info=await(await client.get('/api/server-key')).json()
    yield hub,store,client,phone,info,received
    await client.close();store.close()


async def link(env, *, phone=None, association=None, chats=None, can_reply=True, path='/api/wear/links'):
    hub,store,client,owner,info,_=env;phone=phone or owner
    nonce=secrets.token_hex(16);response_key=secrets.token_bytes(32)
    value={'v':1,'association':association or secrets.token_hex(16),'name':'QA watch','chat_ids':chats or ['general'],
           'can_reply':can_reply,'response_key':b64(response_key),'nonce':nonce}
    body=json.dumps({'sealed':seal(info,'wear-link',value,phone.id)}).encode()
    response=await client.post(path,data=body,headers=phone.signed('POST',path,body))
    if response.status!=200:return response.status,await response.json()
    wire=await response.json()
    opened=json.loads(AESGCM(response_key).decrypt(unb64(wire['nonce']),unb64(wire['ct']),aad(hub,phone.id,nonce,'link')))
    assert opened['token'] not in json.dumps(wire)
    return response.status,opened


def packet(env,grant,op='read',data=None,**overrides):
    hub,_,_,phone,info,_=env
    response_key=secrets.token_bytes(32);nonce=secrets.token_hex(16)
    value={'v':1,'token':grant['token'],'op':op,'data':data or {},'issued':int(time.time()),'nonce':nonce,'response_key':b64(response_key),**overrides}
    return {'device_id':phone.id,'sealed':seal(info,'wear-relay',value,phone.id)},response_key,value['nonce']


async def relay(env,grant,op='read',data=None,**overrides):
    wire,key,nonce=packet(env,grant,op,data,**overrides)
    return await post_packet(env,wire,key,nonce)


async def post_packet(env,wire,key,nonce):
    hub,_,client,phone,_,_=env
    response=await client.post('/api/wear/relay',json=wire)
    assert response.status==200,await response.text()
    envelope=await response.json()
    return json.loads(AESGCM(key).decrypt(unb64(envelope['nonce']),unb64(envelope['ct']),aad(hub,phone.id,nonce,'response')))


async def test_link_is_signed_sealed_scoped_and_idempotent(env):
    hub,store,client,phone,_,_=env
    response=await client.post('/api/wear/links',json={'association':'a'*32},headers=phone.auth);assert response.status==403
    status,grant=await link(env,association='a'*32);assert status==200
    status,retry=await link(env,association='a'*32);assert status==200 and retry==grant
    assert len(store._all('SELECT id FROM winglet_wear_links'))==1
    status,_=await link(env,association='a'*32,can_reply=False);assert status==409
    response=await client.get('/api/wear/links',headers=phone.auth)
    listed=await response.json();assert listed['links'][0]['association']=='a'*32
    assert listed['links'][0]['can_reply'] is True
    assert grant['token'] not in json.dumps(listed) and 'token_hash' not in json.dumps(listed)
    assert grant['token'] not in str(dict(store._one('SELECT * FROM winglet_wear_links')))


async def test_read_is_bounded_and_activity_hidden_data_never_replaces_conversation(env):
    hub,store,_,_,_,_=env;_,grant=await link(env)
    store.add_message('general','bot','Private visible 🌱'*200)
    for _ in range(50):store.add_message('general','bot','HIDDEN',meta={'activity':True})
    hub._typing.add('general')
    result=await relay(env,grant,data={'chat_id':'general'})
    assert result['chats'][0]['state']=='working'
    assert len(result['messages'])==1 and 'HIDDEN' not in json.dumps(result)
    assert len(result['messages'][0]['text'].encode())<=700
    assert 'token' not in result and 'url' not in result


async def test_replies_retry_exactly_once_and_reject_changed_identity_or_commands(env):
    *_,received=env;_,grant=await link(env)
    body={'chat_id':'general','request_id':'a'*32,'text':'A deliberate watch question'}
    first=await relay(env,grant,'send',body);second=await relay(env,grant,'send',body)
    assert first==second and first['status']=='accepted' and len(received)==1
    assert (await relay(env,grant,'send',{**body,'text':'Different body'}))['error']=='request_conflict'
    assert (await relay(env,grant,'send',{**body,'request_id':'b'*32,'text':' /reset'}))['error']=='invalid_reply'
    assert (await relay(env,grant,'approve',{'item_id':'private'}))['error']=='operation_not_allowed'


async def test_cipher_replay_expiry_wrong_pairing_and_plain_bearer_are_refused(env):
    _,_,client,_,_,_=env;_,grant=await link(env)
    wire,key,nonce=packet(env,grant)
    assert 'chats' in await post_packet(env,wire,key,nonce)
    assert (await post_packet(env,wire,key,nonce))['error']=='request_replayed'
    assert (await relay(env,grant,issued=int(time.time())-91))['error']=='request_expired'
    response=await client.post('/api/wear/relay',json={},headers={'Authorization':'Bearer '+grant['token']});assert response.status==400
    response=await client.post('/api/wear/relay',json={**wire,'device_id':'wrong'});assert response.status==400


async def test_revoke_role_change_deleted_chats_and_pairing_removal_take_effect(env):
    hub,store,client,phone,_,_=env;_,grant=await link(env)
    other=store.create_chat('Not shared')
    assert (await relay(env,grant,data={'chat_id':other['id']}))['error']=='conversation_not_shared'
    path='/api/wear/links/'+grant['id']
    response=await client.delete(path,headers=phone.signed('DELETE',path));assert response.status==200
    assert (await relay(env,grant))['error']=='link_revoked'
    _,grant=await link(env)
    store.add_device('Backup','android',role='owner')
    store.update_device(phone.id,role='member')
    assert (await relay(env,grant))['error']=='pairing_changed'
    store.remove_device(phone.id)
    assert (await relay(env,grant))['error']=='pairing_changed'


async def test_members_can_only_grant_their_own_current_bot_chats(env):
    hub,store,client,owner,info,received=env
    member=await pair_phone(client,hub,name='Member',role='member')
    status,_=await link(env,phone=member,chats=['general']);assert status==404
    own=store.create_chat('Own',owner_device=member.id)
    status,grant=await link(env,phone=member,chats=[own['id']]);assert status==200
    member_env=(hub,store,client,member,info,received)
    assert (await relay(member_env,grant,data={'chat_id':own['id']}))['chat_id']==own['id']
    foreign=store.create_chat('Another bot',bot='other')
    status,_=await link(env,chats=[foreign['id']]);assert status==403


async def test_read_only_watch_never_gains_reply_authority(env):
    _,grant=await link(env,can_reply=False)
    assert not (await relay(env,grant))['can_reply']
    value=await relay(env,grant,'send',{'chat_id':'general','request_id':'a'*32,'text':'No'})
    assert value['error']=='reply_not_allowed'


async def test_cold_server_reopens_grants_and_exact_reply_without_duplicate_delivery(env,tmp_path):
    hub,store,_,phone,_,received=env;_,grant=await link(env,association='e'*32)
    body={'chat_id':'general','request_id':'f'*32,'text':'Accepted before an acknowledgement was lost'}
    first=await relay(env,grant,'send',body)
    db=store._one('PRAGMA database_list')['file']
    reopened=Store(db)
    try:
        cold=Hub(reopened,web_root=tmp_path/'cold-web');cold.on_user_message=hub.on_user_message
        assert cold.wear.authorize(grant['token'],phone.id)[0]['id']==grant['id']
        second=await cold.wear.send(grant['token'],phone.id,body)
        assert first==second and len(received)==1
        assert cold.wear.token(grant['id'],phone.id,'e'*32)==grant['token']
        with pytest.raises(ValueError,match='request_conflict'):
            await cold.wear.send(grant['token'],phone.id,{**body,'text':'Changed after reconnect'})
        reopened.remove_device(phone.id)
        with pytest.raises(PermissionError):cold.wear.authorize(grant['token'],phone.id)
    finally:reopened.close()


async def test_concurrent_retries_deliver_one_message_and_response_context_is_authenticated(env):
    *_,received=env;_,grant=await link(env)
    body={'chat_id':'general','request_id':'c'*32,'text':'One message even with concurrent retries'}
    results=await asyncio.gather(*(relay(env,grant,'send',body) for _ in range(4)))
    assert all(value==results[0] for value in results) and len(received)==1
    hub,_,client,phone,_,_=env
    wire,key,nonce=packet(env,grant)
    envelope=await(await client.post('/api/wear/relay',json=wire)).json()
    for context in [aad(hub,'different-device',nonce,'response'),aad(hub,phone.id,'0'*32,'response'),aad(hub,phone.id,nonce,'link')]:
        with pytest.raises(Exception):AESGCM(key).decrypt(unb64(envelope['nonce']),unb64(envelope['ct']),context)
