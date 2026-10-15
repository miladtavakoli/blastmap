// BlastMap 3D: MapLibre map with extruded buildings + a three.js layer that plays the blast.
// Loaded on demand (import()) the first time the 3D view is chosen.
// The radii and zones come from /api/zones, exactly as in 2D; arrival times use the same
// cube-root scaling. Fireball, cloud and dust sizes are illustrative, not modeled.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";

const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl";
const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SHOCK_ANIM_S = 3.2; // the shock front always takes this long on screen
const END_ANIM_S = 22; // effects have faded by now; the render loop stops
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- shock arrival time ----------
// Arrival time per kg^(1/3) (ms) against scaled distance Z (m/kg^(1/3)), rough Kingery-Bulmash
// shape for a surface burst. Past the table the front moves at about the speed of sound.
const TA = [[0, 0], [0.5, 0.08], [1, 0.3], [2, 1.2], [3, 2.6], [5, 6.5], [7, 11.5],
  [9.5, 18.5], [12, 25.5], [18, 43], [30, 80], [50, 140]];
function lerpTable(table, x, xi, yi) {
  if (x <= table[0][xi]) return table[0][yi];
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1], b = table[i];
    if (x <= b[xi]) return a[yi] + ((x - a[xi]) / (b[xi] - a[xi])) * (b[yi] - a[yi]);
  }
  const a = table[table.length - 2], b = table[table.length - 1];
  return b[yi] + ((x - b[xi]) / (b[xi] - a[xi])) * (b[yi] - a[yi]);
}
// seconds for the front to reach r metres; w = kg TNT, f = burst radius factor
const arrival = (r, w, f) => (Math.cbrt(w) * f * lerpTable(TA, r / (Math.cbrt(w) * f), 0, 1)) / 1000;
const radiusAt = (t, w, f) => Math.cbrt(w) * f * lerpTable(TA, (t * 1000) / (Math.cbrt(w) * f), 1, 0);

// ---------- small helpers ----------
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function rng(seed) {
  let s = Math.floor(seed) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const M_PER_DEG = 111320;
function offset([lat, lng], dx, dz) { // metres east, metres south → [lng, lat]
  return [lng + dx / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat - dz / M_PER_DEG];
}
function circle(center, r, x = 0, z = 0, n = 64) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push(offset(center, x + r * Math.cos(a), z + r * Math.sin(a)));
  }
  return ring;
}
function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error("load " + src));
    document.head.appendChild(s);
  });
}

// ---------- shaders ----------
const NOISE = `
float hash(vec3 p){p=fract(p*0.3183099+.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){vec3 i=floor(x);vec3 f=fract(x);f=f*f*(3.-2.*f);
 return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.03;a*=.5;}return v;}`;

const SHELL_VERT = `
varying vec3 vW; varying vec3 vN;
void main(){ vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; vN=normalize(mat3(modelMatrix)*normal);
 gl_Position = projectionMatrix*viewMatrix*w; }`;

const fireballMat = () => new THREE.ShaderMaterial({
  uniforms: { uEye: { value: new THREE.Vector3() }, uHeat: { value: 1 }, uTime: { value: 0 },
    uOpacity: { value: 1 }, uScale: { value: 1 } },
  vertexShader: SHELL_VERT,
  fragmentShader: `${NOISE}
uniform vec3 uEye; uniform float uHeat, uTime, uOpacity, uScale; varying vec3 vW; varying vec3 vN;
void main(){
  vec3 v = normalize(uEye - vW);
  float facing = abs(dot(vN, v));
  float n = fbm(vW / uScale * 2.6 + vec3(0., -uTime * .9, uTime * .3));
  float t = uHeat * (.55 + .6 * n) * (.55 + .45 * facing);
  vec3 c = mix(vec3(.16,.11,.09), vec3(.62,.12,.04), smoothstep(.05,.25,t));
  c = mix(c, vec3(1.,.45,.08), smoothstep(.25,.5,t));
  c = mix(c, vec3(1.,.83,.42), smoothstep(.5,.75,t));
  c = mix(c, vec3(1.,.98,.9), smoothstep(.8,1.,t));
  float a = uOpacity * smoothstep(0., .25, facing + .15) * (.75 + .25 * n);
  if (vW.y < 0.) discard;
  gl_FragColor = vec4(c, a);
}`,
  transparent: true, depthWrite: false,
});

const shellMat = () => new THREE.ShaderMaterial({
  uniforms: { uEye: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(1, 1, 1) } },
  vertexShader: SHELL_VERT,
  fragmentShader: `
uniform vec3 uEye, uColor; uniform float uAlpha; varying vec3 vW; varying vec3 vN;
void main(){
  if (vW.y < 0.) discard;
  float f = 1. - abs(dot(vN, normalize(uEye - vW)));
  gl_FragColor = vec4(uColor, uAlpha * (pow(f, 3.) * .9 + .05));
}`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
});

const pointsMat = (additive) => new THREE.ShaderMaterial({
  uniforms: { uPx: { value: 1 } },
  vertexShader: `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aSeed;
uniform float uPx; varying float vA; varying vec3 vC; varying float vS;
void main(){ vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position=p;
 gl_PointSize = aAlpha <= 0. ? 0. : clamp(aSize * uPx / p.w, 1., 600.); vA=aAlpha; vC=aColor; vS=aSeed; }`,
  fragmentShader: `
varying float vA; varying vec3 vC; varying float vS;
void main(){ vec2 q = gl_PointCoord - .5; float d = length(q);
  float lobes = .08 * sin(atan(q.y, q.x) * 5. + vS * 40.);
  float a = smoothstep(.5, .12, d + lobes) * vA; if (a < .004) discard;
  gl_FragColor = vec4(vC * (1. - .25 * d), a); }`,
  transparent: true, depthWrite: false,
  blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
});

class Particles {
  constructor(n, additive = false) {
    this.n = n;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3); this.size = new Float32Array(n);
    this.alpha = new Float32Array(n); this.color = new Float32Array(n * 3);
    const seed = new Float32Array(n).map(Math.random);
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.color, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.mat = pointsMat(additive);
    this.obj = new THREE.Points(g, this.mat);
    this.obj.frustumCulled = false;
    this.g = g;
  }
  set(i, x, y, z, size, alpha, r, gr, b) {
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.size[i] = size; this.alpha[i] = alpha;
    this.color[i * 3] = r; this.color[i * 3 + 1] = gr; this.color[i * 3 + 2] = b;
  }
  commit() { for (const k of ["position", "aSize", "aAlpha", "aColor"]) this.g.attributes[k].needsUpdate = true; }
  dispose() { this.g.dispose(); this.mat.dispose(); }
}

// ---------- the blast scene ----------
// Builds the three.js objects for one detonation and moves them for anim time a (seconds).
class Blast {
  constructor(p) {
    this.p = p;
    this.scene = new THREE.Scene();
    const R = p.R, rand = rng(p.w * 7 + 13);
    this.parts = [];

    if (!p.cluster) {
      this.fire = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), fireballMat());
      this.fire.material.uniforms.uScale.value = p.Rf;
      this.shell = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 36), shellMat());
      this.ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 160).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xfff4e0, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      this.ring.position.y = Math.max(0.3, p.Rlight * 0.001);
      this.scene.add(this.fire, this.shell, this.ring);
    }

    // dust wall: lifted where the front passes, rolling outward
    const nd = p.cluster ? 0 : 1800;
    this.dust = new Particles(nd);
    this.dustP = Array.from({ length: nd }, () => {
      const r = p.Rf * 0.8 + Math.sqrt(rand()) * (R[2] - p.Rf * 0.8);
      return { r, a: rand() * 2 * Math.PI, t: arrival(r, p.w, p.f), h: rand(), s: 0.5 + rand() };
    });

    // smoke: a rising plume, or the stem and cap of a mushroom cloud
    const ns = p.cluster ? 0 : p.nuclear ? 3200 : 700;
    this.smoke = new Particles(ns);
    this.smokeP = Array.from({ length: ns }, (_, i) => ({
      u: rand(), v: rand() * 2 * Math.PI, k: rand(), cap: p.nuclear ? i < ns * 0.7 : false, s: 0.6 + rand() * 0.8,
    }));

    // dirt thrown up by a buried charge
    const ne = p.burst === "buried" ? 1400 : 0;
    this.ejecta = new Particles(ne);
    this.ejectaP = Array.from({ length: ne }, () => {
      const ang = rand() * 2 * Math.PI, tilt = rand() * 0.55;
      const v = Math.sqrt(2 * 9.81 * p.Rtotal * (0.6 + rand() * 1.4)) * 1.4;
      return { vx: Math.cos(ang) * Math.sin(tilt) * v, vy: Math.cos(tilt) * v, vz: Math.sin(ang) * Math.sin(tilt) * v, s: 0.5 + rand() };
    });

    // cluster: a small flash and puff at each impact point
    const nc = p.cluster ? p.spots.length : 0;
    this.sub = new Particles(nc, true);
    this.subDust = new Particles(nc);
    this.subP = p.cluster ? p.spots.map((s, i) => ({ x: s[0], z: -s[1], t0: p.stagger[i] })) : [];

    for (const ps of [this.dust, this.smoke, this.ejecta, this.subDust, this.sub]) if (ps.n) {
      this.parts.push(ps); this.scene.add(ps.obj);
    }
  }

  // a: animation seconds since detonation; tr: real seconds; eye, px from the camera
  update(a, tr, eye, px) {
    const p = this.p;
    for (const ps of this.parts) ps.mat.uniforms.uPx.value = px;
    const shockR = radiusAt(tr, p.w, p.f);
    const passed = tr >= p.Tend;

    if (this.fire) {
      const nuc = p.nuclear;
      const grow = 1 - Math.exp(-a / (nuc ? 0.35 : 0.12));
      const heat = Math.exp(-a / (nuc ? 6 : 0.9));
      const rise = nuc ? p.Hc * smooth(0.6, 16, a) * 0.92 : p.Rf * 2.2 * smooth(0.3, 4, a);
      const r = p.Rf * grow * (1 + (nuc ? 0.35 : 0.5) * smooth(0.5, 8, a));
      this.fire.scale.set(r, r * (nuc ? 1 - 0.25 * smooth(2, 12, a) : 1), r);
      this.fire.position.set(0, p.H + rise + (p.burst === "air" || nuc ? 0 : r * 0.35), 0);
      const u = this.fire.material.uniforms;
      u.uEye.value.copy(eye); u.uHeat.value = heat; u.uTime.value = a;
      u.uOpacity.value = nuc ? 1 - smooth(10, 18, a) : 1 - smooth(1.2, 3.2, a);
      this.fire.visible = u.uOpacity.value > 0.01;

      const rs = Math.hypot(shockR, p.H);
      this.shell.scale.setScalar(Math.max(rs, 0.01));
      this.shell.position.set(0, p.H, 0);
      const sa = passed ? 0 : 0.55 * (1 - 0.7 * clamp01(shockR / p.Rlight)) * smooth(0, 0.05, a);
      this.shell.material.uniforms.uAlpha.value = sa;
      this.shell.material.uniforms.uEye.value.copy(eye);
      this.shell.visible = sa > 0.005;

      this.ring.scale.setScalar(Math.max(shockR, 0.01));
      this.ring.material.opacity = passed ? 0 : 0.8 * (1 - clamp01(shockR / p.Rlight) * 0.8);
      this.ring.visible = this.ring.material.opacity > 0.01;
    }

    // dust wall
    this.dustP.forEach((d, i) => {
      const da = (tr - d.t) * p.speed; // anim seconds since the front passed this particle
      if (da < 0) return this.dust.set(i, 0, 0, 0, 0, 0, 0, 0, 0);
      const k = 1 - Math.exp(-da / 2.5);
      const r = d.r + p.Rlight * 0.06 * k * d.s;
      const y = (p.Rtotal * 0.25 + d.r * 0.08) * d.h * k + 0.5;
      const glow = Math.exp(-a / 1.2);
      const fade = 1 - smooth(6, 16, da);
      this.dust.set(i, Math.cos(d.a) * r, y, Math.sin(d.a) * r,
        (p.Rtotal * 0.35 + d.r * 0.06) * d.s * (0.4 + k), 0.33 * fade * smooth(0, 0.3, da),
        0.6 + 0.35 * glow, 0.54 + 0.12 * glow, 0.47 - 0.15 * glow);
    });

    // smoke / mushroom cloud
    const capY = p.H + (p.nuclear ? p.Hc * smooth(0.6, 16, a) * 0.92 : p.Rf * 2.2 * smooth(0.3, 4, a));
    const capR = p.nuclear ? p.Rf * (1 + 3.6 * smooth(1, 16, a)) : p.Rf;
    const smokeIn = smooth(0.4, 2.2, a), smokeOut = 1 - smooth(14, END_ANIM_S - 1, a);
    this.smokeP.forEach((s, i) => {
      let x, y, z, size, col;
      const age = smooth(0, 10, a);
      if (s.cap) { // toroidal cap that rolls over as it rises
        const phi = s.v + a * 0.35;
        const theta = s.u * 2 * Math.PI + a * (0.4 + 0.3 * s.k);
        const minor = capR * (0.45 + 0.15 * s.k);
        const rr = capR + Math.cos(theta) * minor;
        x = Math.cos(phi) * rr; z = Math.sin(phi) * rr; y = capY + Math.sin(theta) * minor * 0.8;
        size = capR * 0.75 * s.s;
        const hot = 1 - age;
        col = [0.42 + 0.5 * hot * (0.5 + 0.5 * Math.cos(theta)), 0.36 + 0.14 * hot, 0.32 - 0.1 * hot];
      } else if (p.nuclear) { // stem
        const flow = (s.u + a * 0.05) % 1;
        const rad = capR * (0.14 + 0.12 * s.k) * (0.6 + 0.8 * flow);
        x = Math.cos(s.v) * rad; z = Math.sin(s.v) * rad; y = flow * capY * 0.9;
        size = capR * 0.45 * s.s * (0.5 + flow);
        col = [0.55, 0.48, 0.42];
      } else { // plume
        const life = (s.u + a * 0.06) % 1;
        const rad = p.Rf * (0.3 + 1.6 * life) * s.k;
        x = Math.cos(s.v) * rad + life * p.Rf * 0.8; z = Math.sin(s.v) * rad;
        y = p.H + p.Rf * (0.5 + life * 5 * smokeIn);
        size = p.Rf * (0.6 + 1.8 * life) * s.s;
        col = [0.36, 0.34, 0.33];
      }
      const al = (p.nuclear ? 0.55 : 0.4) * smokeIn * smokeOut * (s.cap || p.nuclear ? 1 : 1 - Math.abs(((s.u + a * 0.06) % 1) * 2 - 1) * 0.6);
      this.smoke.set(i, x, y, z, size, al, ...col);
    });

    // ejecta (buried charge)
    this.ejectaP.forEach((e, i) => {
      const t = Math.min(a * 0.6, 12); // ballistic flight, slowed for the eye
      let y = e.vy * t - 4.9 * t * t;
      const land = y < 0 && t > 0.2;
      y = Math.max(0.3, y);
      const al = land ? 0.5 * (1 - smooth(0, 6, a - 2 * e.vy / 9.81 / 0.6)) : 0.55 * smooth(0, 0.1, a);
      this.ejecta.set(i, e.vx * t, y, e.vz * t, p.Rtotal * 0.18 * e.s * (1 + 0.3 * t), al * (1 - smooth(12, 18, a)), 0.42, 0.33, 0.24);
    });

    // cluster sub-bursts
    this.subP.forEach((s, i) => {
      const sa = (tr - s.t0) * p.speed;
      if (sa < 0) { this.sub.set(i, 0, 0, 0, 0, 0, 0, 0, 0); this.subDust.set(i, 0, 0, 0, 0, 0, 0, 0, 0); return; }
      const g = Math.exp(-sa / 0.35);
      this.sub.set(i, s.x, p.subR * 0.6, s.z, p.subR * (1.6 + 1.5 * (1 - g)), g * 0.95, 1, 0.62 + 0.3 * g, 0.25 + 0.5 * g);
      this.subDust.set(i, s.x, p.subR * (0.6 + sa * 0.25), s.z, p.subR * (1.5 + 2.2 * smooth(0, 3, sa)),
        0.45 * smooth(0, 0.15, sa) * (1 - smooth(5, 14, sa)), 0.5, 0.46, 0.42);
    });

    for (const ps of this.parts) ps.commit();
  }

  dispose() {
    this.scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    for (const ps of this.parts) ps.dispose();
  }
}

// ---------- the 3D view ----------
let map, renderer, camera, layerReady, blast = null, sim = null, buildSrc = null, idsOk = false;
const el = (id) => document.getElementById(id);

async function createMap(center, zoom) {
  if (!window.maplibregl) {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = MAPLIBRE + ".css";
    document.head.appendChild(css);
    await loadScript(MAPLIBRE + ".js");
  }
  const ml = window.maplibregl;
  map = new ml.Map({
    container: "map3d", style: STYLE, center: [center[1], center[0]], zoom,
    pitch: 55, bearing: -20, maxPitch: 78, antialias: true, attributionControl: { compact: true },
  });
  map.addControl(new ml.NavigationControl({ visualizePitch: true }), "bottom-left");
  map.on("click", (e) => window.blastApp?.setPoint(e.lngLat.lat, e.lngLat.lng));
  await new Promise((ok, fail) => { map.once("load", ok); map.once("error", (e) => fail(e.error || e)); });
  addLayers();
}

function addLayers() {
  const layers = map.getStyle().layers;
  const firstSymbol = layers.find((l) => l.type === "symbol")?.id;
  const bl = layers.filter((l) => l["source-layer"] === "building");
  if (bl.length) {
    buildSrc = bl[0].source;
    bl.forEach((l) => map.setLayoutProperty(l.id, "visibility", "none"));
    const height = ["coalesce", ["get", "render_height"], ["get", "height"], 8];
    map.addLayer({
      id: "bm-buildings", type: "fill-extrusion", source: buildSrc, "source-layer": "building", minzoom: 12,
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], height, 0, "#dcd8d2", 60, "#c9cdd1", 200, "#b6bec6"],
        "fill-extrusion-height": height,
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
      },
    }, firstSymbol);
  }
  map.addSource("bm-zones", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("bm-damage", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "bm-zones-fill", type: "fill", source: "bm-zones", filter: ["!=", ["get", "key"], "spread"],
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0 } }, firstSymbol);
  map.addLayer({ id: "bm-zones-line", type: "line", source: "bm-zones",
    paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "outer"], 2.2, 1.4], "line-opacity": 0 } }, firstSymbol);
  map.addLayer({ id: "bm-spread", type: "line", source: "bm-zones", filter: ["==", ["get", "key"], "spread"],
    paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-dasharray": [3, 3] } }, firstSymbol);
  map.addLayer({
    id: "bm-damage", type: "fill-extrusion", source: "bm-damage",
    paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": 0,
      "fill-extrusion-base": ["get", "b"], "fill-extrusion-opacity": 0.95 },
  }, firstSymbol);

  map.addLayer({
    id: "bm-blast", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      camera = new THREE.Camera();
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, matrix) {
      if (!blast || !sim) return;
      const now = performance.now();
      const a = reduceMotion ? END_ANIM_S : (now - sim.start) / 1000;
      const tr = a / sim.p.speed;
      const merc = sim.merc, s = merc.meterInMercatorCoordinateUnits();
      const l = new THREE.Matrix4().makeTranslation(merc.x, merc.y, merc.z)
        .scale(new THREE.Vector3(s, -s, s)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      const M = new THREE.Matrix4().fromArray(matrix).multiply(l);
      camera.projectionMatrix = M;
      camera.projectionMatrixInverse.copy(M).invert();
      // the eye is where the projection sends to w = 0
      const e = new THREE.Vector4(0, 0, 1, 0).applyMatrix4(camera.projectionMatrixInverse);
      const eye = new THREE.Vector3(e.x / e.w, e.y / e.w, e.z / e.w);
      // pixels per metre at w = 1, for particle sizes
      const c = m_canvasSize();
      const p0 = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(M);
      const p1 = new THREE.Vector4(1, 0, 0, 1).applyMatrix4(M);
      const p2 = new THREE.Vector4(0, 0, 1, 1).applyMatrix4(M);
      const px = (q) => [(q.x / q.w) * c[0] * 0.5, (q.y / q.w) * c[1] * 0.5];
      const [ax, ay] = px(p0), [bx, by] = px(p1), [cx, cy] = px(p2);
      const ppm = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - ax, cy - ay)) * p0.w * devicePixelRatio;

      blast.update(a, tr, eye, ppm);
      renderer.resetState();
      renderer.render(blast.scene, camera);
      tickMap(a, tr);
      if (a < END_ANIM_S) map.triggerRepaint();
    },
  });
}
function m_canvasSize() { const cv = map.getCanvas(); return [cv.clientWidth, cv.clientHeight]; }

// ---------- per-frame map updates (zones, building damage, light) ----------
let lastMapTick = -1;
function tickMap(a, tr) {
  if (!sim) return;
  updateClock(a, tr);
  // the sun briefly takes the fireball's colour
  const glow = reduceMotion ? 0 : Math.exp(-a / (sim.p.nuclear ? 2.5 : 0.6));
  if (glow > 0.01 || !sim.lightReset) {
    map.setLight({ anchor: "viewport", color: glow > 0.01 ? `rgb(255,${Math.round(255 - 70 * glow)},${Math.round(255 - 150 * glow)})` : "#ffffff",
      intensity: 0.5 + 0.4 * glow });
    sim.lightReset = glow <= 0.01;
  }
  if (performance.now() - lastMapTick < 66 && a < END_ANIM_S) return;
  lastMapTick = performance.now();
  const T = tr;
  map.setPaintProperty("bm-zones-fill", "fill-opacity", ["case", ["<=", ["get", "t"], T], 0.1, 0]);
  map.setPaintProperty("bm-zones-line", "line-opacity", ["case", ["<=", ["get", "t"], T], 0.9, 0]);
  map.setPaintProperty("bm-damage", "fill-extrusion-height", ["case", ["<=", ["get", "t"], T], ["get", "h"], 0]);
  if (map.getLayer("bm-buildings") && idsOk) {
    const hide = sim.hidden.filter((h) => h.t <= T).map((h) => h.id);
    if (hide.length !== sim.hiddenShown) {
      sim.hiddenShown = hide.length;
      map.setFilter("bm-buildings", hide.length ? ["!", ["in", ["id"], ["literal", hide]]] : null);
    }
  }
}

function fmtSec(s) {
  const n = (v, d) => Number(v).toLocaleString("fa-IR", { maximumFractionDigits: d });
  return s < 1 ? `${n(s * 1000, 0)} میلی‌ثانیه` : `${n(s, 2)} ثانیه`;
}
function updateClock(a, tr) {
  const p = sim.p;
  el("simClock").textContent = tr < p.Tend ? `زمان واقعی: ${fmtSec(tr)}` : `موج در ${fmtSec(p.Tend)} به لبه‌ی آسیب سبک رسید`;
}

// ---------- building damage ----------
const DAMAGE = [ // per zone: overlay colour, height factor when the original can be hidden
  { color: "#3b302b", h: 0.07 }, { color: "#7b4a35", h: 0.55 }, { color: "#c98a5c", h: 1 }, { color: "#e9dcb6", h: 1 },
];
function buildDamage(p, center) {
  const out = [], hidden = [];
  if (!buildSrc) return { features: [], hidden };
  const feats = map.querySourceFeatures(buildSrc, { sourceLayer: "building" });
  const seen = new Set();
  const cosLat = Math.cos((center[0] * Math.PI) / 180);
  let withId = 0;
  for (const f of feats) {
    const g = f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    const lng = sx / ring.length, lat = sy / ring.length;
    const key = f.id != null ? "i" + f.id + ":" + ring.length : ring[0].join();
    if (seen.has(key)) continue;
    seen.add(key);
    const x = (lng - center[1]) * M_PER_DEG * cosLat, z = -(lat - center[0]) * M_PER_DEG;
    // zone and arrival time; for a cluster, the earliest sub-burst that reaches it
    let zone = -1, t = Infinity;
    const test = (dx, dz, t0, radii, w) => {
      const d = Math.hypot(dx, dz);
      const zi = radii.findIndex((r) => d <= r);
      if (zi < 0) return;
      const ti = t0 + arrival(d, w, p.f);
      if (zone < 0 || zi < zone || (zi === zone && ti < t)) { zone = zi; t = ti; }
    };
    if (p.cluster) p.spots.forEach((s, i) => test(x - s[0], z + s[1], p.stagger[i], p.subRadii, p.w));
    else test(x, z, 0, p.R, p.w);
    if (zone < 0) continue;
    const h = f.properties.render_height ?? f.properties.height ?? 8;
    const b = f.properties.render_min_height ?? 0;
    if (f.id != null) withId++;
    out.push({ g, zone, t, h, b, id: f.id });
  }
  idsOk = out.length > 0 && withId === out.length;
  const features = out.map((o) => {
    const d = DAMAGE[o.zone];
    const collapse = idsOk && o.zone < 2;
    if (collapse) hidden.push({ id: o.id, t: o.t });
    return { type: "Feature", geometry: o.g,
      properties: { color: d.color, t: o.t, b: o.b, h: collapse ? Math.max(o.b + 1.2, o.b + (o.h - o.b) * d.h) : o.h + 0.4 } };
  });
  return { features, hidden };
}

// ---------- public API ----------
function params(point, zones, tnt, burst, spots) {
  const main = zones.filter((z) => !z.each && z.key !== "spread");
  const each = zones.filter((z) => z.each);
  const cluster = burst === "cluster";
  const radii = (cluster ? each : main).map((z) => z.radius_m);
  const f = { air: 1.25, buried: 0.45 }[burst] || 1;
  const w = cluster ? tnt / spots.length : tnt;
  const p = { w, f, burst, cluster, nuclear: !cluster && tnt >= 1e6, spots: spots || [] };
  if (cluster) {
    const r = rng(spots.length * 31 + 7);
    p.stagger = spots.map(() => r() * 0.8); // impacts spread over ~0.8 s
    p.subRadii = radii;
    p.subR = Math.max(1, radii[0] * 0.5);
    const spread = zones.find((z) => z.key === "spread")?.radius_m || 0;
    p.R = [radii[0], radii[1], radii[2], spread + radii[3]];
    p.Tend = 0.8 + arrival(radii[3], w, f);
  } else {
    p.R = radii;
    p.Tend = arrival(radii[3], w, f);
  }
  p.Rtotal = p.R[0]; p.Rlight = p.R[3];
  p.Rf = Math.max(1.5, p.Rtotal * (p.nuclear ? 0.22 : 0.3) * (burst === "buried" ? 0.35 : 1));
  p.H = burst === "air" ? p.Rtotal * 0.6 : 0;
  p.Hc = p.nuclear ? p.R[1] * 2.2 : 0;
  p.speed = SHOCK_ANIM_S / Math.max(p.Tend, 1e-3); // anim seconds per real second
  return p;
}

function zoneFeatures(point, zones, p) {
  const feats = [];
  const main = zones.filter((z) => !z.each && z.key !== "spread");
  if (p.cluster) {
    const each = zones.filter((z) => z.each);
    p.spots.forEach((s, i) => [...each].reverse().forEach((z) => feats.push({
      type: "Feature", geometry: { type: "Polygon", coordinates: [circle(point, z.radius_m, s[0], -s[1], 20)] },
      properties: { color: z.color, key: z.key, outer: false, t: p.stagger[i] + arrival(z.radius_m, p.w, p.f) },
    })));
  }
  [...main].reverse().forEach((z, i) => feats.push({
    type: "Feature", geometry: { type: "Polygon", coordinates: [circle(point, z.radius_m)] },
    properties: { color: z.color, key: z.key, outer: i === 0, t: arrival(z.radius_m, p.w, p.f) },
  }));
  const sp = zones.find((z) => z.key === "spread");
  if (sp) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [circle(point, sp.radius_m)] },
    properties: { color: sp.color, key: "spread", outer: true, t: 0 } });
  return { type: "FeatureCollection", features: feats };
}

function frame(point, p) {
  const viewR = Math.max(p.Rlight * 1.25, p.Hc * 0.75, 60);
  const [w, h] = m_canvasSize();
  const mobile = window.innerWidth <= 720;
  const avail = mobile ? Math.min(w, h * 0.55) : Math.min(w - 400, h);
  const mpp = (viewR * 2) / Math.max(200, avail * 0.9);
  const zoom = Math.log2((40075016.686 * Math.cos((point[0] * Math.PI) / 180)) / (512 * mpp)) + 0.2;
  return {
    center: [point[1], point[0]], zoom: Math.max(3, Math.min(18, zoom)), pitch: p.Hc ? 62 : 58,
    bearing: map.getBearing() || -20,
    padding: mobile ? { bottom: Math.round(h * 0.4), top: 40 } : { right: 390, top: 40 },
  };
}

function waitIdle(ms) {
  return new Promise((ok) => {
    const t = setTimeout(ok, ms);
    map.once("idle", () => { clearTimeout(t); ok(); });
  });
}

let runId = 0;
async function play(point, zones, tnt, burst, spots, { fly = true } = {}) {
  const id = ++runId;
  const p = params(point, zones, tnt, burst, spots);
  blast?.dispose(); blast = null; sim = null;
  map.getSource("bm-zones").setData(zoneFeatures(point, zones, p));
  map.getSource("bm-damage").setData({ type: "FeatureCollection", features: [] });
  if (map.getLayer("bm-buildings")) map.setFilter("bm-buildings", null);
  el("simBar").hidden = false;
  el("simClock").textContent = "در حال آماده‌سازی…";
  const sp = p.speed;
  el("simSpeed").textContent = sp >= 1.05
    ? `${Number(sp).toLocaleString("fa-IR", { maximumFractionDigits: sp < 10 ? 1 : 0 })}× آهسته‌تر از واقعیت`
    : sp <= 0.95 ? `${Number(1 / sp).toLocaleString("fa-IR", { maximumFractionDigits: 1 })}× سریع‌تر از واقعیت` : "سرعت واقعی";

  if (fly) {
    map.flyTo({ ...frame(point, p), duration: reduceMotion ? 0 : 1400, essential: true });
    await new Promise((ok) => map.once("moveend", ok));
  }
  await waitIdle(4000);
  if (id !== runId) return;

  const { features, hidden } = buildDamage(p, point);
  map.getSource("bm-damage").setData({ type: "FeatureCollection", features });
  blast = new Blast(p);
  sim = { p, start: performance.now(), hidden, hiddenShown: -1, lightReset: false,
    merc: window.maplibregl.MercatorCoordinate.fromLngLat([point[1], point[0]], 0) };
  lastMapTick = -1;
  if (!reduceMotion) flash(p);
  map.triggerRepaint();
}

function flash(p) {
  const f = el("flash");
  f.style.setProperty("--flash", p.nuclear ? 0.95 : p.cluster ? 0.25 : 0.55);
  f.style.setProperty("--flash-ms", p.nuclear ? "1600ms" : "450ms");
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
}

let last = null;
export async function enter(center, zoom) {
  document.body.classList.add("mode-3d");
  if (!map) {
    try { await createMap(center, zoom); }
    catch (e) { document.body.classList.remove("mode-3d"); map?.remove(); map = null; throw e; }
  } else {
    map.resize();
    map.jumpTo({ center: [center[1], center[0]], zoom });
  }
  if (last) await play(...last);
}

export function exit() {
  document.body.classList.remove("mode-3d");
  el("simBar").hidden = true;
  const c = map?.getCenter();
  return c ? { center: [c.lat, c.lng], zoom: map.getZoom() + 1 } : null;
}

// called by app.js on every redraw; plays only while the 3D view is open
export function show(point, zones, tnt, burst, spots) {
  last = point ? [point, zones, tnt, burst, spots] : null;
  if (!map || !document.body.classList.contains("mode-3d")) return;
  if (!point) {
    runId++; blast?.dispose(); blast = null; sim = null;
    map.getSource("bm-zones").setData({ type: "FeatureCollection", features: [] });
    map.getSource("bm-damage").setData({ type: "FeatureCollection", features: [] });
    if (map.getLayer("bm-buildings")) map.setFilter("bm-buildings", null);
    el("simBar").hidden = true;
    return;
  }
  play(...last);
}

export function replay() { if (last && map) play(...last, { fly: false }); }
