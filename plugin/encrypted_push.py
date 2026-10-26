"""Versioned device-bound push envelopes. The relay receives only encrypted content.

AESGCM is cryptography's maintained implementation, not a new cipher construction.
The 256-bit shared delivery key is provisioned using Winglet's pinned sealed-secret
channel. Both trusted endpoints know the key; possessing only a relay topic is
insufficient to forge an accepted notification.
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import struct
import time
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VERSION = 1
MAX_AGE = 24 * 3600
MAX_ENVELOPE = 3600
KIND = 'encrypted-v1'
_ID = re.compile(r'^[a-f0-9]{32}$')


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')


def unb64(value, size: int | None = None) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('Invalid encrypted push encoding')
    raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    if (size is not None and len(raw) != size) or b64(raw) != value:
        raise ValueError('Invalid encrypted push encoding')
    return raw


def aad(server: str, device: str, kid: str) -> bytes:
    # Length-prefixed UTF8 fields avoid JSON-normalization ambiguity across runtimes.
    fields = ['winglet.push', str(VERSION), server, device, kid, 'notification']
    return b''.join(struct.pack('!I', len(raw)) + raw for raw in (part.encode('utf-8') for part in fields))


def _clip(value, limit):
    return str(value or '').encode('utf-8')[:limit].decode('utf-8', errors='ignore')


def seal(key: str, kid: str, server: str, device: str, note: dict, *, now=None, event_id=None) -> dict:
    if not _ID.fullmatch(kid):
        raise ValueError('Invalid push key identifier')
    stamp = int(time.time() if now is None else now)
    selected = {name: _clip(note.get(name), limit) for name, limit in
                [('title', 180), ('body', 600), ('url', 500), ('tag', 120), ('kind', 24), ('chat_id', 160)]}
    plain = json.dumps({'id': event_id or secrets.token_hex(16), 'issued': stamp, 'expires': stamp + MAX_AGE,
                        'note': selected}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(plain) > 2200:
        raise ValueError('Encrypted notification is too large')
    nonce = os.urandom(12)
    envelope = {'v': VERSION, 'kid': kid, 'nonce': b64(nonce),
                'ct': b64(AESGCM(unb64(key, 32)).encrypt(nonce, plain, aad(server, device, kid)))}
    if len(json.dumps(envelope).encode()) > MAX_ENVELOPE:
        raise ValueError('Encrypted notification is too large')
    return envelope


def validate_enrollment(data: dict, relay_origin: str) -> dict:
    if not isinstance(data, dict) or type(data.get('v')) is not int or data.get('v') != VERSION or not isinstance(data.get('kid'), str) or not _ID.fullmatch(data['kid']):
        raise ValueError('Update Winglet to use encrypted push version 1')
    unb64(data.get('key'), 32)
    previous = data.get('previous_kid')
    if 'previous_kid' not in data or (previous is not None and (not isinstance(previous, str) or not _ID.fullmatch(previous))):
        raise ValueError('Refresh encrypted push status before registering')
    revision = data.get('revision')
    if type(revision) is not int or not 1 <= revision <= 2**31-1:
        raise ValueError('Invalid distributor endpoint revision')
    sub = data.get('subscription')
    if not isinstance(sub, dict):
        raise ValueError('The push distributor has not provided an endpoint')
    endpoint = sub.get('endpoint')
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        raise ValueError('Invalid push endpoint')
    parts, configured = urlsplit(endpoint), urlsplit(relay_origin)
    # Only the relay explicitly configured by the gateway operator. A member cannot
    # turn enrollment into an arbitrary internal-network POST destination.
    try:
        same_origin = (parts.hostname, 443 if parts.port is None else parts.port) == (configured.hostname, 443 if configured.port is None else configured.port)
    except ValueError:
        same_origin = False
    if (parts.scheme != 'https' or configured.scheme != 'https' or not same_origin or not parts.hostname
            or parts.username or parts.password or parts.fragment or not parts.path or parts.path == '/'
            or any(c.isspace() or ord(c)<32 for c in endpoint)):
        raise ValueError('Use an ntfy distributor on this server\'s configured HTTPS relay')
    keys = sub.get('keys')
    if not isinstance(keys, dict):
        raise ValueError('The distributor must support encrypted Web Push')
    point = unb64(keys.get('p256dh'), 65)
    if point[0] != 4:
        raise ValueError('Invalid distributor encryption key')
    from cryptography.hazmat.primitives.asymmetric import ec
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    unb64(keys.get('auth'), 16)
    return {'v': VERSION, 'kid': data['kid'], 'key': data['key'], 'revision': revision,
            'subscription': {'endpoint': endpoint, 'keys': dict(keys)}}


def policy_key(device: str) -> str:
    return 'push.encrypted.' + device


def enrolled(store, device: str):
    return next((sub for sub in store.list_push_subs(KIND) if sub['device_id'] == device), None)


def enroll(store, device: str, data: dict, relay_origin: str):
    validated = validate_enrollment(data, relay_origin)
    endpoint = validated['subscription']['endpoint']
    with store.transaction():
        current = store.get_device(device)
        if not current or not current.get('verified'):
            raise ValueError('The device is no longer verified')
        # An endpoint already belonging to another device is never stolen by add_push_sub.
        if any(sub['endpoint'] == endpoint and sub['device_id'] != device for sub in store.list_push_subs(KIND)):
            raise ValueError('This push endpoint belongs to another pairing; register a fresh instance')
        existing = enrolled(store, device)
        if (existing['data']['kid'] if existing else None) != data['previous_kid']:
            raise ValueError('Encrypted push changed; refresh before retrying')
        if existing and existing['data']['kid'] == validated['kid'] and existing['data']['key'] != validated['key']:
            raise ValueError('Rotate the key identifier when changing its key')
        if existing and existing['data']['kid'] == validated['kid']:
            previous = existing['data']
            if validated['revision'] < previous['revision'] or (validated['revision'] == previous['revision'] and validated['subscription'] != previous['subscription']):
                raise ValueError('A newer distributor endpoint was already registered')
        # In one transaction retire all delivery routes, but retain address recovery.
        store._exec("DELETE FROM push_subs WHERE device_id = ? AND kind IN ('ntfy', 'webpush', ?)", (device, KIND))
        result = store.add_push_sub(device, KIND, endpoint, validated)
        store.set_kv(policy_key(device), '1')
    return result


def revoke(store, device: str):
    with store.transaction():
        store._exec('DELETE FROM push_subs WHERE device_id = ? AND kind = ?', (device, KIND))
        # Sticky privacy policy survives turning notifications off and old-client attempts.
        store.set_kv(policy_key(device), '1')


def status(store, device: str, delivered: dict):
    sub = enrolled(store, device)
    return {'v': VERSION, 'enrolled': sub is not None, 'encrypted_required': store.get_kv(policy_key(device)) == '1',
            'kid': sub['data']['kid'] if sub else None,
            'relay': urlsplit(sub['endpoint']).hostname if sub else None,
            'acceptance': delivered.get(sub['id']) if sub else None,
            'delivery': 'Check receipt, decryption and display on this device; relay acceptance is not delivery.'}
