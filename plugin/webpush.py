"""Minimal Web Push sender: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).

Uses only ``cryptography`` (a Hermes core dependency) and ``httpx``, so no extra install is needed.
Payloads are end-to-end encrypted to the browser; the push service (Apple, Google, Mozilla) only
sees ciphertext.
"""

from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import json
import os
import struct
import time
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DEFAULT_TTL_SECONDS = 24 * 60 * 60
_RECORD_SIZE = 4096


def allowed_endpoint(endpoint: str) -> bool:
    """Allow browser push services, not arbitrary HTTPS destinations."""
    try:
        parts = urlsplit(endpoint)
        host = parts.hostname or ""
        return (parts.scheme == "https" and bool(host) and not parts.username and not parts.password
                and "@" not in parts.netloc and parts.port in (None, 443) and not parts.fragment
                and not any(c.isspace() or ord(c) < 32 or ord(c) > 126 or c == "\\" for c in endpoint)
                and (host in ("fcm.googleapis.com", "web.push.apple.com")
                     or host.endswith(".push.services.mozilla.com")
                     or host.endswith(".notify.windows.com")))
    except (ValueError, TypeError):
        return False


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    text = (text or "").strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


# -- VAPID ------------------------------------------------------------------------


def generate_vapid_private_key() -> str:
    """A new P-256 private key as PEM text (store it; the public half is derived from it)."""
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode("ascii")


@functools.lru_cache(maxsize=4)  # one server key, parsed once rather than on every push
def _load_private(pem: str) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError("VAPID key must be an EC private key")
    return key


@functools.lru_cache(maxsize=4)
def vapid_public_key(pem: str) -> str:
    """The ``applicationServerKey`` browsers need: base64url of the uncompressed public point."""
    return b64url_encode(_public_bytes(_load_private(pem).public_key()))


def vapid_authorization(endpoint: str, pem: str, subject: str, *, now: Optional[float] = None) -> str:
    """``Authorization`` header value for a push to ``endpoint``."""
    parts = urlsplit(endpoint)
    audience = f"{parts.scheme}://{parts.netloc}"
    issued = int(now if now is not None else time.time())
    header = b64url_encode(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64url_encode(json.dumps({"aud": audience, "exp": issued + 12 * 3600, "sub": subject},
                                      separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    key = _load_private(pem)
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    signature = b64url_encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={header}.{claims}.{signature}, k={vapid_public_key(pem)}"


# -- aes128gcm payload encryption ----------------------------------------------------


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


def encrypt(payload: bytes, p256dh: str, auth: str, *, salt: Optional[bytes] = None,
            server_key: Optional[ec.EllipticCurvePrivateKey] = None) -> bytes:
    """Encrypt ``payload`` for a subscription's ``keys.p256dh`` / ``keys.auth`` (single record)."""
    ua_public = b64url_decode(p256dh)
    auth_secret = b64url_decode(auth)
    if len(ua_public) != 65 or len(auth_secret) < 16:
        raise ValueError("invalid subscription keys")
    if len(payload) > _RECORD_SIZE - 17 - 86:
        raise ValueError("payload too large for a single Web Push record")
    salt = salt or os.urandom(16)
    server_key = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _public_bytes(server_key.public_key())
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    shared = server_key.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack("!IB", _RECORD_SIZE, len(as_public)) + as_public
    return header + ciphertext


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth: str) -> bytes:
    """Inverse of :func:`encrypt` (what the browser does). Used by tests."""
    salt, (_rs, idlen) = body[:16], struct.unpack("!IB", body[16:21])
    as_public = body[21:21 + idlen]
    ciphertext = body[21 + idlen:]
    ua_public = _public_bytes(ua_private.public_key())
    as_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    shared = ua_private.exchange(ec.ECDH(), as_key)
    ikm = _hkdf(b64url_decode(auth), shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
    return plain.rstrip(b"\x00")[:-1]  # strip padding and the 0x02 delimiter


def build_request(subscription: Dict[str, Any], message: Dict[str, Any], pem: str, subject: str, *,
                  ttl: int = DEFAULT_TTL_SECONDS, urgency: str = "normal",
                  topic: Optional[str] = None) -> Tuple[str, Dict[str, str], bytes]:
    """``(url, headers, body)`` for one push. ``topic`` lets a newer push replace an older one."""
    endpoint = subscription["endpoint"]
    keys = subscription.get("keys") or {}
    body = encrypt(json.dumps(message, separators=(",", ":")).encode("utf-8"), keys["p256dh"], keys["auth"])
    headers = {
        "Authorization": vapid_authorization(endpoint, pem, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(int(ttl)),
        "Urgency": urgency,
    }
    if topic:
        # RFC 8030 topics: <= 32 chars from the base64url alphabet.
        headers["Topic"] = "".join(ch for ch in topic if ch.isalnum() or ch in "-_")[:32]
    return endpoint, headers, body


async def send(client, subscription: Dict[str, Any], message: Dict[str, Any], pem: str, subject: str,
               **kwargs) -> int:
    """POST one push with an ``httpx.AsyncClient``; returns the HTTP status (404/410 = gone)."""
    url, headers, body = build_request(subscription, message, pem, subject, **kwargs)
    resp = await client.post(url, headers=headers, content=body, timeout=15.0, follow_redirects=False)
    return resp.status_code
