"""The agent's pet: its face on every phone, and the gallery owners pick it from.

The hub tests fake Hermes. The store tests at the end go through Hermes's own pet store (agent/pet) with a
spritesheet made here, and run only where Hermes is installed (CI has a job for it).
"""

import asyncio
import importlib.util
import json

import pytest

from plugin.hub import Hub
from plugin.store import Store
from test_trust import pair_phone, post_signed


class Refused(ValueError):
    pass


class Unavailable(RuntimeError):
    pass


def sheet(slug, name):
    return {"slug": slug, "name": name, "revision": f"rev-{slug}", "mime": "image/webp", "frame_w": 192, "frame_h": 208,
            "columns": 8, "rows": 9, "state_rows": ["idle", "running-right", "running-left", "waving", "jumping", "failed",
                                                    "waiting", "running", "review"],
            "frames_per_state": 6, "frames": {"idle": 6}, "loop_ms": 1100, "path": ""}


class FakeHermes:
    """The pet functions plugin/hermes_api.py offers, with Hermes's behaviour faked."""
    HermesRefused = Refused
    HermesUnavailable = Unavailable

    def __init__(self, tmp_path):
        self.dir = tmp_path
        self.installed = {"boba": "Boba"}
        self.active = "boba"
        self.gallery = {"boba": "Boba", "mochi": "Mochi", "pixel": "Pixel Cat"}
        self.downloads = []

    def pets_available(self):
        return True

    def _sheet(self, slug):
        path = self.dir / f"{slug}.webp"
        path.write_bytes(b"RIFF....WEBPVP8 " + slug.encode())
        return {**sheet(slug, self.installed[slug]), "path": str(path)}

    def active_pet(self):
        return self._sheet(self.active) if self.active else None

    def pet_sheet(self, slug):
        return self._sheet(slug) if slug in self.installed else None

    def pets(self):
        return {"enabled": bool(self.active), "active": self.active or "",
                "pets": [{"slug": s, "name": n, "description": "", "generated": False} for s, n in self.installed.items()]}

    def pet_catalog(self, query="", offset=0, limit=30):
        rows = [{"slug": s, "name": n, "kind": "pet", "by": "", "curated": s == "boba", "installed": s in self.installed}
                for s, n in self.gallery.items() if query.lower() in n.lower()]
        return {"total": len(rows), "pets": rows[offset:offset + limit]}

    def pet_thumbnail(self, slug):
        return b"\x89PNG thumb" if slug in self.gallery else None

    def pet_installed(self, slug):
        return slug in self.installed

    def adopt_pet(self, slug):
        if slug not in self.gallery:
            raise Refused(f"Couldn't get that pet: pet '{slug}' is not in the petdex manifest")
        if slug not in self.installed:
            self.downloads.append(slug)
            self.installed[slug] = self.gallery[slug]
        self.active = slug
        return {"slug": slug, "name": self.installed[slug]}

    def remove_pet(self, slug):
        if self.installed.pop(slug, None) is None:
            return False
        if self.active == slug:
            self.active = None
        return True

    def show_pet(self, on):
        if not on:
            self.active = None
            return None
        if not self.installed:
            raise Refused("Adopt a pet first.")
        self.active = self.active or next(iter(self.installed))
        return {"slug": self.active, "name": self.installed[self.active]}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "data.db")
    yield s
    s.close()


@pytest.fixture
def hub(store, tmp_path):
    h = Hub(store, web_root=tmp_path / "web", bot_info=lambda: {"name": "hermes", "title": "Hermes"})
    h.hermes = FakeHermes(tmp_path)
    h.events = []

    async def broadcast(event):
        h.events.append(event)
    h.broadcast = broadcast
    return h


@pytest.fixture
async def client(aiohttp_client, hub):
    return await aiohttp_client(hub.build_app())


async def signed(client, phone, method, path, data=None):
    body = json.dumps(data).encode() if data is not None else b""
    return await client.request(method, path, data=body, headers=phone.signed(method, path, body))


async def finished(client, phone, job_id):
    for _ in range(100):
        job = (await (await client.get(f"/api/jobs/{job_id}", headers=phone.auth)).json())["job"]
        if job["state"] != "running":
            return job
        await asyncio.sleep(0.01)
    raise AssertionError("the job never finished")


async def test_every_phone_sees_the_pet_through_signed_links(client, hub):
    member = await pair_phone(client, hub, "Alex", role="member")
    data = await (await client.get("/api/pet", headers=member.auth)).json()
    pet = data["pet"]
    assert pet["slug"] == "boba" and pet["frame_w"] == 192 and "path" not in pet
    assert hub.features()["pets"] is True
    # The sheet and thumbnail load without the token: their links carry a signature instead.
    sheet_resp = await client.get(pet["sheet_url"])
    assert sheet_resp.status == 200 and sheet_resp.headers["Content-Type"] == "image/webp"
    assert "immutable" in sheet_resp.headers["Cache-Control"]
    assert (await client.get(pet["thumb_url"])).status == 200
    assert (await client.get("/api/pets/boba/sheet?sig=nope")).status == 404
    assert (await client.get("/api/pets/boba/thumb")).status == 404
    # A link for an older version of the sheet still loads, but isn't cached forever.
    stale = await client.get(pet["sheet_url"].replace("rev=rev-boba", "rev=old"))
    assert stale.status == 200 and "no-cache" in stale.headers["Cache-Control"]
    # Members can't manage pets.
    assert (await client.get("/api/pets", headers=member.auth)).status == 403
    assert (await signed(client, member, "PUT", "/api/pets/display", {"enabled": False})).status == 403


async def test_no_pet_when_hermes_has_none_or_cant(client, hub):
    owner = await pair_phone(client, hub)
    hub.hermes.active = None
    assert (await (await client.get("/api/pet", headers=owner.auth)).json()) == {"pet": None}
    hub.hermes.pets_available = lambda: False
    assert hub.features()["pets"] is False
    assert (await (await client.get("/api/pet", headers=owner.auth)).json()) == {"pet": None}


async def test_gallery_marks_whats_installed_with_thumbnails(client, hub):
    owner = await pair_phone(client, hub)
    mine = await (await client.get("/api/pets", headers=owner.auth)).json()
    assert mine["active"] == "boba" and mine["pets"][0]["thumb_url"].startswith("/api/pets/boba/thumb?sig=")
    found = await (await client.get("/api/pets/catalog?q=pixel", headers=owner.auth)).json()
    assert found["total"] == 1 and found["pets"][0]["slug"] == "pixel" and not found["pets"][0]["installed"]
    assert (await client.get(found["pets"][0]["thumb_url"])).status == 200
    assert (await client.get("/api/pets/catalog?offset=x", headers=owner.auth)).status == 400


async def test_a_slow_gallery_answers_loading_and_was_started_early(client, hub, monkeypatch):
    import time
    from plugin import hub as hub_module
    owner = await pair_phone(client, hub)
    started = []
    hub.hermes.prefetch_pet_catalog = lambda: started.append(True)
    await client.get("/api/pets", headers=owner.auth)
    assert started == [True]  # opening the Pet screen starts the petdex fetch
    fast = hub.hermes.pet_catalog

    def slow(*args):
        time.sleep(0.3)
        return fast(*args)
    hub.hermes.pet_catalog = slow
    monkeypatch.setattr(hub_module, "PET_CATALOG_WAIT", 0.05)
    data = await (await client.get("/api/pets/catalog", headers=owner.auth)).json()
    assert data == {"loading": True, "total": 0, "pets": []}
    monkeypatch.setattr(hub_module, "PET_CATALOG_WAIT", 5)
    assert (await (await client.get("/api/pets/catalog", headers=owner.auth)).json())["total"] == 3


async def test_adopting_a_new_pet_downloads_it_as_a_job(client, hub):
    owner = await pair_phone(client, hub)
    path = "/api/pets/mochi/adopt"
    assert (await client.post(path, json={}, headers=owner.auth)).status == 403  # unsigned
    resp = await post_signed(client, owner, path, {"idempotency_key": "k1"})
    assert resp.status == 202
    job = await finished(client, owner, (await resp.json())["job"]["id"])
    assert job["kind"] == "pet_install" and job["state"] == "succeeded" and job["detail"]["pet"] == "mochi"
    assert hub.hermes.active == "mochi" and hub.hermes.downloads == ["mochi"]
    assert {"type": "pet.update", "bot": None} in hub.events
    # One that's already installed switches at once.
    resp = await post_signed(client, owner, "/api/pets/boba/adopt", {"idempotency_key": "k2"})
    assert resp.status == 200 and (await resp.json())["pet"]["slug"] == "boba" and hub.hermes.active == "boba"
    # Retries answer as the first request did, and never undo a choice made since.
    again = await post_signed(client, owner, path, {"idempotency_key": "k1"})
    assert again.status == 202 and (await again.json())["job"]["id"] == job["id"]
    assert hub.hermes.active == "boba" and hub.hermes.downloads == ["mochi"]
    assert (await post_signed(client, owner, path, {"idempotency_key": "k3"})).status == 200  # Mochi, on purpose
    again = await post_signed(client, owner, "/api/pets/boba/adopt", {"idempotency_key": "k2"})
    assert again.status == 200 and (await again.json())["pet"]["slug"] == "boba" and hub.hermes.active == "mochi"
    assert [a["summary"] for a in hub.store.list_audit(limit=5) if a["action"] == "pet"] == [
        "chose Mochi", "chose Boba", "adopted mochi from petdex"]


async def test_a_pet_petdex_doesnt_have_fails_the_job(client, hub):
    owner = await pair_phone(client, hub)
    resp = await post_signed(client, owner, "/api/pets/ghost/adopt", {})
    job = await finished(client, owner, (await resp.json())["job"]["id"])
    assert job["state"] == "failed" and "not in the petdex manifest" in job["detail"]["message"]
    assert (await post_signed(client, owner, "/api/pets/..%2Fetc/adopt", {})).status == 404


async def test_turning_the_pet_off_and_removing_it(client, hub):
    owner = await pair_phone(client, hub)
    resp = await signed(client, owner, "PUT", "/api/pets/display", {"enabled": False})
    assert resp.status == 200 and hub.hermes.active is None
    resp = await signed(client, owner, "PUT", "/api/pets/display", {"enabled": True})
    assert (await resp.json())["pet"]["slug"] == "boba"
    assert (await signed(client, owner, "DELETE", "/api/pets/boba")).status == 200
    assert hub.hermes.active is None and not hub.hermes.installed
    assert (await signed(client, owner, "DELETE", "/api/pets/boba")).status == 404
    resp = await signed(client, owner, "PUT", "/api/pets/display", {"enabled": True})
    assert resp.status == 400 and (await resp.json())["error"] == "Adopt a pet first."
    assert hub.events.count({"type": "pet.update", "bot": None}) == 3


# -- through Hermes's own pet store ----------------------------------------------------------------

needs_hermes = pytest.mark.skipif(importlib.util.find_spec("agent") is None
                                  or importlib.util.find_spec("hermes_cli") is None,
                                  reason="needs Hermes Agent installed")


def make_sheet(path, rows=9, filled=6):
    """A Codex-layout spritesheet: 8 columns, `filled` of them drawn in every row."""
    from PIL import Image
    image = Image.new("RGBA", (192 * 8, 208 * rows), (0, 0, 0, 0))
    for row in range(rows):
        for col in range(filled):
            image.paste((200, 80, 40, 255), (col * 192 + 40, row * 208 + 40, col * 192 + 150, row * 208 + 170))
    image.save(path, format="WEBP", lossless=True)


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "config.yaml").write_text("display:\n  pet:\n    enabled: false\n")
    from plugin import hermes_api
    return hermes_api


@needs_hermes
def test_hermes_pets_install_show_and_remove(hermes_home, tmp_path, monkeypatch):
    h = hermes_home
    from agent.pet import manifest, store
    assert h.pets_available() and h.pets() == {"enabled": False, "active": "", "pets": []}
    assert h.active_pet() is None

    entry = manifest.ManifestEntry(slug="boba", display_name="Boba", kind="pet", submitted_by="petdex",
                                   spritesheet_url="https://assets.petdex.dev/curated/boba/spritesheet.webp",
                                   pet_json_url="", zip_url="")
    monkeypatch.setattr(manifest, "fetch_manifest", lambda **kw: [entry])

    def download(url, dest, *, timeout):
        make_sheet(dest)
    monkeypatch.setattr(store, "_download", download)

    found = h.pet_catalog("bob")
    assert found == {"total": 1, "pets": [{"slug": "boba", "name": "Boba", "kind": "pet", "by": "petdex",
                                           "curated": True, "installed": False}]}
    assert not h.pet_installed("boba")
    assert h.adopt_pet("boba") == {"slug": "boba", "name": "Boba"}
    assert h.pet_installed("boba") and h.pets()["active"] == "boba"

    pet = h.active_pet()
    assert pet["columns"] == 8 and pet["rows"] == 9 and pet["state_rows"][3] == "waving"
    assert pet["frames"]["idle"] == 6 and pet["mime"] == "image/webp" and pet["path"].endswith("spritesheet.webp")
    assert h.pet_thumbnail("boba").startswith(b"\x89PNG")

    assert h.show_pet(False) is None and h.active_pet() is None
    assert h.show_pet(True) == {"slug": "boba", "name": "Boba"}
    assert h.remove_pet("boba") and h.pets() == {"enabled": False, "active": "", "pets": []}
    with pytest.raises(h.HermesRefused, match="Adopt a pet first"):
        h.show_pet(True)


@needs_hermes
def test_hermes_legacy_sheets_and_an_unreachable_gallery(hermes_home, tmp_path, monkeypatch):
    h = hermes_home
    from agent.pet import manifest, store
    make_sheet(tmp_path / "legacy.webp", rows=8, filled=4)
    store.register_local_pet(str(tmp_path / "legacy.webp"), slug="old-pal", display_name="Old Pal")
    pet = h.pet_sheet("old-pal")
    assert pet["rows"] == 8 and pet["state_rows"][:3] == ["idle", "wave", "run"] and pet["frames"]["idle"] == 4
    assert h.pet_sheet("missing") is None

    def offline(**kw):
        raise manifest.ManifestError("no network")
    monkeypatch.setattr(manifest, "fetch_manifest", offline)
    with pytest.raises(h.HermesRefused, match="petdex.dev"):
        h.pet_catalog()
    assert h.pet_thumbnail("someone-else") is None
    assert h.pet_thumbnail("old-pal").startswith(b"\x89PNG")  # installed: no network needed
