"""Narrow, revocable phone-side grants for a Wear companion; never approval authority."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import secrets
import struct
import time

from aiohttp import web
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from . import keys
from .encrypted_push import b64, unb64, _clip

_ID = re.compile(r'^[a-f0-9]{32}$')
LIFETIME = 30 * 86400


def response_aad(server, device, nonce, purpose='response'):
    return b''.join(struct.pack('!I', len(raw)) + raw for raw in
                    (str(v).encode('utf-8') for v in ['winglet.wear.'+purpose, 1, server, device, nonce]))


def _json(value, status=200):
    return web.json_response(value, status=status)


class WearRelay:
    def __init__(self, hub):
        self.hub, self.store = hub, hub.store
        self.send_lock = asyncio.Lock()
        self.store._exec('''CREATE TABLE IF NOT EXISTS winglet_wear_links (
            id TEXT PRIMARY KEY, device_id TEXT NOT NULL, association TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, bot TEXT,
            chats TEXT NOT NULL, role TEXT NOT NULL, sign_hash TEXT NOT NULL,
            can_reply INTEGER NOT NULL, created_at INTEGER NOT NULL, expires INTEGER NOT NULL)''')
        self.store._exec('''CREATE TABLE IF NOT EXISTS winglet_wear_deliveries (
            link_id TEXT NOT NULL, request_id TEXT NOT NULL, chat_id TEXT NOT NULL,
            body_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(link_id, request_id))''')
        self.store._exec('''CREATE TABLE IF NOT EXISTS winglet_wear_nonces (
            link_id TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL,
            PRIMARY KEY(link_id, nonce))''')
        self.store._exec("CREATE UNIQUE INDEX IF NOT EXISTS winglet_wear_association ON winglet_wear_links(device_id, association, COALESCE(bot,''))")
        self.store._exec('CREATE INDEX IF NOT EXISTS winglet_wear_nonce_expiry ON winglet_wear_nonces(expires)')

    def token(self, link_id, device_id, association):
        secret = unb64(self.store.secret('wear_token_key', lambda: b64(secrets.token_bytes(32))), 32)
        value = response_aad(self.hub.server_id(), device_id, association, 'grant') + link_id.encode('ascii')
        return 'wr1_' + b64(hmac.new(secret, value, hashlib.sha256).digest())

    def wrap(self, value, response_key, device_id, nonce, purpose='response'):
        plain = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(plain) > 24000:
            plain = b'{"v":1,"error":"response_too_large"}'
        iv = secrets.token_bytes(12)
        ciphertext = AESGCM(response_key).encrypt(iv, plain, response_aad(self.hub.server_id(), device_id, nonce, purpose))
        return _json({'v': 1, 'nonce': b64(iv), 'ct': b64(ciphertext)})

    def prune(self):
        with self.store.transaction():
            self.store._exec('DELETE FROM winglet_wear_links WHERE expires <= ? OR device_id NOT IN (SELECT id FROM devices)', (int(time.time()),))
            self.store._exec('DELETE FROM winglet_wear_deliveries WHERE link_id NOT IN (SELECT id FROM winglet_wear_links)')
            self.store._exec('DELETE FROM winglet_wear_nonces WHERE expires <= ? OR link_id NOT IN (SELECT id FROM winglet_wear_links)', (int(time.time()),))

    @staticmethod
    def public(row):
        return {key: row[key] for key in ['id', 'association', 'name', 'created_at', 'expires']} | {'can_reply': bool(row['can_reply']), 'chat_ids': json.loads(row['chats'])}

    async def links(self, request):
        device = self.hub._require(request)
        self.prune()
        rows = self.store._all('SELECT * FROM winglet_wear_links WHERE device_id = ? AND bot IS ? ORDER BY created_at DESC',
                               (device['id'], self.hub.bot_name()))
        return _json({'links': [self.public(row) for row in rows]})

    async def create(self, request):
        original = self.hub._require(request)
        signing = self.store.device_sign_key(original['id'])
        body = await self.hub._body(request)
        device = self.hub._device(request)
        if not device or not device.get('verified') or self.store.device_sign_key(device['id']) != signing:
            return _json({'error': 'Verify this pairing before linking a watch.'}, 403)
        try:
            body = self.hub.keys.unseal_json(str(body.get('sealed') or ''), 'wear-link', device['id'])
            if type(body.get('v')) is not int or body['v'] != 1:
                raise ValueError()
            response_key, nonce = unb64(body['response_key'], 32), body['nonce']
            if not isinstance(nonce, str) or not _ID.fullmatch(nonce):
                raise ValueError()
        except (ValueError, TypeError, KeyError, keys.SealError):
            return _json({'error': 'The watch link could not be opened. Update Winglet and retry.'}, 400)
        ids, association, name = body.get('chat_ids'), body.get('association'), body.get('name')
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 12 or any(not isinstance(v, str) or len(v) > 160 for v in ids)
                or len(set(ids)) != len(ids) or not isinstance(association, str) or not _ID.fullmatch(association)
                or not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or any(ord(c) < 32 for c in name)
                or type(body.get('can_reply')) is not bool):
            return _json({'error': 'Choose a watch and up to 12 conversations.'}, 400)
        for chat_id in ids:
            chat = self.hub._visible_chat(device, chat_id)
            if not self.hub._in_bot(chat_id) or chat.get('kind') == 'home':
                return _json({'error': 'Only conversations in this bot can be shared.'}, 403)
        ids = sorted(ids)
        link_id, stamp = secrets.token_hex(16), int(time.time())
        bot = self.hub.bot_name()
        with self.store.transaction():
            self.prune()
            existing = self.store._one('SELECT * FROM winglet_wear_links WHERE device_id = ? AND association = ? AND bot IS ?', (device['id'], association, bot))
            if existing:
                if (json.loads(existing['chats']) != ids or bool(existing['can_reply']) != body['can_reply']
                        or existing['role'] != device['role'] or existing['sign_hash'] != hashlib.sha256(signing.encode()).hexdigest()):
                    return _json({'error': 'This association already has another scope. Unlink it and start again.'}, 409)
                token = self.token(existing['id'], device['id'], association)
                if not hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), existing['token_hash']):
                    return _json({'error': 'This link needs repair. Unlink it and start again.'}, 409)
                return self.wrap({'v': 1, 'id': existing['id'], 'token': token, 'expires': existing['expires'],
                                  'server_id': self.hub.server_id() + (('~'+bot) if bot else '')}, response_key, device['id'], nonce, 'link')
            if len(self.store._all('SELECT id FROM winglet_wear_links WHERE device_id = ?', (device['id'],))) >= 8:
                return _json({'error': 'Unlink an old watch before linking another.'}, 409)
            token = self.token(link_id, device['id'], association)
            self.store._exec('''INSERT INTO winglet_wear_links
                (id,device_id,association,token_hash,name,bot,chats,role,sign_hash,can_reply,created_at,expires)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                (link_id, device['id'], association, hashlib.sha256(token.encode()).hexdigest(), name.strip(), bot,
                 json.dumps(ids), device['role'], hashlib.sha256(signing.encode()).hexdigest(), int(body['can_reply']), stamp, stamp+LIFETIME))
        self.hub.audit('wear.link', device, 'A watch was granted access to selected conversations')
        return self.wrap({'v': 1, 'id': link_id, 'token': token, 'expires': stamp+LIFETIME,
                          'server_id': self.hub.server_id() + (('~'+bot) if bot else '')}, response_key, device['id'], nonce, 'link')

    async def delete(self, request):
        device = self.hub._device(request)
        if not device or not device.get('verified'):
            return _json({'error': 'Verify this pairing before unlinking a watch.'}, 403)
        changed = self.store._exec('DELETE FROM winglet_wear_links WHERE id = ? AND device_id = ? AND bot IS ?',
                                    (request.match_info['link_id'], device['id'], self.hub.bot_name()))
        self.prune()
        if not changed:
            return _json({'error': 'This watch link is no longer present.'}, 404)
        self.hub.audit('wear.unlink', device, 'Watch access was revoked')
        return _json({'ok': True})

    def authorize(self, token, device_id):
        if not isinstance(token, str) or not token.startswith('wr1_') or len(token) > 100:
            raise PermissionError('link_revoked')
        row = self.store._one('SELECT * FROM winglet_wear_links WHERE token_hash = ?', (hashlib.sha256(token.encode()).hexdigest(),))
        if row is None or row['device_id'] != device_id or row['expires'] <= time.time():
            raise PermissionError('link_revoked')
        device = self.store.get_device(row['device_id'])
        signing = self.store.device_sign_key(row['device_id'])
        if (not device or not device.get('verified') or device['role'] != row['role'] or not signing
                or hashlib.sha256(signing.encode()).hexdigest() != row['sign_hash']):
            raise PermissionError('pairing_changed')
        if row['bot'] and not any(bot['name'] == row['bot'] and bot.get('served') is not False for bot in self.hub.bots()):
            raise PermissionError('bot_unavailable')
        return dict(row), device

    def chat(self, row, device, chat_id):
        if chat_id not in json.loads(row['chats']):
            raise PermissionError('conversation_not_shared')
        chat = self.store.get_chat(chat_id)
        if not self.hub.can_see(device, chat) or (chat.get('bot') or None) != row['bot'] or chat.get('kind') == 'home':
            raise PermissionError('conversation_unavailable')
        return chat

    def read(self, row, device, chat_id):
        visible = []
        ids = json.loads(row['chats'])
        needs = {item['chat_id'] for item in self.store._all("SELECT DISTINCT chat_id FROM inbox WHERE status = 'pending' AND chat_id IN (" + ','.join('?' for _ in ids) + ')', tuple(ids))}
        for key in json.loads(row['chats']):
            try: chat = self.chat(row, device, key)
            except PermissionError: continue
            visible.append({'id': key, 'title': _clip(chat.get('title') or 'Conversation', 120),
                            'state': 'needs_you' if key in needs else 'working' if key in self.hub._typing else 'ready',
                            'updated_at': chat.get('updated_at', 0)})
        result = {'v': 1, 'bot': _clip(self.hub.bot().get('title') or 'Winglet', 120),
                  'chats': sorted(visible, key=lambda c: c['updated_at'], reverse=True), 'can_reply': bool(row['can_reply']), 'expires': row['expires']}
        if chat_id:
            self.chat(row, device, chat_id)
            messages = self.store._all('''SELECT * FROM messages WHERE chat_id = ? AND role IN ('user','bot')
                AND COALESCE(json_extract(meta,'$.hidden'),0) = 0
                AND COALESCE(json_extract(meta,'$.activity'),0) = 0
                AND COALESCE(json_extract(meta,'$.picker'),0) = 0
                AND COALESCE(json_extract(meta,'$.inbox_id'),0) = 0
                ORDER BY rowid DESC LIMIT 8''', (chat_id,))
            selected = [self.store._message(m) for m in reversed(messages)]
            result['chat_id'] = chat_id
            result['messages'] = [{'id': m['id'], 'role': m['role'], 'text': _clip(m['text'], 700), 'status': m['status']} for m in selected]
        return result

    async def send(self, token, device_id, data):
        if set(data) != {'chat_id', 'request_id', 'text'} or not isinstance(data['text'], str):
            raise ValueError('invalid_reply')
        text, request_id, chat_id = data['text'].strip(), data['request_id'], data['chat_id']
        if not text or len(text) > 2000 or text.startswith('/') or not isinstance(request_id, str) or not _ID.fullmatch(request_id):
            raise ValueError('invalid_reply')
        if not isinstance(chat_id, str):
            raise ValueError('invalid_reply')
        digest = hashlib.sha256(json.dumps([chat_id, text], ensure_ascii=False).encode()).hexdigest()
        async with self.send_lock:
            row, device = self.authorize(token, device_id)
            self.chat(row, device, chat_id)
            if not row['can_reply']:
                raise PermissionError('reply_not_allowed')
            existing = self.store._one('SELECT body_hash FROM winglet_wear_deliveries WHERE link_id = ? AND request_id = ?', (row['id'], request_id))
            if existing and existing['body_hash'] != digest:
                raise ValueError('request_conflict')
            if not existing:
                count = self.store._one('SELECT COUNT(*) AS n FROM winglet_wear_deliveries WHERE link_id = ?', (row['id'],))['n']
                recent = self.store._one('SELECT COUNT(*) AS n FROM winglet_wear_deliveries WHERE link_id = ? AND created_at > ?', (row['id'], int(time.time())-60))['n']
                if count >= 4096:
                    raise ValueError('link_send_limit')
                if recent >= 10:
                    raise ValueError('rate_limited')
                self.store._exec('INSERT INTO winglet_wear_deliveries VALUES (?,?,?,?,?)', (row['id'], request_id, chat_id, digest, int(time.time())))
            with self.hub._bot_context(row['bot']):
                message = await self.hub.user_message(device, chat_id, text, 'wear-'+row['id']+'-'+request_id)
            if not message:
                raise PermissionError('conversation_unavailable')
            return {'v': 1, 'status': 'accepted', 'request_id': request_id, 'chat_id': chat_id, 'message_id': message['id']}

    async def relay(self, request):
        # Public route, independently authenticated by a narrow grant INSIDE the sealed request.
        raw = bytearray()
        async for chunk in request.content.iter_chunked(2048):
            raw.extend(chunk)
            if len(raw) > 12000:
                return _json({'error': 'Request too large'}, 413)
        try:
            outer = json.loads(raw)
            if not isinstance(outer, dict) or not isinstance(outer.get('sealed'), str):
                raise ValueError()
            device_id = outer['device_id']
            if not isinstance(device_id, str) or len(device_id) > 160:
                raise ValueError()
            data = self.hub.keys.unseal_json(outer['sealed'], 'wear-relay', device_id)
            response_key = unb64(data['response_key'], 32)
            nonce = data['nonce']
            if not isinstance(nonce, str) or not _ID.fullmatch(nonce):
                raise ValueError()
        except (ValueError, TypeError, KeyError, keys.SealError):
            return _json({'error': 'Wear request could not be opened. Repair this link in Winglet.'}, 400)
        result = None
        try:
            if type(data.get('v')) is not int or data['v'] != 1:
                raise ValueError('version_mismatch')
            if type(data.get('issued')) is not int or not -60 <= int(time.time())-data['issued'] <= 90:
                raise ValueError('request_expired')
            row, device = self.authorize(data.get('token'), device_id)
            with self.store.transaction():
                self.prune()
                if self.store._one('SELECT nonce FROM winglet_wear_nonces WHERE link_id = ? AND nonce = ?', (row['id'], nonce)):
                    raise ValueError('request_replayed')
                if len(self.store._all('SELECT nonce FROM winglet_wear_nonces WHERE link_id = ?', (row['id'],))) >= 128:
                    raise ValueError('rate_limited')
                self.store._exec('INSERT INTO winglet_wear_nonces VALUES (?,?,?)', (row['id'], nonce, int(time.time())+150))
            op, content = data.get('op'), data.get('data')
            if not isinstance(content, dict):
                raise ValueError('invalid_request')
            with self.hub._bot_context(row['bot']):
                if op == 'read':
                    if set(content) - {'chat_id'}:
                        raise ValueError('invalid_request')
                    result = self.read(row, device, content.get('chat_id'))
                elif op == 'send':
                    result = await self.send(data['token'], device_id, content)
                elif op == 'unlink':
                    self.store._exec('DELETE FROM winglet_wear_links WHERE id = ?', (row['id'],))
                    self.prune();result = {'v': 1, 'status': 'unlinked'}
                else:
                    raise PermissionError('operation_not_allowed')
        except (PermissionError, ValueError) as exc:
            known = {'link_revoked', 'pairing_changed', 'bot_unavailable', 'conversation_not_shared', 'conversation_unavailable',
                     'invalid_reply', 'reply_not_allowed', 'request_conflict', 'request_expired', 'invalid_request',
                     'operation_not_allowed', 'request_replayed', 'rate_limited', 'version_mismatch', 'link_send_limit'}
            result = {'v': 1, 'error': str(exc) if str(exc) in known else 'temporarily_unavailable'}
        except Exception:
            # No paths, provider errors, URLs, grant values or native callback traces go to the watch.
            result = {'v': 1, 'error': 'temporarily_unavailable'}
        return self.wrap(result, response_key, device_id, nonce)
