// BlastMap 3D: MapLibre map with extruded buildings + a three.js layer that plays the blast.
// Loaded on demand (import()) the first time the 3D view is chosen.
// The radii and zones come from /api/zones, exactly as in 2D; arrival times use the same
// cube-root scaling. Fireball, cloud and dust sizes are illustrative, not modeled.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";

const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl";
const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SHOCK_ANIM_S = 3.2; // the shock front always takes this long on screen
const END_ANIM_S = 32; // effects (and the fires) have faded by now; the render loop stops
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
    this.ruins?.update(a, px);
  }

  setRuins(ruins) {
    if (this.ruins) { this.scene.remove(this.ruins.group); this.ruins.dispose(); }
    this.ruins = ruins;
    this.scene.add(ruins.group);
  }

  dispose() {
    this.ruins?.dispose();
    this.scene.traverse((o) => { if (o.isPoints || o.isInstancedMesh) return; o.geometry?.dispose(); o.material?.dispose?.(); });
    for (const ps of this.parts) ps.dispose();
  }
}

// ---------- ruins: debris thrown off each building, collapse dust, fires ----------
// hit: [{x, z, h, size, zone, ta (anim s), dx, dz (unit vector away from the blast)}]
const RUIN = [ // per zone: chunks, launch speed (m/s), fire chance
  { chunks: 9, v: [18, 45], fire: 0.75 }, { chunks: 6, v: [8, 22], fire: 0.35 },
  { chunks: 2, v: [3, 9], fire: 0 }, { chunks: 0, v: [0, 0], fire: 0 },
];
const MAX_CHUNKS = 4500, MAX_FIRES = 90;
const BUILDING_ZOOM = 13; // OpenMapTiles has no buildings below this
class Ruins {
  constructor(hit, p) {
    const rand = rng(hit.length * 17 + 3);
    this.group = new THREE.Group();
    const sorted = [...hit].sort((a, b) => a.zone - b.zone || a.ta - b.ta);

    // debris: concrete and brick chunks, lit
    this.chunks = [];
    for (const b of sorted) {
      const spec = RUIN[b.zone];
      for (let k = 0; k < spec.chunks && this.chunks.length < MAX_CHUNKS; k++) {
        const v = spec.v[0] + rand() * (spec.v[1] - spec.v[0]);
        const up = 0.25 + rand() * 0.6, side = (rand() - 0.5) * 0.9;
        const size = Math.max(0.5, Math.min(7, b.size * (0.07 + rand() * 0.12)));
        const y0 = b.h * (0.25 + rand() * 0.75);
        const vx = (b.dx - b.dz * side) * v, vz = (b.dz + b.dx * side) * v, vy = up * v;
        // when it lands: y0 + vy t - g/2 t² = size/2
        const tl = (vy + Math.sqrt(vy * vy + 2 * 9.81 * Math.max(0, y0 - size / 2))) / 9.81;
        this.chunks.push({
          x: b.x + (rand() - 0.5) * b.size * 0.6, z: b.z + (rand() - 0.5) * b.size * 0.6, y0, vx, vy, vz, tl, size,
          t0: b.ta + rand() * 0.25, spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(8),
          sx: 0.6 + rand() * 0.8, sz: 0.6 + rand() * 0.8,
          c: rand() < 0.3 ? [0.55, 0.36, 0.28] : rand() < 0.5 ? [0.62, 0.6, 0.57] : [0.45, 0.43, 0.41],
        });
      }
    }
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, this.chunks.length));
    this.mesh.frustumCulled = false;
    this.mesh.count = this.chunks.length;
    const col = new THREE.Color();
    this.chunks.forEach((c, i) => this.mesh.setColorAt(i, col.setRGB(...c.c)));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.group.add(this.mesh, new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.8);
    sun.position.set(0.4, 1, 0.3);
    this.group.add(sun);

    // a dust cloud bursting out of every building that comes down
    const falling = sorted.filter((b) => b.zone <= 1).slice(0, 700);
    this.puffs = [];
    for (const b of falling) for (let k = 0; k < 3; k++)
      this.puffs.push({ b, ox: (rand() - 0.5) * b.size, oz: (rand() - 0.5) * b.size, s: 0.7 + rand() * 0.7, k: rand() });
    this.dust = new Particles(this.puffs.length);

    // fires burning in the rubble
    const sites = sorted.filter((b) => rand() < RUIN[b.zone].fire * (p.nuclear ? 1.3 : 1)).slice(0, MAX_FIRES);
    this.flames = []; this.smokes = [];
    for (const b of sites) {
      const fh = Math.max(3, Math.min(30, b.size * 0.7));
      const base = b.zone === 0 ? Math.max(1.5, b.h * 0.06) : b.h * 0.45;
      for (let k = 0; k < 9; k++)
        this.flames.push({ b, fh, base, ox: (rand() - 0.5) * b.size * 0.6, oz: (rand() - 0.5) * b.size * 0.6, k: rand(), r: 0.8 + rand() * 0.6 });
      for (let k = 0; k < 7; k++)
        this.smokes.push({ b, fh, base, ox: (rand() - 0.5) * b.size * 0.4, oz: (rand() - 0.5) * b.size * 0.4, k: rand(), r: 0.8 + rand() * 0.6 });
    }
    this.fire = new Particles(this.flames.length, true);
    this.fireSmoke = new Particles(this.smokes.length);
    this.parts = [this.dust, this.fireSmoke, this.fire].filter((x) => x.n);
    for (const x of this.parts) this.group.add(x.obj);
    this.dummy = new THREE.Object3D();
  }

  update(a, px) {
    for (const x of this.parts) x.mat.uniforms.uPx.value = px;
    const d = this.dummy;
    this.chunks.forEach((c, i) => {
      const t = a - c.t0;
      if (t < 0) { d.scale.setScalar(0); d.position.set(0, -1e4, 0); }
      else {
        const tt = Math.min(t, c.tl);
        d.position.set(c.x + c.vx * tt, Math.max(c.size / 2, c.y0 + c.vy * tt - 4.9 * tt * tt), c.z + c.vz * tt);
        d.rotation.set(c.spin.x * tt, c.spin.y * tt, c.spin.z * tt);
        d.scale.set(c.size * c.sx, c.size * 0.7, c.size * c.sz);
      }
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;

    this.puffs.forEach((q, i) => {
      const t = a - q.b.ta - 0.1;
      if (t < 0) return this.dust.set(i, 0, 0, 0, 0, 0, 0, 0, 0);
      const k = 1 - Math.exp(-t / 1.6);
      this.dust.set(i, q.b.x + q.ox * (1 + k), q.b.h * (0.15 + 0.5 * k * q.k), q.b.z + q.oz * (1 + k),
        q.b.size * (0.6 + 1.4 * k) * q.s, 0.5 * Math.min(1, t * 4) * (1 - smooth(4, 12, t)), 0.62, 0.57, 0.5);
    });

    const life = 1 - smooth(END_ANIM_S - 9, END_ANIM_S - 1, a);
    this.flames.forEach((f, i) => {
      const on = smooth(f.b.ta + 0.6, f.b.ta + 1.8, a) * life;
      const l = (a * 1.1 * f.r + f.k) % 1;
      const flick = 0.75 + 0.25 * Math.sin(a * 23 + f.k * 50);
      this.fire.set(i, f.b.x + f.ox * (1 - l * 0.5), f.base + l * f.fh, f.b.z + f.oz * (1 - l * 0.5),
        f.fh * 0.55 * (1 - l * 0.6), on * (1 - l) * 0.9 * flick, 1, 0.45 + 0.4 * (1 - l), 0.12);
    });
    this.smokes.forEach((sm, i) => {
      const on = smooth(sm.b.ta + 1, sm.b.ta + 3, a) * life;
      const l = (a * 0.11 * sm.r + sm.k) % 1;
      this.fireSmoke.set(i, sm.b.x + sm.ox + l * sm.fh * 1.5, sm.base + sm.fh * (0.6 + l * 7), sm.b.z + sm.oz,
        sm.fh * (0.6 + 2.2 * l), on * 0.45 * (1 - l) * smooth(0, 0.1, l), 0.24, 0.22, 0.21);
    });
    for (const x of this.parts) x.commit();
  }

  dispose() {
    this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose();
    for (const x of this.parts) x.dispose();
  }
}

// ---------- the 3D view ----------
let map, renderer, camera, blast = null, sim = null, buildSrc = null;
let poiLayers = []; // the map's own place labels and icons, with their original filters
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

const EMPTY = { type: "FeatureCollection", features: [] };
const HEIGHT = ["coalesce", ["get", "render_height"], ["get", "height"], 8];
const buildingColor = (h) => ["interpolate", ["linear"], h, 0, "#dcd8d2", 60, "#c9cdd1", 200, "#b6bec6"];

function addLayers() {
  const layers = map.getStyle().layers;
  const firstSymbol = layers.find((l) => l.type === "symbol")?.id;
  const bl = layers.filter((l) => l["source-layer"] === "building");
  poiLayers = layers.filter((l) => l.type === "symbol" && l["source-layer"] === "poi").map((l) => ({ id: l.id, filter: l.filter }));
  const extrusion = (id, source, extra) => ({
    id, type: "fill-extrusion", source, ...extra,
    paint: { "fill-extrusion-color": buildingColor(extra["source-layer"] ? HEIGHT : ["get", "h"]),
      "fill-extrusion-height": extra["source-layer"] ? HEIGHT : ["get", "h"],
      "fill-extrusion-base": extra["source-layer"] ? ["coalesce", ["get", "render_min_height"], 0] : ["get", "b"],
      "fill-extrusion-opacity": 0.92 },
  });
  for (const id of ["bm-zones", "bm-city", "bm-damage", "bm-places"]) map.addSource(id, { type: "geojson", data: EMPTY });
  if (bl.length) {
    buildSrc = bl[0].source;
    bl.forEach((l) => map.setLayoutProperty(l.id, "visibility", "none"));
    // the map's own buildings, shown while nothing has been blown up
    map.addLayer(extrusion("bm-buildings", buildSrc, { "source-layer": "building", minzoom: 12 }), firstSymbol);
  }
  map.addLayer({ id: "bm-zones-fill", type: "fill", source: "bm-zones", filter: ["!=", ["get", "key"], "spread"],
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0 } }, firstSymbol);
  map.addLayer({ id: "bm-zones-line", type: "line", source: "bm-zones",
    paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "outer"], 2.2, 1.4], "line-opacity": 0 } }, firstSymbol);
  map.addLayer({ id: "bm-spread", type: "line", source: "bm-zones", filter: ["==", ["get", "key"], "spread"],
    paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-dasharray": [3, 3] } }, firstSymbol);
  // during a blast the buildings come from our own copy: the untouched ones here,
  // the ones the blast reaches in bm-damage, where they collapse
  map.addLayer({ ...extrusion("bm-city", "bm-city", {}), layout: { visibility: "none" } }, firstSymbol);
  map.addLayer({
    id: "bm-damage", type: "fill-extrusion", source: "bm-damage",
    paint: { "fill-extrusion-color": ["get", "c0"], "fill-extrusion-height": ["get", "h"],
      "fill-extrusion-base": ["get", "b"], "fill-extrusion-opacity": 0.96 },
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
      const a = reduceMotion ? END_ANIM_S : (performance.now() - sim.start) / 1000;
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
      const c = canvasSize();
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
  map.addLayer({ id: "bm-places", type: "circle", source: "bm-places",
    paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2, "circle-opacity": 0, "circle-stroke-opacity": 0 } });
  map.on("moveend", onMoveEnd);
}
const canvasSize = () => { const cv = map.getCanvas(); return [cv.clientWidth, cv.clientHeight]; };

function useOwnBuildings(on) {
  if (map.getLayer("bm-buildings")) map.setLayoutProperty("bm-buildings", "visibility", on ? "none" : "visible");
  map.setLayoutProperty("bm-city", "visibility", on ? "visible" : "none");
}

// ---------- per-frame map updates (zones, collapsing buildings, light) ----------
let lastMapTick = -1;
function tickMap(a, tr) {
  if (!sim) return;
  updateClock(tr);
  // the sun briefly takes the fireball's colour
  const glow = reduceMotion ? 0 : Math.exp(-a / (sim.p.nuclear ? 2.5 : 0.6));
  if (glow > 0.01 || !sim.lightReset) {
    map.setLight({ anchor: "viewport", color: glow > 0.01 ? `rgb(255,${Math.round(255 - 70 * glow)},${Math.round(255 - 150 * glow)})` : "#ffffff",
      intensity: 0.5 + 0.4 * glow });
    sim.lightReset = glow <= 0.01;
  }
  // buildings are still falling until ~3 s after the front passes; after that, stop updating
  const busy = a < SHOCK_ANIM_S + 4;
  if (!busy && sim.settled) return;
  const every = sim.hitCount > 1500 ? 66 : 0;
  if (performance.now() - lastMapTick < every && busy) return;
  lastMapTick = performance.now();
  sim.settled = !busy;
  const A = a;
  // labels of places inside the heavy-damage zone go once the front has passed it
  if (!sim.poiGone && sim.poiArea && A >= sim.poiArea.ta) {
    sim.poiGone = true;
    for (const l of poiLayers) {
      const out = ["!", ["within", sim.poiArea.geom]];
      map.setFilter(l.id, l.filter ? ["all", l.filter, out] : out);
    }
  }
  const shown = ["<=", ["get", "ta"], A];
  map.setPaintProperty("bm-zones-fill", "fill-opacity", ["case", shown, 0.1, 0]);
  map.setPaintProperty("bm-zones-line", "line-opacity", ["case", shown, 0.9, 0]);
  map.setPaintProperty("bm-places", "circle-opacity", ["case", shown, 1, 0]);
  map.setPaintProperty("bm-places", "circle-stroke-opacity", ["case", shown, 1, 0]);
  const prog = ["min", 1, ["max", 0, ["/", ["-", A, ["get", "ta"]], ["get", "dur"]]]];
  const ease = ["*", prog, prog]; // falls faster as it goes
  map.setPaintProperty("bm-damage", "fill-extrusion-height",
    ["-", ["get", "h"], ["*", ["-", ["get", "h"], ["get", "hf"]], ease]]);
  map.setPaintProperty("bm-damage", "fill-extrusion-base",
    ["-", ["get", "b"], ["*", ["-", ["get", "b"], ["get", "bf"]], ease]]);
  map.setPaintProperty("bm-damage", "fill-extrusion-color",
    ["interpolate", ["linear"], prog, 0, ["to-color", ["get", "c0"]], 1, ["to-color", ["get", "c1"]]]);
}

function fmtSec(s) {
  const n = (v, d) => Number(v).toLocaleString("fa-IR", { maximumFractionDigits: d });
  return s < 1 ? `${n(s * 1000, 0)} میلی‌ثانیه` : `${n(s, 2)} ثانیه`;
}
function updateClock(tr) {
  const p = sim.p;
  el("simClock").textContent = tr < p.Tend ? `زمان واقعی: ${fmtSec(tr)}` : `موج در ${fmtSec(p.Tend)} به لبه‌ی آسیب سبک رسید`;
}

// ---------- what the blast hits ----------
const ZONE_FA = ["تخریب کامل", "آسیب سنگین", "آسیب متوسط", "آسیب سبک"];
const ZONE_COLOR = ["#b91c1c", "#ea580c", "#f59e0b", "#facc15"];
// per zone: final colour, how much of the building is left standing, how long it takes to fall (anim s)
const LOOK = [
  { c1: "#4a3d36", keep: 0.05, dur: 1.6 }, // rubble
  { c1: "#7d5a49", keep: 0.45, dur: 2.0 }, // upper floors gone
  { c1: "#b49278", keep: 0.88, dur: 0.8 }, // roof and facades torn off
  { c1: "#e0d4bc", keep: 1, dur: 0.5 }, // windows blown in
];
function hexLerp(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
const intactColor = (h) => h <= 60 ? hexLerp("#dcd8d2", "#c9cdd1", h / 60) : hexLerp("#c9cdd1", "#b6bec6", Math.min(1, (h - 60) / 140));

// zone index and arrival (anim s) of the first front to reach a spot x, z (metres from ground zero)
function reach(p, x, z) {
  let zone = -1, ta = Infinity;
  const test = (dx, dz, t0, radii, w) => {
    const d = Math.hypot(dx, dz);
    const zi = radii.findIndex((r) => d <= r);
    if (zi < 0) return;
    const ti = (t0 + arrival(d, w, p.f)) * p.speed;
    if (zone < 0 || zi < zone || (zi === zone && ti < ta)) { zone = zi; ta = ti; }
  };
  if (p.cluster) p.spots.forEach((s, i) => test(x - s[0], z + s[1], p.stagger[i], p.subRadii, p.w));
  else test(x, z, 0, p.R, p.w);
  return [zone, ta];
}

function collect(p, center) {
  const city = [], damage = [], hit = [], counted = [new Set(), new Set(), new Set(), new Set()];
  if (!buildSrc) return { city, damage, hit, counts: [0, 0, 0, 0], places: [] };
  const cosLat = Math.cos((center[0] * Math.PI) / 180);
  const toXZ = (lng, lat) => [(lng - center[1]) * M_PER_DEG * cosLat, -(lat - center[0]) * M_PER_DEG];
  const seen = new Set();
  for (const f of map.querySourceFeatures(buildSrc, { sourceLayer: "building" })) {
    const g = f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
    const h = +(f.properties.render_height ?? f.properties.height ?? 8);
    const b = +(f.properties.render_min_height ?? 0);
    const key = `${ring.length}:${ring[0][0].toFixed(7)},${ring[0][1].toFixed(7)}:${h}`;
    if (seen.has(key)) continue; // the same piece repeated in a neighbouring tile's buffer
    seen.add(key);
    let sx = 0, sz = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const c of ring) {
      const [x, z] = toXZ(c[0], c[1]);
      sx += x; sz += z; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const x = sx / ring.length, z = sz / ring.length;
    const [zone, ta] = reach(p, x, z);
    if (zone < 0) { city.push({ type: "Feature", geometry: g, properties: { h, b } }); continue; }
    const look = LOOK[zone], jitter = 0.8 + 0.4 * ((Math.abs(x * 13.7 + z * 7.3) % 1));
    const bf = zone === 0 ? 0 : b * look.keep;
    const hf = zone === 0 ? Math.max(1.2, h * look.keep) : bf + (h - b) * look.keep;
    damage.push({ type: "Feature", geometry: g, properties: {
      h, b, hf, bf, ta, dur: look.dur * jitter, c0: intactColor(h),
      c1: zone === 0 && p.nuclear ? "#2f2723" : look.c1 } });
    const r = Math.hypot(x, z) || 1;
    hit.push({ x, z, h, size: Math.max(4, x1 - x0, z1 - z0), zone, ta, dx: x / r, dz: z / r });
    counted[zone].add(`${Math.round(x / 4)},${Math.round(z / 4)}`);
  }

  // named places from the map's points of interest
  const places = [], seenPlace = new Set();
  for (const f of map.querySourceFeatures(buildSrc, { sourceLayer: "poi" })) {
    if (f.geometry?.type !== "Point") continue;
    const pr = f.properties, name = pr["name:fa"] || pr.name || pr["name:latin"];
    if (!name) continue;
    const [lng, lat] = f.geometry.coordinates;
    const [x, z] = toXZ(lng, lat);
    const [zone, ta] = reach(p, x, z);
    if (zone < 0) continue;
    const k = name + "|" + pr.class;
    if (seenPlace.has(k)) continue;
    seenPlace.add(k);
    places.push({ name, cls: pr.class, sub: pr.subclass, zone, ta, lng, lat });
  }
  return { city, damage, hit, counts: counted.map((c) => c.size), places };
}

// ---------- damage report in the panel ----------
const PLACE_FA = {
  hospital: "بیمارستان", school: "مدرسه", college: "دانشگاه", kindergarten: "مهدکودک", place_of_worship: "عبادتگاه",
  fire_station: "آتش‌نشانی", police: "پلیس", fuel: "پمپ بنزین", bank: "بانک", pharmacy: "داروخانه",
  library: "کتابخانه", town_hall: "ساختمان دولتی", shop: "فروشگاه", grocery: "فروشگاه", restaurant: "رستوران",
  cafe: "کافه", fast_food: "رستوران", lodging: "هتل", park: "پارک", attraction: "جاذبه", museum: "موزه",
  stadium: "ورزشگاه", bus: "ایستگاه اتوبوس", railway: "ایستگاه", parking: "پارکینگ", cinema: "سینما",
};
const PLACE_RANK = ["hospital", "school", "kindergarten", "college", "fire_station", "police", "place_of_worship", "fuel", "pharmacy"];
const rank = (c) => { const i = PLACE_RANK.indexOf(c); return i < 0 ? 99 : i; };

function report(counts, places) {
  const box = el("damage3d");
  if (!box) return;
  const fa = (n) => Number(n).toLocaleString("fa-IR");
  const stats = el("damageStats");
  stats.replaceChildren();
  counts.forEach((n, i) => {
    const row = document.createElement("div");
    row.className = "dmg-row";
    const dot = document.createElement("i");
    dot.style.background = ZONE_COLOR[i];
    const name = document.createElement("span");
    name.textContent = ZONE_FA[i];
    const val = document.createElement("b");
    val.textContent = n ? fa(n) : "—";
    row.append(dot, name, val);
    stats.appendChild(row);
  });
  const list = el("damagePlaces");
  list.replaceChildren();
  const top = [...places].sort((a, b) => a.zone - b.zone || rank(a.cls) - rank(b.cls)).slice(0, 12);
  for (const pl of top) {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.style.background = ZONE_COLOR[pl.zone];
    const name = document.createElement("span");
    name.textContent = pl.name;
    const kind = document.createElement("small");
    kind.textContent = [PLACE_FA[pl.cls] || PLACE_FA[pl.sub], ZONE_FA[pl.zone]].filter(Boolean).join(" · ");
    li.append(dot, name, kind);
    li.addEventListener("click", () => map.easeTo({ center: [pl.lng, pl.lat], zoom: Math.max(map.getZoom(), 16.5) }));
    list.appendChild(li);
  }
  el("damagePlacesTitle").hidden = !top.length;
  el("damageZoomHint").hidden = map.getZoom() >= BUILDING_ZOOM;
  el("damagePlacesTitle").textContent = places.length > top.length
    ? `اماکن نام‌دار در محدوده (${fa(top.length)} از ${fa(places.length)})` : "اماکن نام‌دار در محدوده";
  box.hidden = false;
}

function applyCollected(p, point, { fresh }) {
  const c = collect(p, point);
  map.getSource("bm-city").setData({ type: "FeatureCollection", features: c.city });
  map.getSource("bm-damage").setData({ type: "FeatureCollection", features: c.damage });
  map.getSource("bm-places").setData({ type: "FeatureCollection", features: c.places.map((pl) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [pl.lng, pl.lat] },
    properties: { color: ZONE_COLOR[pl.zone], ta: pl.ta } })) });
  useOwnBuildings(true);
  blast.setRuins(new Ruins(c.hit, p));
  sim.hitCount = c.hit.length;
  sim.settled = false; lastMapTick = -1;
  report(c.counts, c.places);
  if (!fresh) map.triggerRepaint();
}

// the user moved the map: newly loaded tiles may hold more of the damaged area
let moveTimer;
function onMoveEnd() {
  if (!sim?.ready) return;
  clearTimeout(moveTimer);
  const id = runId;
  moveTimer = setTimeout(async () => {
    await waitIdle(3000);
    if (id === runId && sim?.ready) applyCollected(sim.p, sim.point, { fresh: false });
  }, 400);
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
      properties: { color: z.color, key: z.key, outer: false, ta: (p.stagger[i] + arrival(z.radius_m, p.w, p.f)) * p.speed },
    })));
  }
  [...main].reverse().forEach((z, i) => feats.push({
    type: "Feature", geometry: { type: "Polygon", coordinates: [circle(point, z.radius_m)] },
    properties: { color: z.color, key: z.key, outer: i === 0, ta: arrival(z.radius_m, p.w, p.f) * p.speed },
  }));
  const sp = zones.find((z) => z.key === "spread");
  if (sp) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [circle(point, sp.radius_m)] },
    properties: { color: sp.color, key: "spread", outer: true, ta: 0 } });
  return { type: "FeatureCollection", features: feats };
}

function frame(point, p) {
  const viewR = Math.max(p.Rlight * 1.25, p.Hc * 0.75, 60);
  const [w, h] = canvasSize();
  const mobile = window.innerWidth <= 720;
  const avail = mobile ? Math.min(w, h * 0.55) : Math.min(w - 400, h);
  const mpp = (viewR * 2) / Math.max(200, avail * 0.9);
  const zoom = Math.log2((40075016.686 * Math.cos((point[0] * Math.PI) / 180)) / (512 * mpp)) + 0.2;
  // buildings only exist in the map's tiles from zoom 13, so stay close enough to see them fall
  const minZoom = buildSrc ? BUILDING_ZOOM + 0.6 : 3;
  return {
    center: [point[1], point[0]], zoom: Math.max(minZoom, Math.min(18, zoom)), pitch: p.Hc ? 62 : 58,
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

function restorePoi() { for (const l of poiLayers) map.setFilter(l.id, l.filter ?? null); }

function reset() {
  runId++;
  restorePoi();
  blast?.dispose(); blast = null; sim = null;
  for (const id of ["bm-zones", "bm-city", "bm-damage", "bm-places"]) map.getSource(id).setData(EMPTY);
  useOwnBuildings(false);
  el("damage3d").hidden = true;
}

let runId = 0;
async function play(point, zones, tnt, burst, spots, { fly = true } = {}) {
  reset();
  const id = runId;
  const p = params(point, zones, tnt, burst, spots);
  map.getSource("bm-zones").setData(zoneFeatures(point, zones, p));
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

  blast = new Blast(p);
  sim = { p, point, start: performance.now(), lightReset: false, hitCount: 0, settled: false,
    merc: window.maplibregl.MercatorCoordinate.fromLngLat([point[1], point[0]], 0),
    poiArea: p.cluster ? null : { ta: arrival(p.R[1], p.w, p.f) * p.speed,
      geom: { type: "Polygon", coordinates: [circle(point, p.R[1])] } } };
  applyCollected(p, point, { fresh: true });
  sim.start = performance.now(); // collecting can take a moment on a dense city
  sim.ready = true;
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
  el("damage3d").hidden = true;
  const c = map?.getCenter();
  return c ? { center: [c.lat, c.lng], zoom: map.getZoom() + 1 } : null;
}

// called by app.js on every redraw; plays only while the 3D view is open
export function show(point, zones, tnt, burst, spots) {
  last = point ? [point, zones, tnt, burst, spots] : null;
  if (!map || !document.body.classList.contains("mode-3d")) return;
  if (!point) {
    reset();
    el("simBar").hidden = true;
    return;
  }
  play(...last);
}

export function replay() { if (last && map) play(...last, { fly: false }); }
