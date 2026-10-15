"""
BlastMap — ابزار آموزشی نمایش شعاع اثر انفجار روی OpenStreetMap
Flask + SQLite. محاسبات تقریبی و صرفاً آموزشی است.
"""
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BLASTMAP_DB", BASE_DIR / "blastmap.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

# فاصله‌ی مقیاس‌شده Z (m / kg^(1/3)) برای هر ناحیه — تقریبی از منحنی‌های Kingery-Bulmash (انفجار سطحی)
ZONES = [
    {"key": "total", "label": "تخریب کامل (~۲۰ psi)", "z": 3.0, "color": "#b91c1c"},
    {"key": "heavy", "label": "آسیب سنگین سازه (~۵ psi)", "z": 7.0, "color": "#ea580c"},
    {"key": "moderate", "label": "آسیب متوسط (~۳ psi)", "z": 9.5, "color": "#f59e0b"},
    {"key": "light", "label": "آسیب سبک / شکست شیشه (~۱ psi)", "z": 18.0, "color": "#facc15"},
]
AIRBURST_FACTOR = 1.25  # افزایش تقریبی شعاع در انفجار هوایی
# ponytail: ثابت؛ فرض ~۱۰٪ انرژی به هوا برای انفجار زیرسطحی سنگرشکن. در واقع به عمق و جنس خاک بستگی دارد
BURIED_FACTOR = 0.45
BURSTS = {"surface", "air", "buried", "cluster"}
MAX_SUBMUNITIONS = 2000
FA_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")

DEFAULT_PRESETS = [
    ("انفجار کوچک (۱۰ کیلوگرم TNT)", 10, "متعارف"),
    ("بمب سبک (۱۰۰ کیلوگرم TNT)", 100, "متعارف"),
    ("بمب متوسط (۲۵۰ کیلوگرم TNT)", 250, "متعارف"),
    ("بمب سنگین (۱ تن TNT)", 1000, "متعارف"),
    ("بمب بسیار سنگین (۵ تن TNT)", 5000, "متعارف"),
    ("هسته‌ای کوچک (۱ کیلوتن)", 1_000_000, "هسته‌ای"),
    ("هیروشیما — Little Boy (۱۵ کیلوتن)", 15_000_000, "هسته‌ای", "air"),
    ("ناکازاکی — Fat Man (۲۱ کیلوتن)", 21_000_000, "هسته‌ای", "air"),
    ("کلاهک راهبردی (۳۰۰ کیلوتن، مثل W87)", 300_000_000, "هسته‌ای"),
    ("بمب تزار — Tsar Bomba (۵۰ مگاتن)", 50_000_000_000, "هسته‌ای", "air"),
    # (نام، TNT کل، دسته، نوع انفجار، تعداد زیرمهمات، شعاع پراکندگی m) — ارقام عمومی و تقریبی
    ("BLU-109 (~۲۷۰ کیلوگرم TNT، نفوذ ~۲ متر بتن)", 270, "سنگرشکن", "buried"),
    ("GBU-28 (~۳۲۰ کیلوگرم TNT، نفوذ ~۶ متر بتن)", 320, "سنگرشکن", "buried"),
    ("GBU-57 MOP (~۲٫۵ تن TNT، نفوذ ده‌ها متر)", 2500, "سنگرشکن", "buried"),
    ("راکت M26 (۶۴۴ زیرمهمات، ~۲۶ کیلوگرم TNT)", 26, "خوشه‌ای", "cluster", 644, 150),
    ("CBU-87 (۲۰۲ زیرمهمات، ~۸۰ کیلوگرم TNT)", 81, "خوشه‌ای", "cluster", 202, 140),
]


# ---------- DB ----------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            tnt_kg REAL NOT NULL CHECK (tnt_kg > 0),
            category TEXT NOT NULL DEFAULT 'سفارشی'
        );
        CREATE TABLE IF NOT EXISTS scenarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            tnt_kg REAL NOT NULL,
            burst TEXT NOT NULL DEFAULT 'surface',
            label TEXT,
            created_at TEXT NOT NULL
        );
        """
    )
    # ستون‌های اضافه‌شده بعد از نسخه‌ی اول؛ ALTER تا دیتابیس‌های موجود هم کار کنند
    for table, cols in {
        "presets": ["burst TEXT", "count INTEGER", "spread_m REAL"],
        "scenarios": ["count INTEGER", "spread_m REAL"],
    }.items():
        have = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
        for col in cols:
            if col.split()[0] not in have:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {col}")
    # پیش‌فرض‌های جدید به دیتابیس‌های قدیمی هم اضافه می‌شوند (۱۵ کیلوتن قبلی همان هیروشیماست)
    db.execute("UPDATE presets SET name = ?, burst = 'air' WHERE name = ?",
               ("هیروشیما — Little Boy (۱۵ کیلوتن)", "هسته‌ای (۱۵ کیلوتن)"))
    db.executemany(
        "INSERT INTO presets (name, tnt_kg, category, burst, count, spread_m) "
        "SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM presets WHERE name = ?)",
        [(*p, *(None,) * (6 - len(p)), p[0]) for p in DEFAULT_PRESETS],
    )
    db.commit()
    db.close()


# ---------- محاسبه ----------
def parse_burst(src):
    """(burst, count, spread_m) از query یا بدنه‌ی JSON؛ None اگر نامعتبر باشد."""
    burst = src.get("burst") or "surface"
    if burst != "cluster":
        return (burst, None, None) if burst in BURSTS else None
    try:
        count, spread = int(src["count"]), float(src["spread_m"])
    except (KeyError, TypeError, ValueError):
        return None
    return (burst, count, spread) if 1 <= count <= MAX_SUBMUNITIONS and 0 < spread <= 20_000 else None


def compute_zones(tnt_kg: float, burst: str = "surface", count=None, spread_m=None):
    if burst == "cluster":
        # هر زیرمهمات یک انفجار سطحی کوچک است؛ each یعنی در هر نقطه‌ی برخورد رسم شود
        each = [
            {**z, "label": z["label"].replace(" (", " هر زیرمهمات (", 1), "each": True}
            for z in compute_zones(tnt_kg / count)
        ]
        spread = {"key": "spread", "label": f"پهنه‌ی پراکندگی ({str(count).translate(FA_DIGITS)} زیرمهمات)",
                  "radius_m": spread_m, "color": "#64748b"}
        return each + [spread]
    factor = {"air": AIRBURST_FACTOR, "buried": BURIED_FACTOR}.get(burst, 1.0)
    cube_root = tnt_kg ** (1 / 3)
    return [
        {**z, "radius_m": round(z["z"] * cube_root * factor, 1)} for z in ZONES
    ]


# ---------- Routes ----------
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/zones")
def api_zones():
    try:
        tnt = float(request.args.get("tnt_kg", 0))
    except ValueError:
        return jsonify(error="tnt_kg نامعتبر است"), 400
    if tnt <= 0:
        return jsonify(error="tnt_kg باید بزرگتر از صفر باشد"), 400
    shape = parse_burst(request.args)
    if not shape:
        return jsonify(error="نوع انفجار یا پارامترهای خوشه‌ای نامعتبر است"), 400
    return jsonify(tnt_kg=tnt, burst=shape[0], zones=compute_zones(tnt, *shape))


@app.get("/api/presets")
def list_presets():
    rows = get_db().execute("SELECT * FROM presets ORDER BY tnt_kg").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/presets")
def add_preset():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    try:
        tnt = float(data.get("tnt_kg", 0))
    except (TypeError, ValueError):
        tnt = 0
    if not name or tnt <= 0:
        return jsonify(error="نام و معادل TNT (بزرگتر از صفر) لازم است"), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO presets (name, tnt_kg, category) VALUES (?, ?, ?)",
        (name, tnt, data.get("category") or "سفارشی"),
    )
    db.commit()
    return jsonify(id=cur.lastrowid, name=name, tnt_kg=tnt), 201


@app.delete("/api/presets/<int:pid>")
def delete_preset(pid):
    db = get_db()
    db.execute("DELETE FROM presets WHERE id = ?", (pid,))
    db.commit()
    return "", 204


@app.get("/api/scenarios")
def list_scenarios():
    rows = get_db().execute("SELECT * FROM scenarios ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/scenarios")
def add_scenario():
    data = request.get_json(silent=True) or {}
    try:
        lat, lng = float(data["lat"]), float(data["lng"])
        tnt = float(data["tnt_kg"])
    except (KeyError, TypeError, ValueError):
        return jsonify(error="lat، lng و tnt_kg لازم است"), 400
    shape = parse_burst(data)
    if tnt <= 0 or not shape or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return jsonify(error="مقادیر نامعتبر"), 400
    name = (data.get("name") or "").strip() or f"سناریو {datetime.now():%Y-%m-%d %H:%M}"
    db = get_db()
    cur = db.execute(
        "INSERT INTO scenarios (name, lat, lng, tnt_kg, burst, count, spread_m, label, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (name, lat, lng, tnt, *shape, data.get("label"),
         datetime.now().isoformat(timespec="seconds")),
    )
    db.commit()
    return jsonify(id=cur.lastrowid), 201


@app.delete("/api/scenarios/<int:sid>")
def delete_scenario(sid):
    db = get_db()
    db.execute("DELETE FROM scenarios WHERE id = ?", (sid,))
    db.commit()
    return "", 204


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
