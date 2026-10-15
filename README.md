# BlastMap

An educational map for seeing how far the effects of an explosion reach. Pick a point on an
OpenStreetMap map and a munition: a conventional bomb, a bunker buster, a cluster bomb or a
nuclear weapon. The map draws the damage zones around that point. The interface is in Persian
and is meant for civil-defense (پدافند غیرعامل) awareness.

> The numbers are rough estimates from a simplified model. Use them for learning, not for
> planning.

## Run it

**Docker** (serves on port 8000, keeps the database in the `blastmap-data` volume):

```sh
docker compose up -d --build
```

**Locally** (Python 3.12, serves on port 5000):

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py
```

The SQLite database is created on first start and filled with the built-in presets. Set
`BLASTMAP_DB` to store it somewhere other than `./blastmap.db`.

## 3D view

The map-style switch has a third option, **سه‌بعدی** (3D). It loads only when chosen
(MapLibre GL 4.7.1 + three.js 0.169, from unpkg) and opens a tilted map with real building
heights from [OpenFreeMap](https://openfreemap.org) (no API key). Picking a point plays the blast:

- **Shock front:** a translucent shell and a ground ring grow out to the light-damage radius.
  Their timing uses an approximate arrival-time curve with the same cube-root scaling as the
  radii, and the playback bar shows the real elapsed time. The front always takes about 3 seconds
  on screen, so small charges are slowed down and nuclear ones sped up (the bar says by how much).
- **Buildings and places:** as the front reaches each building it gives way. In the
  total-destruction zone it is levelled to rubble; in the heavy zone the upper floors come down;
  in the moderate zone roofs and facades are torn off; in the light zone only the colour changes
  (broken windows). Debris is thrown away from the blast, collapse dust rises, and fires keep
  burning in the rubble. Map labels of places in the heavy zone disappear once the front passes.
  Affected named places (hospitals, schools, …) are marked on the map and listed in the panel with
  a building count per zone. These counts only cover map tiles already loaded, and buildings only
  exist from zoom 13, so the camera never zooms out further than that. A cluster strike does this
  per submunition, with impacts spread over about 0.8 s.
- **Fireball, dust, smoke:** a flash, fireball, dust wall and smoke plume. From 1 kt up, the
  fireball rises into a mushroom cloud; a bunker buster throws up dirt; an air burst detonates
  above the ground. These shapes and sizes are illustrative only, not modeled.

`?view=3d` in a shared link opens the 3D view. With reduced motion turned on, it skips straight
to the end state.

## What it shows

Each zone is a ring with a peak-overpressure threshold:

| Zone | Overpressure | Scaled distance Z (m/kg^⅓) |
|---|---|---|
| Total destruction | ~20 psi | 3.0 |
| Heavy structural damage | ~5 psi | 7.0 |
| Moderate damage | ~3 psi | 9.5 |
| Light damage / broken glass | ~1 psi | 18.0 |

The radius is `Z × (TNT kg)^⅓`, using cube-root scaling with approximate Kingery-Bulmash values
for a surface burst. Each burst type adjusts that radius:

- **Surface:** as above.
- **Air:** radii × 1.25.
- **Bunker buster (buried):** radii × 0.45. This assumes about 10% of the energy reaches the
  air when the bomb explodes underground. The map shows only this weakened surface blast, not
  damage below ground.
- **Cluster:** the TNT amount is split evenly across the submunitions. They are scattered over
  the chosen spread radius, and each one gets its own small set of zones.

Presets cover conventional bombs, bunker busters (BLU-109, GBU-28, GBU-57), cluster munitions
(CBU-87, M26 rocket) and nuclear weapons (1 kt, Hiroshima, Nagasaki, 300 kt, Tsar Bomba). Their
figures are approximate public values.

### Not modeled

Fragments, buildings, terrain and structure type are ignored. For nuclear weapons only the blast
is shown: no thermal radiation, initial radiation or fallout. The full yield is also counted as
blast, although in reality about half goes to blast, so nuclear radii come out larger than they
should.

## Features

- Search for a place, or click the map to set the point.
- Enter TNT equivalent in kg, t, kt or Mt.
- Save scenarios to the database.
- Copy a share link. The link encodes the point and settings: `?lat=&lng=&tnt=&burst=&count=&spread=`.
- Add your own presets.
- On phones the panel is a bottom sheet: tap the handle to minimize it, swipe up or down to
  resize.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/zones?tnt_kg=&burst=` | `burst`: `surface` (default), `air`, `buried`, `cluster`. A cluster also needs `count` (1–2000) and `spread_m` |
| GET / POST | `/api/presets` | POST body: `{"name", "tnt_kg", "category"?}` |
| DELETE | `/api/presets/<id>` | |
| GET / POST | `/api/scenarios` | POST body: `{"name"?, "lat", "lng", "tnt_kg", "burst"?, "count"?, "spread_m"?}` |
| DELETE | `/api/scenarios/<id>` | |

## Project layout

```
app.py              Flask app: blast model, SQLite schema/migrations, API
templates/index.html
static/app.js       map, drawing, share links, mobile sheet
static/style.css
test_app.py         self-check: python test_app.py
```

## Test

```sh
python test_app.py
```

It runs against a temporary database and checks the burst models, input validation and how
scenarios are saved.
