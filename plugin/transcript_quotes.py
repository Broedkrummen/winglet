"""Exact, bounded quote anchors. Offsets use JavaScript/Android UTF-16 units."""
import hashlib
import re


MAX_QUOTE_UNITS = 4000
KEYS = {"v", "message_id", "chat_id", "start", "end", "text", "source_hash"}


def validate_anchor(source, anchor):
    if not isinstance(anchor, dict) or set(anchor) != KEYS or type(anchor.get("v")) is not int or anchor["v"] != 1:
        raise ValueError("This quote format is not supported. Select the text again.")
    if (source.get("id") != anchor["message_id"] or source.get("chat_id") != anchor["chat_id"]
            or source.get("role") != "bot" or source.get("status") != "final"
            or any(source.get("meta", {}).get(k) for k in ("activity", "hidden", "picker", "inbox_id"))):
        raise ValueError("Choose text from a completed assistant reply.")
    text = source.get("text") or ""
    digest = anchor.get("source_hash")
    if not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
        raise ValueError("Select the quote again.")
    try:
        raw = text.encode("utf-16-le")
        current = hashlib.sha256(text.encode("utf-8")).hexdigest()
    except UnicodeError:
        raise ValueError("This reply contains invalid text. Select another reply.") from None
    if digest != current:
        raise ValueError("The reply changed after this quote was selected. Select it again.")
    start, end = anchor.get("start"), anchor.get("end")
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(raw) // 2 or end - start > MAX_QUOTE_UNITS:
        raise ValueError("Select between 1 and 4000 characters.")
    try:
        selected = raw[start*2:end*2].decode("utf-16-le")
    except UnicodeError:
        raise ValueError("Select complete characters, including emoji.") from None
    if not selected.strip() or selected != anchor.get("text"):
        raise ValueError("The quoted text does not match the reply. Select it again.")
    return {key: anchor[key] for key in KEYS}

