"""python test_app.py — checks burst parsing and the cluster/buried models on a throwaway DB."""
import os
import tempfile

os.environ["BLASTMAP_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
import app  # noqa: E402

c = app.app.test_client()

surface = c.get("/api/zones?tnt_kg=1000").get_json()["zones"]
buried = c.get("/api/zones?tnt_kg=1000&burst=buried").get_json()["zones"]
assert buried[0]["radius_m"] < surface[0]["radius_m"]

z = c.get("/api/zones?tnt_kg=81&burst=cluster&count=202&spread_m=140").get_json()["zones"]
assert z[-1]["key"] == "spread" and z[-1]["radius_m"] == 140
assert all(x["each"] for x in z[:-1]) and z[0]["radius_m"] < 5  # ~0.4 kg per submunition

for bad in ("burst=nope", "burst=cluster", "burst=cluster&count=0&spread_m=10",
            "burst=cluster&count=5000&spread_m=10", "burst=cluster&count=10&spread_m=nan"):
    assert c.get(f"/api/zones?tnt_kg=10&{bad}").status_code == 400, bad

r = c.post("/api/scenarios", json={"lat": 35.7, "lng": 51.4, "tnt_kg": 81,
                                   "burst": "cluster", "count": 202, "spread_m": 140})
assert r.status_code == 201
s = c.get("/api/scenarios").get_json()[0]
assert (s["burst"], s["count"], s["spread_m"]) == ("cluster", 202, 140)

cats = {p["category"] for p in c.get("/api/presets").get_json()}
assert {"سنگرشکن", "خوشه‌ای"} <= cats
print("ok")
