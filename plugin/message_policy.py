"""Keep internal Hermes activity out of finished-answer notifications."""

import re

_LINE = re.compile(r"^[\U0001F000-\U0001FAFF\u2600-\u27ff]\ufe0f?\s+([a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*)(?:\s*:.*|\s*\.{3}|\s*…)?(?:\s+\(×\d+\))?$", re.IGNORECASE)
_TOOLS = {"terminal", "process", "browser", "todo", "memory", "patch", "delegate", "clarify", "cronjob", "vision", "search", "think"}
_FRIENDLY = re.compile(r"^[\U0001F000-\U0001FAFF\u2600-\u27ff]\ufe0f?\s+(?:Searching the web|Searching past sessions|Searching files|Reading skill|Listing skills|Updating skill|Updating memory|Updating tasks|Looking at the image|Generating image|Generating video|Generating speech|Running code|Running|Reading|Browsing|Clicking|Typing|Writing|Editing|Delegating|Scheduling|Asking)(?:\s.*)?$")


def is_tool_progress(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or len(text) > 1200:
        return False
    for line in lines:
        match = _LINE.fullmatch(line)
        if not (match and ("_" in match[1] or match[1].lower() in _TOOLS)) and not _FRIENDLY.fullmatch(line):
            return False
    return True
