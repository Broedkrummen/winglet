import copy
import hashlib
import json
import pytest
from plugin.hub import Hub, MessageRejected
from plugin.store import Store
from plugin.transcript_quotes import validate_anchor
from test_trust import pair_phone


def anchor(message, selected, occurrence=0):
    start=-1
    for _ in range(occurrence+1): start=message['text'].index(selected,start+1)
    units=lambda s:len(s.encode('utf-16-le'))//2
    return {'v':1,'message_id':message['id'],'chat_id':message['chat_id'],'start':units(message['text'][:start]),
            'end':units(message['text'][:start+len(selected)]),'text':selected,
            'source_hash':hashlib.sha256(message['text'].encode()).hexdigest()}


@pytest.fixture
def env(tmp_path):
    store=Store(tmp_path/'quotes.sqlite')
    hub=Hub(store,web_root=tmp_path/'web')
    owner,_=store.add_device('Owner','test',role='owner',verified=True)
    member,_=store.add_device('Member','test',role='member',verified=True)
    other,_=store.add_device('Other','test',role='member',verified=True)
    chat=store.create_chat('Source',owner_device=owner['id'])
    source=store.add_message(chat['id'],'bot','First 🌱 repeated quote, then repeated quote.\n```py\nprint("safe")\n```\n| a | b |\n|---|---|\nMath: $x^2$. <script>no()</script>')
    yield hub,store,owner,member,other,chat,source
    store.close()


def test_utf16_repeated_quotes_code_math_tables_and_markup_are_exact(env):
    *_,source=env
    for text,which in [('🌱',0),('repeated quote',1),('print("safe")',0),('| a | b |',0),('$x^2$',0),('<script>no()</script>',0)]:
        chosen=anchor(source,text,which)
        assert validate_anchor(source,chosen)==chosen


@pytest.mark.parametrize('mutation', [
    {'v':True},{'v':2},{'start':True},{'start':-1},{'end':9999999},{'text':'forged'},
    {'source_hash':'0'*64},{'source_hash':'bad'},{'chat_id':'wrong'},{'message_id':'wrong'},
])
def test_bad_or_forged_anchors_are_refused(env,mutation):
    *_,source=env
    value=anchor(source,'🌱');value.update(mutation)
    with pytest.raises(ValueError):validate_anchor(source,value)


def test_surrogate_split_blank_oversized_streaming_or_changed_source_refused(env):
    *_,source=env
    value=anchor(source,'🌱');value['end']-=1
    with pytest.raises(ValueError):validate_anchor(source,value)
    for status in ('streaming','failed','pending'):
        with pytest.raises(ValueError):validate_anchor({**source,'status':status},anchor(source,'quote'))
    changed={**source,'text':source['text']+' edited'}
    with pytest.raises(ValueError):validate_anchor(changed,anchor(source,'quote'))
    blank={**source,'text':' '*10}
    with pytest.raises(ValueError):validate_anchor(blank,anchor(blank,' '))
    huge={**source,'text':'x'*4001}
    with pytest.raises(ValueError):validate_anchor(huge,anchor(huge,huge['text']))


async def test_only_selected_context_is_given_to_model_and_retry_is_idempotent(env):
    hub,store,owner,_,_,chat,source=env
    sent=[]
    async def deliver(*args,**kwargs):sent.append(kwargs.get('reply'))
    hub.on_user_message=deliver
    value=anchor(source,'repeated quote',1)
    msg=await hub.user_message(owner,chat['id'],'Explain this',client_id='quote-test-once',reply_to=source['id'],quote=value)
    assert sent[0]['text']=='repeated quote'
    assert msg['meta']['reply_to']['quote']==value
    store.update_message(source['id'],'Edited after accepted')
    again=await hub.user_message(owner,chat['id'],'Explain this',client_id='quote-test-once',reply_to=source['id'],quote=value)
    assert again['id']==msg['id'] and len(sent)==1


async def test_side_question_may_use_visible_same_bot_source_without_copying_transcript(env):
    hub,store,owner,_,_,chat,source=env
    side=store.create_chat('Side question',owner_device=owner['id'])
    msg=await hub.user_message(owner,side['id'],'Why?',reply_to=source['id'],quote=anchor(source,'quote'))
    assert msg['meta']['reply_to']['text']=='quote'
    assert len(store.list_messages(side['id']))==1
    assert store.get_message(source['id'])['text']==source['text']


async def test_other_members_cross_bot_and_revoked_devices_cannot_quote(env):
    hub,store,owner,member,other,chat,source=env
    own=store.create_chat('Member own',owner_device=member['id'])
    with pytest.raises(MessageRejected):
        await hub.user_message(member,own['id'],'Why?',reply_to=source['id'],quote=anchor(source,'quote'))
    other_bot=store.create_chat('Other bot',owner_device=owner['id'],bot='other-bot')
    with pytest.raises(MessageRejected):
        await hub.user_message(owner,other_bot['id'],'Why?',reply_to=source['id'],quote=anchor(source,'quote'))
    store.add_device('Backup owner','test',role='owner',verified=True)
    store.update_device(owner['id'],role='member')
    with pytest.raises(MessageRejected):
        await hub.user_message(owner,own['id'],'Why?',reply_to=source['id'],quote=anchor(source,'quote'))


async def test_member_can_quote_their_own_chat_and_stale_sources_do_not_send(env):
    hub,store,_,member,_,_,_=env
    chat=store.create_chat('Own',owner_device=member['id'])
    source=store.add_message(chat['id'],'bot','Your own reply')
    msg=await hub.user_message(member,chat['id'],'Explain',reply_to=source['id'],quote=anchor(source,'own'))
    assert msg['meta']['reply_to']['text']=='own'
    old=anchor(source,'own')
    store.update_message(source['id'],'Changed')
    with pytest.raises(MessageRejected):
        await hub.user_message(member,chat['id'],'No',reply_to=source['id'],quote=old)
    assert len(store.list_messages(chat['id']))==2


async def test_quote_http_contract_and_old_reply_behavior(env,aiohttp_client):
    hub,store,owner,_,_,chat,source=env
    client=await aiohttp_client(hub.build_app())
    phone=await pair_phone(client,hub)
    try:
        path=f"/api/chats/{chat['id']}/messages"
        value=anchor(source,'🌱')
        response=await client.post(path,json={'text':'Explain','reply_to':source['id'],'quote':value},headers=phone.auth)
        assert response.status==200,await response.text()
        meta=(await response.json())['message']['meta']['reply_to']
        assert meta['text']=='🌱' and meta['quote']['start']==value['start']
        response=await client.post(path,json={'text':'Legacy reply','reply_to':source['id']},headers=phone.auth)
        assert response.status==200
        assert 'quote' not in (await response.json())['message']['meta']['reply_to']
        response=await client.post(path,json={'text':'No source','quote':value},headers=phone.auth)
        assert response.status==400
    finally:await client.close()


def test_real_hermes_preserves_exact_partial_reply_context():
    from types import SimpleNamespace
    inbound=pytest.importorskip('gateway.run_inbound')
    from gateway.platforms.base import Platform
    selected='A seedling 🌱 needs care.\nprint("water daily")'
    event=SimpleNamespace(reply_to_text=selected,reply_to_message_id='source',reply_to_is_own_message=True)
    result=inbound.GatewayInboundMixin._prepend_inbound_reply_context(event,SimpleNamespace(platform=Platform.TELEGRAM),'Why?')
    assert selected in result and result.endswith('Why?')
    assert 'unselected source text' not in result

