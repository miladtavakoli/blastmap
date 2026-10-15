// BlastMap frontend
const map = L.map("map", { zoomControl: false }).setView([35.6997, 51.338], 13);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
document.body.classList.add("tiles-gray");

const $ = (id) => document.getElementById(id);
const layer = L.layerGroup().addTo(map);
let point = null;
let presets = [];
let firstDraw = true;
let lastZones = [], lastSpots = []; // what the 3D view needs to replay the last draw

const faNum = (n, d = 0) => Number(n).toLocaleString("fa-IR", { maximumFractionDigits: d });
const fmtDist = (m) =>
  m >= 1000 ? `${faNum(m / 1000, 2)}<em>کیلومتر</em>` : `${faNum(m)}<em>متر</em>`;
const fmtKg = (kg) =>
  kg >= 1e9 ? `${faNum(kg / 1e9, 1)} مگاتن` : kg >= 1e6 ? `${faNum(kg / 1e6, 1)} کیلوتن` : kg >= 1000 ? `${faNum(kg / 1000, 1)} تن` : `${faNum(kg)} کیلوگرم`;
// Persian/Arabic digits → Latin, keep digits and the first decimal point, then group thousands
function groupDigits(s) {
  s = s.replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 1776).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632)
    .replace(/٫/g, ".").replace(/[^\d.]/g, "");
  const [int, ...frac] = s.split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac.length ? "." + frac.join("") : "");
}
// #tnt shows the chosen unit with separators; everything else (API, URL, presets) is plain kg
let tntUnit = +$("unit").value;
const tntKg = () => Math.round(parseFloat($("tnt").value.replace(/,/g, "")) * tntUnit * 1000) / 1000;
// autoUnit: pick the largest unit that keeps the number ≥ 1 (250 kg, 2.5 تن, 50 مگاتن)
function setTntKg(kg, autoUnit = false) {
  if (autoUnit) {
    tntUnit = +[...$("unit").options].map((o) => o.value).reverse().find((u) => kg >= u) || 1;
    $("unit").value = tntUnit;
  }
  $("tnt").value = groupDigits(String(+(kg / tntUnit).toPrecision(12)));
}
const burstRadios = [...document.querySelectorAll('input[name="burst"]')];
const burst = () => burstRadios.find((r) => r.checked).value;
const setBurst = (v) => { const r = burstRadios.find((x) => x.value === v); if (r) r.checked = true; };
const BURST_FA = { surface: "سطحی", air: "هوایی", buried: "سنگرشکن", cluster: "خوشه‌ای" };

function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "درخواست انجام نشد");
  return data;
}

// ---------- tiles toggle ----------
const tileButtons = [...document.querySelectorAll(".tiles-toggle button")];
const markTiles = (v) => tileButtons.forEach((x) => x.classList.toggle("on", x.dataset.tiles === v));
let view3d = null; // the 3D module once loaded (static/map3d.js)
// ?v=… from this script's URL, so map3d.js is cache-busted together with app.js
const STATIC_V = new URL(document.currentScript.src).search;
const in3d = () => document.body.classList.contains("mode-3d");

async function enter3d() {
  markTiles("3d");
  try {
    view3d ||= await import(`./map3d.js${STATIC_V}`);
    view3d.show(point, lastZones, tntKg(), burst(), lastSpots);
    await view3d.enter(map.getCenter() && [map.getCenter().lat, map.getCenter().lng], map.getZoom() - 1);
    updateUrl();
  } catch (e) {
    console.error(e);
    document.body.classList.remove("mode-3d");
    markTiles(document.body.classList.contains("tiles-gray") ? "gray" : "color");
    toast("نمای سه‌بعدی در این مرورگر یا شبکه در دسترس نیست");
  }
}
function exit3d(tiles) {
  const v = view3d?.exit();
  if (v) map.setView(v.center, Math.round(v.zoom), { animate: false });
  map.invalidateSize();
  markTiles(tiles);
  document.body.classList.toggle("tiles-gray", tiles === "gray");
  updateUrl();
}
tileButtons.forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.tiles === "3d") return in3d() || enter3d();
    if (in3d()) return exit3d(b.dataset.tiles);
    markTiles(b.dataset.tiles);
    document.body.classList.toggle("tiles-gray", b.dataset.tiles === "gray");
  })
);
$("simReplay").addEventListener("click", () => view3d?.replay());
// the 3D map reports clicks here
window.blastApp = {
  setPoint(lat, lng) {
    point = [lat, lng];
    if (window.innerWidth <= 720) setSheet(0);
    draw();
  },
};

// ---------- mobile sheet ----------
// tap the handle: minimize ↔ open; swipe up/down on it: step between minimized / half / full.
// The header buttons do the same: minimize ↔ open, and full screen ↔ normal size.
const SHEET = ["collapsed", "half", "full"];
let sheet = 1, dragY = null;
function setSheet(i) {
  sheet = Math.max(0, Math.min(2, i));
  $("panel").classList.remove(...SHEET);
  $("panel").classList.add(SHEET[sheet]);
  $("sheetHandle").setAttribute("aria-expanded", sheet > 0);
  $("sheetMin").setAttribute("aria-label", sheet ? "کوچک کردن پنل" : "باز کردن پنل");
  $("sheetMax").setAttribute("aria-label", sheet === 2 ? "اندازه‌ی معمولی پنل" : "تمام‌صفحه کردن پنل");
}
$("sheetMin").addEventListener("click", () => setSheet(sheet ? 0 : 1));
$("sheetMax").addEventListener("click", () => setSheet(sheet === 2 ? 1 : 2));
$("sheetHandle").addEventListener("pointerdown", (e) => {
  dragY = e.clientY;
  e.target.setPointerCapture(e.pointerId);
});
// taps are handled here too: after a swipe, touch browsers don't reliably fire click
$("sheetHandle").addEventListener("pointerup", (e) => {
  const dy = e.clientY - dragY;
  setSheet(Math.abs(dy) > 12 ? sheet + (dy < 0 ? 1 : -1) : sheet ? 0 : 1);
});
// keyboard only (Enter/Space give detail 0); pointer clicks were handled above
$("sheetHandle").addEventListener("click", (e) => e.detail || setSheet(sheet ? 0 : 1));
// tapping anywhere on a minimized sheet (e.g. the search box) opens it
$("panel").addEventListener("click", (e) => {
  if (sheet === 0 && !e.target.closest("#sheetHandle, .sheet-btns")) setSheet(1);
});

// ---------- presets ----------
async function loadPresets(selectId) {
  presets = await api("/api/presets");
  const sel = $("preset");
  sel.innerHTML = '<option value="">مقدار دلخواه</option>';
  const groups = {};
  for (const p of presets) {
    if (!groups[p.category]) {
      groups[p.category] = document.createElement("optgroup");
      groups[p.category].label = p.category;
      sel.appendChild(groups[p.category]);
    }
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    groups[p.category].appendChild(o);
  }
  sel.value = selectId ?? "";
}
function syncPresetFromTnt() {
  const t = tntKg();
  const p = presets.find((x) => x.tnt_kg === t);
  $("preset").value = p ? p.id : "";
}

$("preset").addEventListener("change", (e) => {
  const p = presets.find((x) => String(x.id) === e.target.value);
  if (!p) return;
  setTntKg(p.tnt_kg, true);
  // plain-blast presets drop back from bunker-buster/cluster mode; others bring their own mode
  setBurst(p.burst || (["surface", "air"].includes(burst()) ? burst() : "surface"));
  if (p.count) { $("count").value = p.count; $("spread").value = p.spread_m; }
  draw();
});
let tntTimer;
const drawSoon = () => { clearTimeout(tntTimer); tntTimer = setTimeout(draw, 200); };
$("tnt").addEventListener("input", (e) => {
  // reformat with separators, keeping the caret after the same digit
  const el = e.target;
  const before = groupDigits(el.value.slice(0, el.selectionStart)).replace(/,/g, "").length;
  el.value = groupDigits(el.value);
  let pos = 0;
  for (let n = 0; pos < el.value.length && n < before; pos++) if (el.value[pos] !== ",") n++;
  el.setSelectionRange(pos, pos);
  syncPresetFromTnt();
  drawSoon();
});
$("count").addEventListener("input", drawSoon);
$("spread").addEventListener("input", drawSoon);
$("unit").addEventListener("change", (e) => {
  const kg = tntKg();
  tntUnit = +e.target.value;
  if (kg > 0) setTntKg(kg);
});
burstRadios.forEach((r) => r.addEventListener("change", draw));

$("addPresetBtn").addEventListener("click", async () => {
  try {
    const p = await api("/api/presets", {
      method: "POST",
      body: JSON.stringify({ name: $("newName").value, tnt_kg: $("newTnt").value }),
    });
    $("newName").value = $("newTnt").value = "";
    await loadPresets(p.id);
    setTntKg(p.tnt_kg, true);
    draw();
    toast("به فهرست اضافه شد");
  } catch (e) { toast(e.message); }
});

// ---------- drawing ----------
const pinIcon = L.divIcon({ className: "", html: '<div class="gz-pin"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
const canvas = L.canvas(); // hundreds of submunition circles are too many for SVG

// seeded so redraws don't reshuffle the pattern; uniform over the disc, offsets in metres
function scatter(n, r) {
  let s = n * 9973;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, () => {
    const d = r * Math.sqrt(rnd()), a = 2 * Math.PI * rnd();
    return [d * Math.cos(a), d * Math.sin(a)];
  });
}

async function draw() {
  const tnt = tntKg();
  const cluster = burst() === "cluster";
  $("clusterOpts").hidden = !cluster;
  layer.clearLayers();
  if (!(tnt > 0)) {
    $("legend").innerHTML = '<div class="empty">معادل TNT را وارد کنید.</div>';
    view3d?.show(null);
    return;
  }

  let zones;
  const q = new URLSearchParams({ tnt_kg: tnt, burst: burst(), count: $("count").value, spread_m: $("spread").value });
  try { ({ zones } = await api(`/api/zones?${q}`)); }
  catch (e) { return toast(e.message); }

  const max = Math.max(...zones.map((z) => z.radius_m));
  $("legend").innerHTML = zones.map((z) => {
    const [name, psi] = z.label.split(" (");
    return `<div class="zone">
      <span class="name">${name}<small dir="auto">${psi.replace(")", "")}</small></span>
      <span class="r">${fmtDist(z.radius_m)}</span>
      <span class="bar"><i style="width:${(z.radius_m / max) * 100}%;background:${z.color}"></i></span>
    </div>`;
  }).join("");

  if (!point) {
    $("coord").textContent = "نقطه‌ای انتخاب نشده";
    view3d?.show(null);
    return;
  }
  $("coord").textContent = `${point[0].toFixed(4)}, ${point[1].toFixed(4)}`;

  const spots = cluster ? scatter(+$("count").value, +$("spread").value) : [];
  lastZones = zones; lastSpots = spots;
  view3d?.show(point, zones, tnt, burst(), spots);
  const mPerDegLng = 111320 * Math.cos((point[0] * Math.PI) / 180);
  [...zones].reverse().forEach((z, i) => {
    if (z.each) {
      for (const [dx, dy] of spots)
        L.circle([point[0] + dy / 111320, point[1] + dx / mPerDegLng], {
          renderer: canvas, radius: z.radius_m, stroke: false,
          fillColor: z.color, fillOpacity: 0.35, interactive: false,
        }).addTo(layer);
      return;
    }
    L.circle(point, {
      dashArray: z.key === "spread" ? "6 6" : null,
      radius: z.radius_m,
      color: z.color,
      weight: i === zones.length - 1 ? 2 : 1.25,
      opacity: 0.9,
      fillColor: z.color,
      fillOpacity: 0.18,
    }).bindTooltip(`${z.label.split(" (")[0]}: ${fmtDist(z.radius_m).replace(/<\/?em>/g, " ")}`, { sticky: true })
      .addTo(layer);
  });
  L.marker(point, { icon: pinIcon, interactive: false }).addTo(layer);

  const mobile = window.innerWidth <= 720;
  map.fitBounds(L.latLng(point).toBounds(max * 2.3), {
    paddingTopLeft: [24, 24],
    paddingBottomRight: mobile ? [24, sheetVisibleHeight() + 24] : [400, 24],
    maxZoom: 18,
    animate: !firstDraw,
  });
  firstDraw = false;
  updateUrl();
}

function sheetVisibleHeight() {
  const r = $("panel").getBoundingClientRect();
  return Math.max(0, window.innerHeight - r.top);
}

map.on("click", (e) => {
  point = [e.latlng.lat, e.latlng.lng];
  if (window.innerWidth <= 720) setSheet(0);
  draw();
});

$("clearBtn").addEventListener("click", () => {
  point = null;
  layer.clearLayers();
  view3d?.show(null);
  $("coord").textContent = "نقطه‌ای انتخاب نشده";
  history.replaceState(null, "", location.pathname);
});

// ---------- search (Nominatim) ----------
$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("search").value.trim();
  if (!q) return;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=fa&q=${encodeURIComponent(q)}`
    );
    const [hit] = await res.json();
    if (!hit) return toast("مکانی با این نام پیدا نشد؛ نام دیگری امتحان کنید");
    point = [parseFloat(hit.lat), parseFloat(hit.lon)];
    map.setView(point, 14);
    draw();
  } catch { toast("جست‌وجو در دسترس نیست؛ روی نقشه کلیک کنید"); }
});

// ---------- share link ----------
function updateUrl() {
  if (!point) return;
  const p = new URLSearchParams({
    lat: point[0].toFixed(5), lng: point[1].toFixed(5), tnt: tntKg(), burst: burst(),
  });
  if (burst() === "cluster") { p.set("count", $("count").value); p.set("spread", $("spread").value); }
  if (in3d()) p.set("view", "3d");
  history.replaceState(null, "", `?${p}`);
}
$("shareBtn").addEventListener("click", async () => {
  if (!point) return toast("اول روی نقشه یک نقطه انتخاب کنید");
  try { await navigator.clipboard.writeText(location.href); toast("لینک کپی شد"); }
  catch { prompt("لینک:", location.href); }
});

// ---------- scenarios ----------
async function loadScenarios() {
  const list = await api("/api/scenarios");
  $("scCount").textContent = list.length ? faNum(list.length) : "";
  const ul = $("scenarios");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = '<li class="empty" style="cursor:default">هنوز سناریویی ذخیره نشده.</li>';
    return;
  }
  for (const s of list) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `<span class="dot"></span>
      <span class="meta"><b></b><small>${fmtKg(s.tnt_kg)} · ${BURST_FA[s.burst] || ""}</small></span>
      <button class="del" aria-label="حذف">✕</button>`;
    li.querySelector("b").textContent = s.name;
    const open = () => {
      point = [s.lat, s.lng];
      setTntKg(s.tnt_kg, true);
      syncPresetFromTnt();
      setBurst(s.burst);
      if (s.count) { $("count").value = s.count; $("spread").value = s.spread_m; }
      map.setView(point, 14);
      draw();
    };
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => e.key === "Enter" && open());
    li.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/scenarios/${s.id}`, { method: "DELETE" });
      loadScenarios();
      toast("سناریو حذف شد");
    });
    ul.appendChild(li);
  }
}
$("saveBtn").addEventListener("click", async () => {
  if (!point) return toast("اول روی نقشه یک نقطه انتخاب کنید");
  const name = prompt("نام سناریو:", "");
  if (name === null) return;
  try {
    await api("/api/scenarios", {
      method: "POST",
      body: JSON.stringify({ name, lat: point[0], lng: point[1], tnt_kg: tntKg(), burst: burst(),
        count: $("count").value, spread_m: $("spread").value }),
    });
    loadScenarios();
    toast("سناریو ذخیره شد");
  } catch (e) { toast(e.message); }
});

// ---------- init ----------
(async function init() {
  await loadPresets();
  setTntKg(tntKg()); // apply separators to the initial value
  const q = new URLSearchParams(location.search);
  if (q.has("lat") && q.has("lng")) {
    point = [parseFloat(q.get("lat")), parseFloat(q.get("lng"))];
    if (q.get("tnt")) setTntKg(parseFloat(q.get("tnt")), true);
    setBurst(q.get("burst"));
    if (q.get("count")) $("count").value = q.get("count");
    if (q.get("spread")) $("spread").value = q.get("spread");
    map.setView(point, 15, { animate: false });
  }
  syncPresetFromTnt();
  await draw();
  loadScenarios();
  if (q.get("view") === "3d") enter3d();
})();
