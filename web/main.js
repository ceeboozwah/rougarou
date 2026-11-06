// rougarou in the browser: walk the gym, pull onto a problem at its start holds, climb it, fall off it, get back up.
// for mouse, keyboard and touch. the climbing controls and camera are a port of unreal/Source/Rougarou/RougarouGame.cpp.

import * as THREE from 'three';
import { Sim, Vec2, Vec3, Names } from './sim.js';
import { problems, buildGym, routeHolds, toThree, Overview, Focus, tape } from './gym.js';
import { Figure } from './figure.js';
import { Agent } from './agent.js';
import { TheWall, DoorWay } from './thewall.js';
import { PoseEditor } from './poseeditor.js';
import { FormLab } from './formlab.js';
import { collectWall } from './wallpose.js';
import { BodyCheck } from './bodycheck.js';
import { bakeWall } from './wallbake.js';
import { loadHoldTextures, holdMaterial, screwMaterial, holeAttributes } from './holdtex.js';
import { gymEnvironment } from './envmap.js';
import { Prints, ChalkUp } from './chalking.js';
import { Brain, Memory } from './brain.js';
import { Climber, walkPose, blend, handOn, solve, awayFromWall } from './climber.js';
import { Ragdoll } from './ragdoll.js';
import { World, floorAt } from './world.js';
import { Audio } from './audio.js';
import { Recorder } from './recorder.js';
import { UI, clock } from './ui.js';
import { Editor } from './editor.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const three = (v) => new THREE.Vector3(...toThree(v));
const unreal = (t) => new Vec3(t.z * 100, -t.x * 100, t.y * 100);
const $ = (id) => document.getElementById(id);
const Z = new Vec3(0, 0, 1);
const ease = (t) => t * t * (3 - 2 * t);
const mid = (a, b) => a.add(b).mul(0.5);
// the shortest way round from angle A toward B, at most Step
const turn = (a, b, step) => { const gap = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + clamp(gap, -step, step); };

const routes = problems();
// the last problem is The Wall, the one with no top (thewall.js): it is a problem like the rest to the sim, the tags and the walk, and is left out of the lists, the editor and the AI
const theWall = new TheWall();
routes.push(theWall.route);
routes.forEach((r, i) => { r.tape = tape(i); });
// the problems as set, for the route editor's reset
const originals = problems();
originals.push(theWall.route);
const sim = new Sim(routes);
// ?route=n skips the walk and starts on that problem
const asked = parseInt(new URLSearchParams(location.search).get('route') ?? '', 10);
sim.route = Number.isFinite(asked) ? clamp(asked, 0, routes.length - 1) : 0;

// ---------------------------------------------------------------- the scene

const canvas = $('view');
const touchy = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, touchy ? 2 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15151a);
scene.add(theWall.group);
// fog only matters in the wall's room, where the wall goes up out of sight; elsewhere it is far beyond the walls
scene.fog = new THREE.Fog(0x15151a, 6000, 9000);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
// saved route sets are loaded before anything is built from the holds
const editor = new Editor(scene, routes, originals, { cursor: (x, y) => cursor(x, y), screenOf: (p) => screenOf(p), rebuild: (i) => rebuild(i), toast: (t, k) => ui.toast(t, k) });
sim.restart();

// reflections: the gym's own lights, windows and walls, filtered, so the satin resin holds and the skin catch them
scene.environment = gymEnvironment(renderer);
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xfff3e2, 0x2a241e, 0.55));
// one key light from over the camera's shoulder so hold shadows fall short and soft onto the wall; it follows the climber
const key = new THREE.DirectionalLight(0xffffff, 2.3);
key.castShadow = true;
key.shadow.mapSize.set(touchy ? 1024 : 2048, touchy ? 1024 : 2048);
Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 40 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const keyDirection = new THREE.Vector3(0.27, -0.616, -0.74).normalize();
// the gym's ceiling lights, as one more shadow caster from almost straight above: every hold throws a short shadow down the wall under it
const ceiling = new THREE.DirectionalLight(0xfff6ea, 1.5);
ceiling.castShadow = true;
ceiling.shadow.mapSize.set(touchy ? 1024 : 2048, touchy ? 1024 : 2048);
Object.assign(ceiling.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 40 });
ceiling.shadow.bias = -0.0004;
ceiling.shadow.normalBias = 0.02;
scene.add(ceiling, ceiling.target);
const ceilingDirection = new THREE.Vector3(-0.12, -0.95, -0.28).normalize();
const fill = new THREE.PointLight(0xffffff, 1.4, 22, 1);
fill.position.copy(three(new Vec3(420, -150, 260)));
scene.add(fill);

loadHoldTextures();
const gym = buildGym(routes);
const soup = (sink, color, roughness = 0.82, resin = false) => {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(sink.positions, 3));
	geometry.setAttribute('normal', new THREE.Float32BufferAttribute(sink.normals, 3));
	let material;
	if (resin) { material = holdMaterial(color, roughness); holeAttributes(geometry, sink); }
	else { material = new THREE.MeshStandardMaterial({ roughness, metalness: 0 }); material.color.setRGB(...color); }
	const mesh = new THREE.Mesh(geometry, material);
	mesh.receiveShadow = true;
	scene.add(mesh);
	return mesh;
};
// pale birch plywood and charcoal panels, holds in satin resin
// the panels are one-sided sheets: they cast shadows from both faces, or the lights would shine straight through them onto the floor behind
for (const mesh of [soup(gym.boards[0], [0.84, 0.68, 0.47]), soup(gym.boards[1], [0.055, 0.055, 0.06], 0.9)]) { mesh.castShadow = true; mesh.material.shadowSide = THREE.DoubleSide; }
gym.paint.forEach((sink, i) => { soup(sink, gym.palette[i], 0.5, true).castShadow = true; });
// the bolt holes, one instanced batch
{
	const hole = new THREE.CylinderGeometry(0.0075, 0.0075, 0.002, 7);
	const mesh = new THREE.InstancedMesh(hole, new THREE.MeshBasicMaterial({ color: 0x14110d }), gym.holes.length);
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
	gym.holes.forEach((h, i) => {
		q.setFromUnitVectors(up, three(h.normal.mul(100)).normalize());
		mesh.setMatrixAt(i, m.compose(three(h.at), q, one));
	});
	scene.add(mesh);
}
soup(gym.shadow, [0.01, 0.01, 0.01]);
// the screws in the gym's decorative holds: steel, one mesh
{
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(gym.steel.positions, 3));
	geometry.setAttribute('normal', new THREE.Float32BufferAttribute(gym.steel.normals, 3));
	const screws = new THREE.Mesh(geometry, screwMaterial());
	screws.castShadow = screws.receiveShadow = true;
	scene.add(screws);
}
// each problem's holds are their own meshes, rebuilt when the route setter moves one
const sets = routes.map(() => {
	const group = new THREE.Group();
	scene.add(group);
	return group;
});
function rebuild(index) {
	if (routes[index].endless) { if (spots) { spots[index] = world.startSpot(routes[index]); tags[index].position.copy(three(spots[index].at.add(Z.mul(255)))); } return; }
	const group = sets[index];
	for (const mesh of [...group.children]) { mesh.geometry.dispose(); mesh.material.dispose(); group.remove(mesh); }
	const built = routeHolds(routes[index], index);
	const mesh = (sink, color, roughness, resin = false, metal = false) => {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(sink.positions, 3));
		geometry.setAttribute('normal', new THREE.Float32BufferAttribute(sink.normals, 3));
		if (resin) holeAttributes(geometry, sink);
		const m = new THREE.Mesh(geometry, metal ? screwMaterial() : resin ? holdMaterial(color, roughness) : new THREE.MeshStandardMaterial({ roughness, metalness: 0 }));
		if (!resin && !metal) m.material.color.setRGB(...color);
		m.castShadow = m.receiveShadow = true;
		group.add(m);
	};
	mesh(built.body, built.color, 0.5, true);
	mesh(built.dark, [0.01, 0.01, 0.01], 0.8);
	if (built.steel.positions.length) mesh(built.steel, [1, 1, 1], 0.4, false, true);
	if (spots) {
		spots[index] = world.startSpot(routes[index]);
		tags[index].position.copy(three(spots[index].at.add(Z.mul(255))));
	}
}
// the blockout: one instanced box batch per color
{
	const batches = new Map();
	for (const b of gym.blocks) {
		const k = b.color.join(',') + b.shadows;
		if (!batches.has(k)) batches.set(k, []);
		batches.get(k).push(b);
	}
	const box = new THREE.BoxGeometry(1, 1, 1);
	const m = new THREE.Matrix4(), q = new THREE.Quaternion();
	for (const list of batches.values()) {
		const material = new THREE.MeshStandardMaterial({ roughness: 0.9 });
		material.color.setRGB(...list[0].color);
		if (list[0].color[0] > 0.95) material.emissive.setRGB(1, 1, 1);
		const mesh = new THREE.InstancedMesh(box, material, list.length);
		list.forEach((b, i) => mesh.setMatrixAt(i, m.compose(three(b.center), q, new THREE.Vector3(b.size.y / 100, b.size.z / 100, b.size.x / 100))));
		mesh.receiveShadow = true;
		mesh.castShadow = list[0].shadows;
		scene.add(mesh);
	}
}
for (const l of gym.lights) {
	const light = new THREE.PointLight(new THREE.Color().setRGB(...l.color), l.intensity * 0.35, l.range, 1);
	light.position.copy(three(l.at));
	scene.add(light);
}

const climber = new Climber(scene);
// the form lab (F6): an AI that trains on realistic joint bending and learns limits
const formLab = new FormLab({ scene, prepare: async (y) => { while (theWall.ready < Math.floor(y / 10) + 3) { await theWall.ensure(y); await new Promise(r => setTimeout(r, 50)); } }, toast: (t, k) => ui.toast(t, k), collect: async (chunks, progress) => { bodyCheck.wall = true; try { return await collectWall(theWall, { chunks, progress, gate: bodyCheck.gate }); } finally { bodyCheck.wall = false; } }, onApply: (set, mix) => { for (const model of [climber.model, agent?.climber?.model]) { model?.setLimits(set); model?.setMix(mix); } } });

// the pose restriction editor (F3): joint limits for the characters, kept in limits.json and enforced on every skeleton
const poseEd = new PoseEditor({ renderer, canvas, toast: (t, k) => ui.toast(t, k), onSaved: (set) => { climber.model?.setLimits(set); agent?.climber?.model?.setLimits(set); }, seen: () => climber.model?.seen });
// the skinned character takes over from the tubes once it has loaded; ?tubes keeps the tubes, and so does a failed load
if (!new URLSearchParams(location.search).has('tubes'))
	Figure.load('./assets/character/climber.glb').then(f => { climber.wear(f); climber.model.root.visible = true; }).catch(e => console.warn('the character did not load, keeping the tubes', e));

const world = new World(gym.blocks);
const door = new DoorWay(scene, world);
// a light that follows the climber up The Wall, so it is lit at any height
const wallLight = new THREE.PointLight(0xfff3e2, 6, 16, 1.2);
wallLight.visible = false;
scene.add(wallLight);
let spots = null;
routes.forEach((_, i) => rebuild(i));
// where to stand under each problem's start holds
spots = routes.map(r => world.startSpot(r));

// a grade tag over every problem, the way a gym tapes its starts
const papers = [];
const paintTag = (route, index) => {
	const paper = papers[index];
	const g = paper.getContext('2d');
	g.clearRect(0, 0, 512, 200);
	g.fillStyle = 'rgba(16, 16, 20, 0.84)';
	g.beginPath();
	g.roundRect(0, 0, 512, 200, 36);
	g.fill();
	g.fillStyle = `rgb(${tape(index).map(c => Math.round(c * 255)).join(',')})`;
	g.beginPath();
	g.roundRect(20, 20, 26, 160, 13);
	g.fill();
	g.fillStyle = '#f3efe6';
	g.font = '800 104px ui-rounded, system-ui, sans-serif';
	g.fillText(route.grade, 72, 112);
	g.fillStyle = 'rgba(243, 239, 230, 0.72)';
	g.font = '700 46px ui-rounded, system-ui, sans-serif';
	g.fillText(route.name, 74, 168);
};
const tags = routes.map((route, index) => {
	const paper = document.createElement('canvas');
	paper.width = 512;
	paper.height = 200;
	papers[index] = paper;
	paintTag(route, index);
	const map = new THREE.CanvasTexture(paper);
	map.colorSpace = THREE.SRGBColorSpace;
	map.userData.paper = true;
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true }));
	sprite.scale.set(0.82, 0.32, 1);
	sprite.position.copy(three(spots[index].at.add(Z.mul(255))));
	scene.add(sprite);
	return sprite;
});
// a renamed or regraded problem repaints its sign
const retag = (index) => { paintTag(routes[index], index); tags[index].material.map.needsUpdate = true; };
// the second climber, an AI (settings -> ai climber); it needs the spots and the world, so it is made here
let agent = null;
const watching = { on: false };
// what the human does is watched for the AI to learn from: a start, each hold a limb goes to, and how it ends (see Agent.watchStart)
{
	agent = new Agent({ scene, routes, spots, world, brain: new Brain(), memory: new Memory(),
		hooks: { rebuild: (i) => rebuild(i), commit: (i, meta) => editor.commitRoute(i, meta), retag: (i) => retag(i), decor: () => gym.decorHolds, puff: (at) => chalk.puff(at, 10),
		print: (route, number, side, level) => prints.add(route, holdIndexOf(route, number), number, side, level), dust: (at, n) => chalk.dust(at, n) } });
	const grab = sim.grab.bind(sim);
	sim.grab = (limb, hold) => { const ok = grab(limb, hold); if (ok && mode === 'climb') agent.watchMove(limb, hold); return ok; };
}
// the skeleton judges every move (bodycheck.js): the player's sim, Tuck's and every copy made for a rehearsal refuse a hold the joints cannot reach or that would put a knee or elbow into the wall
const bodyCheck = new BodyCheck();
theWall.bakedReady.then(() => { bodyCheck.bakedTop = theWall.baked ? theWall.baked.holds.length * 10 - 6 : 0; });
bodyCheck.load().then(() => { sim.gate = bodyCheck.gate; agent.sim.gate = bodyCheck.gate; }).catch(() => { /* without the skeleton the sim's own rules stand */ });
// rings that pulse on the start holds of the problem in front of you
const rings = [0, 1].map(() => {
	const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.009, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffe640, transparent: true, opacity: 0.85 }));
	scene.add(ring);
	return ring;
});

// chalk: little white puffs where a hand slaps a hold, and a burst of colored chalk for a send
const chalk = (() => {
	const paper = document.createElement('canvas');
	paper.width = paper.height = 64;
	const g = paper.getContext('2d');
	const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	glow.addColorStop(0, 'rgba(255,255,255,0.9)');
	glow.addColorStop(1, 'rgba(255,255,255,0)');
	g.fillStyle = glow;
	g.fillRect(0, 0, 64, 64);
	const map = new THREE.CanvasTexture(paper);
	const pool = Array.from({ length: 90 }, () => {
		const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, opacity: 0 }));
		sprite.visible = false;
		scene.add(sprite);
		return { sprite, life: 0, age: 0, v: new Vec3(), at: new Vec3(), size: 0 };
	});
	let next = 0;
	return {
		puff(at, count = 9, colors = null, speed = 40, size = 7) {
			for (let i = 0; i < count; i++) {
				const p = pool[next++ % pool.length];
				p.at = at;
				p.v = new Vec3(Math.random() - 0.5, Math.random() - 0.5, Math.random() * 0.8 + 0.1).norm().mul(speed * (0.4 + Math.random()));
				p.life = 0.7 + Math.random() * 0.6;
				p.age = 0;
				p.size = size * (0.6 + Math.random() * 0.8);
				p.sprite.material.color.set(colors ? colors[i % colors.length] : 0xffffff);
				p.g = 20;
				p.faint = 1;
				p.sprite.visible = true;
			}
		},
		// a subtle powder puff: slow, drifting up and out, settling softly, fainter than a slap on a hold
		dust(at, amount = 1) {
			for (let i = 0; i < Math.round(5 * amount); i++) {
				const p = pool[next++ % pool.length];
				p.at = at.add(new Vec3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0));
				p.v = new Vec3(Math.random() - 0.5, Math.random() - 0.5, 0.6 + Math.random() * 0.8).norm().mul(10 * (0.4 + Math.random()));
				p.life = 1.3 + Math.random() * 1.1;
				p.age = 0;
				p.size = 3.2 * (0.7 + Math.random() * 0.8);
				p.sprite.material.color.set(0xffffff);
				p.g = 1.5;
				p.faint = 0.55;
				p.sprite.visible = true;
			}
		},
		step(delta) {
			for (const p of pool) {
				if (!p.sprite.visible) continue;
				p.age += delta;
				if (p.age >= p.life) { p.sprite.visible = false; continue; }
				p.v = p.v.mul(1 / (1 + delta * 3)).add(new Vec3(0, 0, -(p.g ?? 20) * delta));
				p.at = p.at.add(p.v.mul(delta));
				const k = p.age / p.life;
				p.sprite.position.copy(three(p.at));
				p.sprite.scale.setScalar((p.size * (1 + k * 1.5)) / 100);
				p.sprite.material.opacity = 0.55 * (p.faint ?? 1) * (1 - k);
			}
		},
	};
})();

// the prints chalked hands leave on the holds
const prints = new Prints(scene);
// chalking up: the hand that is doing it, and the job (see chalking.js)
let chalkUp = null;
sim.sweat = true;
const holdIndexOf = (route, h) => route.holds[h]?.chunk ?? routes.indexOf(route);

// ---------------------------------------------------------------- sound, the menu, clips

const audio = new Audio();
const ui = new UI(routes, {
	play: () => { elapsed = 0; },
	poseEditor: () => { ui.close(); poseEd.open(); },
	formLab: () => { ui.close(); formLab.open(); },
	pause: () => { if (document.pointerLockElement) document.exitPointerLock(); },
	go: (index, pull) => goTo(index, pull),
	edit: (index) => editRoute(index),
	apply: (settings) => applySettings(settings),
	clips: (el) => recorder.gallery(el),
});
const recorder = new Recorder({ canvas, audio, hud: { toast: (t, k) => ui.toast(t, k), get mode() { return touchy ? 'touch' : 'kbm'; } },
	pause: () => ui.openMenu(), resume: () => ui.close() });
$('corner').prepend(recorder.recBtn);
function applySettings(s) {
	climber.setOutfit(s);
	if (agent) { agent.blind = s.aimode === 'blind'; agent.apprentice = s.aimode === 'watch'; agent.setting = s.aimode === 'set'; if (s.ai && !agent.on) agent.enable(); else if (!s.ai && agent.on) { agent.disable(); watching.on = false; } }
	audio.set(s.volume, s.muted);
	// fast trades shadow sharpness and resolution for frame rate; auto picks fast on a phone
	const fast = s.quality === 'low' || (s.quality === 'auto' && touchy);
	renderer.setPixelRatio(Math.min(devicePixelRatio, fast ? 1.5 : 2));
	const size = fast ? 1024 : 2048;
	for (const light of [key, ceiling]) if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null; }
	resize();
}

// ---------------------------------------------------------------- state

// walk the gym, mount a problem, climb, fall, rise off the mat, or hop down
let mode = Number.isFinite(asked) ? 'climb' : 'walk';
const walker = { at: new Vec3(450, 0, 28), yaw: Math.PI, heading: new Vec3(-1, 0, 0), phase: 0, speed: 0, amp: 0, near: -1,
	auto: null, autoTime: 0, want: [false, false], lift: [0, 0] };
let camYaw = Math.PI, camPitch = -0.3;
let pose = null, ragdoll = null, stages = null;
let note = '', noted = 0;
// the attempt clock: when this go on the problem started, and how long the send took
let started = 0, finished = 0;
// what the last frame saw, to hear and see catches, slips and landings
let latched = [1, 1, 1, 1], gripped = [0, 1, 2, 3], landed = false, stride = 0;

// ---------------------------------------------------------------- first person

// v puts the camera behind the climber's eyes. the view turns with the mouse in the wall's own frame (yaw across, pitch up),
// the hold under the crosshair glows, and a side key (r or l) then a limb key (a for arm, l for leg) sends that limb to it
const fp = { lean: new Vec2(), want: false, k: 0, yaw: 0, pitch: 0.2, F: null, U: null, eye: null, hold: -1, side: '', at: 0 };
const fpOn = () => fp.want && mode === 'climb';
const SIDE_WAIT = 1600;
const glow = (() => {
	const paper = document.createElement('canvas');
	paper.width = paper.height = 128;
	const g = paper.getContext('2d');
	const ring = g.createRadialGradient(64, 64, 8, 64, 64, 62);
	ring.addColorStop(0, 'rgba(255, 230, 64, 0.0)');
	ring.addColorStop(0.55, 'rgba(255, 230, 64, 0.1)');
	ring.addColorStop(0.78, 'rgba(255, 226, 90, 0.6)');
	ring.addColorStop(1, 'rgba(255, 230, 64, 0)');
	g.fillStyle = ring;
	g.fillRect(0, 0, 128, 128);
	const map = new THREE.CanvasTexture(paper);
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
	sprite.renderOrder = 10;
	sprite.visible = false;
	scene.add(sprite);
	return sprite;
})();

// b: watch the AI climber, or go back to the player
function toggleWatch() {
	if (!agent?.on) { ui.toast('turn the ai climber on in settings first', 'warn'); return; }
	watching.on = !watching.on;
	if (watching.on && fp.want) toggleFirstPerson();
	ui.toast(watching.on ? 'watching the ai: b to come back' : 'back on you', 'good');
}

function toggleFirstPerson() {
	if (!fp.want && mode !== 'climb') return;
	fp.want = !fp.want;
	fp.side = '';
	fp.lean = new Vec2();
	if (fp.want) {
		fp.yaw = 0;
		fp.pitch = 0.2;
		$('tip').classList.add('gone');
		canvas.requestPointerLock?.()?.catch?.(() => {});
		ui.toast('first person: look at a hold, then r or l and a (arm) or l (leg)', 'good');
	} else if (document.pointerLockElement) document.exitPointerLock();
}

// turn the first person view; the pitch stops short of straight up and down
function fpLook(dx, dy) {
	// the neck turns 80 degrees each way and the eyes and a twist of the body make up the rest
	fp.yaw = clamp(fp.yaw + dx, -2.4, 2.4);
	fp.pitch = clamp(fp.pitch - dy, -1.35, 1.2);
}

// the hold nearest the middle of the screen, as the closest to the line of sight in centimeters (relative to how big a target it is at that range)
function holdInSight() {
	const face = routes[sim.route];
	const eye = unreal(camera.position), dir = unreal(camera.getWorldDirection(new THREE.Vector3())).norm();
	let best = -1, score = 1;
	sim.holds().forEach((h, i) => {
		const v = face.map(h.point, 6).sub(eye), along = v.dot(dir);
		if (along < 20 || along > 400) return;
		const off = v.sub(dir.mul(along)).len() / Math.max(10, 0.08 * along);
		if (off < score) { score = off; best = i; }
	});
	return best;
}

// send a hand or foot to the hold in the crosshair
function sendLimb(l) {
	if (mode !== 'climb' || chalkUp) return;
	fp.side = '';
	if (fp.hold < 0) { ui.toast('look at a hold first', 'warn'); return; }
	limb = -1;
	if (!sim.grab(l, fp.hold)) ui.toast(sim.hint, 'warn');
}

// the two-key pick: r or l, then a (arm) or l (leg). true when the key belonged to it
function limbKey(k) {
	const now = performance.now();
	if (fp.side && now - fp.at > SIDE_WAIT) fp.side = '';
	if (k === 'r' || (k === 'l' && !fp.side)) { fp.side = k; fp.at = now; return true; }
	if (!fp.side || (k !== 'a' && k !== 'l')) { if (k !== 'shift') fp.side = ''; return false; }
	const right = fp.side === 'r';
	sendLimb(k === 'a' ? (right ? 2 : 3) : (right ? 0 : 1));
	return true;
}

// ---------------------------------------------------------------- controls

let limb = -1;
// where the lifted limb was, for putting it back
let previous = -1, pressed = false, post = new Vec2();
let aim = new Vec2();
const pointer = { x: 0, y: 0, inside: false, touch: false };
let drag = null, joystick = null, stick = null, looking = null;
const keys = new Set();
let wide = false, elapsed = 0;

function cursor(px, py) {
	// meet the problem's panels: the nearest one the ray hits within its stretch of the wall wins
	const rect = canvas.getBoundingClientRect();
	const ndc = new THREE.Vector2(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1);
	const ray = new THREE.Raycaster();
	ray.setFromCamera(ndc, camera);
	const origin = unreal(ray.ray.origin), direction = unreal(ray.ray.direction).norm();
	const face = routes[sim.route];
	let nearest = Infinity, out = null;
	// on a wall with no top only the panels around the climber are asked, and nothing is an edge
	const list = face.endless ? face.near(face.map(sim.position, 0)) : face.panels;
	list.forEach((panel, index) => {
		const facing = direction.dot(panel.out);
		if (Math.abs(facing) < 1e-4) return;
		const distance = panel.origin.sub(origin).dot(panel.out) / facing;
		if (distance <= 0 || distance >= nearest) return;
		const hit = origin.add(direction.mul(distance)).sub(panel.origin);
		const up = hit.dot(panel.up) / 100;
		if (!((!face.endless && index === 0) || up >= -0.05) || !((!face.endless && index + 1 === list.length) || up <= panel.length + 0.05)) return;
		nearest = distance;
		out = new Vec2(hit.dot(panel.right) / 100, panel.start + up);
	});
	return out;
}

function screenOf(point) {
	const v = three(routes[sim.route].map(point, 3)).project(camera);
	const rect = canvas.getBoundingClientRect();
	return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height, front: v.z < 1 };
}

// the hand or foot under the pointer, by screen distance so fingertips on a phone can find it
function pick(px, py) {
	let best = -1, closest = touchy ? 60 : 44;
	for (let i = 0; i < 4; i++) {
		const s = screenOf(sim.tips[i]);
		const gap = Math.hypot(s.x - px, s.y - py);
		if (s.front && gap < closest) { closest = gap; best = i; }
	}
	return best;
}

// chalk up: the hand with the least chalk, if the other hand and a foot can hold the body, lets go, reaches back to the bag, dips in and goes back to its hold
function startChalk() {
	if (mode !== 'climb' || chalkUp || sim.fallen) return;
	const ready = (l) => sim.grips[l] >= 0 && sim.arrived(l);
	const footing = [0, 1].some(f => (sim.grips[f] >= 0 || sim.smeared[f]) && sim.arrived(f));
	const hands = [2, 3].sort((a, b) => sim.chalk[a] - sim.chalk[b]);
	const hand = hands.find(h => ready(h === 2 ? 3 : 2) && (sim.grips[h] >= 0 || !sim.smeared[h]));
	if (hand === undefined || !footing) { ui.toast('chalk up with one hand while the other and a foot hold you', 'warn'); return; }
	if (limb >= 0) cancel();
	chalkUp = new ChalkUp(hand, sim.grips[hand]);
	sim.drop(hand);
	ui.toast(`${hand === 2 ? 'right' : 'left'} hand to the chalk bag`, 'good');
}
function endChalk() { chalkUp = null; climber.chalking = null; }

function lift(index) {
	if (chalkUp) return;
	// lifting a limb takes it off the wall: the other three carry the weight from this moment
	limb = index;
	previous = sim.grips[index];
	pressed = sim.smeared[index];
	post = sim.posts[index].copy();
	aim = sim.tips[index].copy();
	sim.drop(index);
}

function place() {
	// commit whatever is under the hand or foot; a bad hold or a bare-wall press is allowed and physics decides if it sticks
	// the hold under the pointer wins if the body can still get there by reaching; otherwise whatever the fingertips touch
	const nearest = (point) => {
		let found = -1, closest = 0.15;
		sim.holds().forEach((h, i) => { const gap = h.point.dist(point); if (gap < closest) { closest = gap; found = i; } });
		return found;
	};
	const wanted = nearest(sim.target), touched = nearest(aim);
	if (wanted >= 0 && sim.grab(limb, wanted)) { limb = -1; return; }
	if (touched < 0 || !sim.grab(limb, touched)) sim.smear(limb, aim);
	limb = -1;
}

function cancel() {
	// put the limb back where it was if the body can still get it there, otherwise it hangs
	if (limb < 0) return;
	if (previous >= 0) sim.grab(limb, previous);
	else if (pressed) sim.smear(limb, post);
	limb = -1;
}

function letGo() { limb = -1; }

// a fresh go at the current problem: the clock restarts and it counts as an attempt
function begin() {
	agent?.watchStart(sim.route);
	started = climber.clock;
	finished = 0;
	latched = [...sim.latch];
	gripped = [...sim.grips];
	ui.attempt(routes[sim.route]);
}

function sent() {
	agent?.watchEnd('sent');
	const route = routes[sim.route];
	finished = climber.clock - started;
	const was = ui.send(route, finished);
	$('sentRoute').textContent = `${route.name} · ${route.grade}`;
	$('sentLine').textContent = `in ${clock(finished)}`;
	const badges = [was.flash && 'flash', was.first && !was.flash && 'first send', was.best && 'new best'].filter(Boolean);
	$('sentBadges').innerHTML = badges.map(b => `<span>${b}</span>`).join('');
	$('sent').hidden = false;
	audio.fanfare(was.flash || was.best);
	const top = route.map(route.holds[route.holds.length - 1].point, 10);
	chalk.puff(top, 30, ['#f2a007', '#ffffff', `#${new THREE.Color().setRGB(...route.tape).getHexString()}`, '#8fd6a8'], 160, 9);
}

// straight to a problem: walk there, or walk there and pull on
function goTo(index, pull) {
	if (editor.active) finishEdit();
	sim.route = index;
	const spot = spots[index];
	stand(world.clear(pull ? spot.at : spot.at.add(spot.out.mul(130)), spot.out));
	stages = null;
	ragdoll = null;
	$('sent').hidden = true;
	toWalk();
	if (pull) { walker.near = index; walker.want = [true, true]; }
}

// the route setter: the climber steps back and the camera squares up to the wall
function editRoute(index) {
	goTo(index, false);
	mode = 'edit';
	editor.start(index);
	$('editbar').hidden = false;
	$('bar').hidden = true;
	$('tip').classList.add('gone');
	ui.toast('drag a hold to move it, turn it with the arrows', 'good');
}
function finishEdit() {
	const index = editor.index;
	editor.stop();
	$('editbar').hidden = true;
	$('bar').hidden = false;
	if (index >= 0) { rebuild(index); ui.toast(routes[index].edited ? 'your set is saved' : 'back to the original set', 'good'); }
	mode = 'walk';
}

// ---------------------------------------------------------------- moving between walking and climbing

const distanceTo = (spot) => Math.hypot(spot.at.x - walker.at.x, spot.at.y - walker.at.y);

// a start hand: walk up under the problem if needed, then reach it up onto its start hold
function reachFor(k) {
	if (walker.near < 0) return;
	walker.want[k] = true;
	const spot = spots[walker.near];
	if (distanceTo(spot) > 18) { walker.auto = spot; walker.autoTime = 0; }
}
function pullOn() { if (mode === 'walk') { reachFor(0); reachFor(1); } }

// a tap or click on the wall in front of you: a start hold gets that hand, anywhere else walks you up to it
function tryGrab(px, py) {
	if (walker.near < 0) return;
	const point = cursor(px, py);
	if (!point) return;
	const holds = routes[walker.near].holds;
	const k = [0, 1].find(k => holds[2 + k].point.dist(point) < 0.3);
	if (k !== undefined) reachFor(k);
	else if (point.y < 2.6) { walker.auto = spots[walker.near]; walker.autoTime = 0; }
}

// the stages of a scripted move, each easing the body from the last pose into the next
function script(list, done) { stages = { from: pose, t: 0, list, done }; }
function runStages(delta) {
	const stage = stages.list[0];
	stages.t += delta;
	const k = Math.min(1, stages.t / stage.length);
	const target = stage.pose();
	pose = blend(stages.from, target, stage.curve(k));
	if (k < 1) return;
	stages.from = target;
	stages.list.shift();
	stages.t = 0;
	if (stages.list.length) return;
	const done = stages.done;
	stages = null;
	done();
}

function mount() {
	endChalk();
	sim.chalk = [1, 1, 1, 1];
	if (document.pointerLockElement) document.exitPointerLock();
	sim.route = walker.near;
	sim.restart();
	climber.reset();
	walker.want = [false, false];
	walker.lift = [0, 0];
	mode = 'mount';
	limb = -1;
	audio.grab(0.8);
	// the feet step up onto their start holds as the hands take the weight
	script([{ pose: () => climber.climbPose(sim, -1, 1 / 60), length: 0.75, curve: ease }], () => { mode = 'climb'; begin(); });
}

function toWalk() { mode = 'walk'; camYaw = walker.yaw; limb = -1; }

function stand(at) {
	walker.at = at;
	walker.yaw = spots[sim.route].yaw;
	walker.heading = new Vec3(Math.cos(walker.yaw), Math.sin(walker.yaw), 0);
	walker.speed = 0;
	walker.amp = 0;
	walker.auto = null;
	walker.near = sim.route;
}

// on The Wall a fall from a height is caught by an auto-belay that lowers you to the mats, not a ragdoll falling a hundred meters
let lowering = null;
function startLower() {
	lowering = { t: 0, y0: sim.position.y, x: sim.position.x, T: clamp(sim.position.y / 5, 2.5, 8) };
	sim.fallen = true;
	for (let l = 0; l < 4; l++) sim.drop(l);
	audio.slip();
	note = 'the auto-belay catches you';
	noted = 0;
	mode = 'lower';
	limb = -1;
	drag = null;
	joystick = null;
}

function startFall() {
	endChalk();
	agent?.watchEnd('fell', sim.hint);
	if (routes[sim.route].endless && sim.position.y > 6) { startLower(); return; }
	const face = routes[sim.route], panel = face.at(sim.position.y);
	const velocity = panel.right.mul(sim.velocity.x * 100).add(panel.up.mul(sim.velocity.y * 100));
	ragdoll = new Ragdoll(pose, velocity, face);
	landed = false;
	audio.slip();
	note = sim.hint;
	noted = 0;
	mode = 'fall';
	limb = -1;
	drag = null;
	joystick = null;
}

function getUp() {
	const pelvis = mid(pose.roots[0], pose.roots[1]);
	const at = world.clear(new Vec3(pelvis.x, pelvis.y, 0), spots[sim.route].out);
	stand(at);
	ragdoll = null;
	mode = 'rise';
	// roll up to a crouch, then stand
	script([{ pose: () => solve(walkPose({ at, yaw: walker.yaw, crouch: 48 }, climber.clock)), length: 0.75, curve: ease },
		{ pose: walkerPose, length: 0.55, curve: ease }], toWalk);
}

function jumpDown() {
	if (mode !== 'climb') return;
	agent?.watchEnd('left');
	if (routes[sim.route].endless && sim.position.y > 6) { startLower(); return; }
	const face = routes[sim.route], spot = spots[sim.route];
	const hips = face.map(sim.position, 0);
	const at = world.clear(new Vec3(hips.x, hips.y, 0).add(spot.out.mul(40)), spot.out);
	// the drop takes as long as falling from that height does
	const time = clamp(Math.sqrt(2 * Math.max(0, hips.z - 100) / 980), 0.25, 0.9);
	for (let l = 0; l < 4; l++) sim.drop(l);
	$('sent').hidden = true;
	stand(at);
	mode = 'hop';
	script([{ pose: () => solve(walkPose({ at, yaw: walker.yaw, crouch: 52 }, climber.clock)), length: time, curve: (t) => t * t },
		{ pose: walkerPose, length: 0.55, curve: ease }], toWalk);
}

function retry() {
	if (mode !== 'climb' && mode !== 'fall') return;
	endChalk();
	sim.chalk = [1, 1, 1, 1];
	agent?.watchEnd('left');
	sim.restart();
	climber.reset();
	ragdoll = null;
	mode = 'climb';
	limb = -1;
	$('sent').hidden = true;
	begin();
}

// walk over to the previous or next problem
function visit(step) {
	const from = mode === 'walk' && walker.near < 0 ? sim.route : (walker.near >= 0 && mode === 'walk' ? walker.near : sim.route);
	sim.route = (from + step + routes.length) % routes.length;
	// The Wall is behind its own door: the problems in the gym come one after another without it
	if (routes[sim.route].endless) sim.route = (sim.route + step + routes.length) % routes.length;
	const spot = spots[sim.route];
	stand(world.clear(spot.at.add(spot.out.mul(130)), spot.out));
	stages = null;
	ragdoll = null;
	$('sent').hidden = true;
	toWalk();
}

// ---------------------------------------------------------------- input

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
	if (poseEd.active) return;
	canvas.setPointerCapture(e.pointerId);
	Object.assign(pointer, { x: e.clientX, y: e.clientY, inside: true, touch: e.pointerType !== 'mouse' });
	$('tip').classList.add('gone');
	if (mode === 'edit') { editor.down(e.clientX, e.clientY); return; }
	if (mode === 'walk' && e.pointerType === 'mouse') {
		// a mouse takes over the camera like any third-person game: click to look around freely, esc to get the cursor back.
		// while it is held, a click grabs whatever start hold the crosshair is on
		if (document.pointerLockElement === canvas) { tryGrab(innerWidth / 2, innerHeight / 2); return; }
		canvas.requestPointerLock?.()?.catch?.(() => {});
	}
	if (mode === 'walk') {
		// on a phone the left thumb walks and the right thumb looks; a mouse can also drag to look
		if (e.pointerType !== 'mouse' && e.clientX < innerWidth * 0.45 && !stick) {
			stick = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
			Object.assign($('stick').style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
			$('stick').hidden = false;
		} else if (!looking) looking = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
		return;
	}
	if (mode !== 'climb') return;
	if (fpOn()) {
		// first person: a click takes the mouse for looking, or a drag looks when the pointer is not locked
		if (e.pointerType === 'mouse' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
		if (!looking) looking = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
		return;
	}
	if (chalkUp) return;
	if (e.button === 2) { cancel(); return; }
	if (limb >= 0) { place(); return; }
	const found = pick(e.clientX, e.clientY);
	if (found >= 0) {
		lift(found);
		drag = { x: e.clientX, y: e.clientY, moved: false };
		return;
	}
	// a drag on empty wall shifts the hips, like a thumbstick
	joystick = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
});
canvas.addEventListener('pointermove', (e) => {
	if (poseEd.active) return;
	if (document.pointerLockElement === canvas) {
		if (fpOn()) { fpLook(e.movementX * 0.0025 * ui.settings.look, e.movementY * 0.002 * ui.settings.look); return; }
		camYaw += e.movementX * 0.0025 * ui.settings.look;
		camPitch = clamp(camPitch - e.movementY * 0.002 * ui.settings.look, -0.85, 0.3);
		return;
	}
	Object.assign(pointer, { x: e.clientX, y: e.clientY, inside: true, touch: e.pointerType !== 'mouse' });
	if (mode === 'edit') { editor.move(e.clientX, e.clientY); return; }
	if (stick && e.pointerId === stick.id) {
		stick.dx = e.clientX - stick.x;
		stick.dy = e.clientY - stick.y;
		const knob = new Vec2(stick.dx, stick.dy).clampLen(40);
		$('stick').firstChild.style.transform = `translate(${knob.x}px, ${knob.y}px)`;
	}
	if (looking && e.pointerId === looking.id) {
		const dx = e.clientX - looking.x, dy = e.clientY - looking.y;
		if (Math.abs(dx) + Math.abs(dy) > 3) looking.moved = looking.moved || Math.hypot(e.clientX - looking.x, e.clientY - looking.y) > 3;
		if (fpOn()) fpLook(dx * 0.006 * ui.settings.look, dy * 0.004 * ui.settings.look);
		else { camYaw += dx * 0.006 * ui.settings.look; camPitch = clamp(camPitch - dy * 0.004 * ui.settings.look, -0.85, 0.3); }
		looking.x = e.clientX;
		looking.y = e.clientY;
	}
	if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 12) drag.moved = true;
	if (joystick) { joystick.dx = e.clientX - joystick.x; joystick.dy = e.clientY - joystick.y; }
});
const release = (e) => {
	if (poseEd.active) return;
	if (mode === 'edit') editor.up();
	if (stick && e.pointerId === stick.id) { stick = null; $('stick').hidden = true; $('stick').firstChild.style.transform = ''; }
	if (looking && e.pointerId === looking.id) {
		// a tap rather than a drag reaches for whatever start hold it lands on
		if (!looking.moved && mode === 'walk') tryGrab(e.clientX, e.clientY);
		looking = null;
	}
	if (drag) {
		// dragged: drop it where it is. tapped: it stays lifted until the next tap places it
		if (drag.moved && limb >= 0) place();
		drag = null;
	}
	joystick = null;
	if (e.pointerType !== 'mouse') pointer.inside = false;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') pointer.inside = false; });

addEventListener('keydown', (e) => {
	const k = e.key.toLowerCase();
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
	// F3, or Option + P where F keys are brightness and volume: the pose restriction editor
	if (e.code === 'F3' || (e.altKey && e.code === 'KeyP')) { e.preventDefault(); if (poseEd.active) poseEd.close(); else { ui.close(); poseEd.open(); } return; }
	// F6, or Option + J: the form lab
	if (e.code === 'F6' || (e.altKey && e.code === 'KeyJ')) { e.preventDefault(); if (formLab.active) formLab.close(); else { ui.close(); formLab.open(); } return; }
	if (poseEd.active || formLab.active) return;
	if (e.code === 'Backquote') { recorder.toggle(); return; }
	if (k === 'm' || (k === 'escape' && limb < 0 && mode !== 'edit')) { ui.toggle(); return; }
	if (ui.open || recorder.view) return;
	if (k === 'v' && !e.repeat) { toggleFirstPerson(); return; }
	if (k === 'b' && !e.repeat) { toggleWatch(); return; }
	if (fpOn() && !e.ctrlKey && !e.metaKey) {
		// hips: an arrow key latches that shift until it is pressed again (or space centers them), so wasd is free for picking limbs
		const dir = { arrowleft: [1, 0], arrowright: [-1, 0], arrowup: [0, 1], arrowdown: [0, -1] }[k];
		if (dir || k === ' ') {
			e.preventDefault();
			if (e.repeat) return;
			if (k === ' ') fp.lean = new Vec2();
			else if (dir[0]) fp.lean.x = fp.lean.x === dir[0] ? 0 : dir[0];
			else fp.lean.y = fp.lean.y === dir[1] ? 0 : dir[1];
			return;
		}
		if (e.repeat && (k === 'r' || k === 'l' || k === 'a')) return;
		if (limbKey(k)) { keys.delete(k); return; }
	}
	keys.add(k);
	if (mode === 'edit') {
		if (k === 'q' || k === 'arrowleft') editor.turn(15);
		if (k === 'e' || k === 'arrowright') editor.turn(-15);
		if (k === 't') editor.kind();
		if (k === 'delete' || k === 'backspace') editor.remove();
		if (k === 'escape' || k === 'enter') finishEdit();
		return;
	}
	if (k === 'r' && !fpOn()) retry();
	if (k === ']') visit(1);
	if (k === '[') visit(-1);
	if (k === 'g') wide = !wide;
	if (k === 'c' && !e.repeat && mode === 'climb') { startChalk(); return; }
	if (k === 'e') { if (mode === 'walk' && walker.near < 0 && door.near(walker.at)) { door.toggle(); audio.click(); } else pullOn(); }
	if (k === 'j') jumpDown();
	if (k === 'escape') { cancel(); fp.side = ''; }
	if (k === 'x') letGo();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

$('prev').onclick = () => visit(-1);
$('next').onclick = () => visit(1);
$('retry').onclick = retry;
$('pull').onclick = pullOn;
$('edit').onclick = () => { if (walker.near >= 0) editRoute(walker.near); };
$('back').onclick = cancel;
$('hang').onclick = letGo;
$('drop').onclick = jumpDown;
$('again').onclick = retry;
$('onward').onclick = jumpDown;
$('nextUp').onclick = () => goTo((sim.route + 1) % routes.length, true);
$('fpBtn').onclick = toggleFirstPerson;
$('chalkBtn').onclick = startChalk;
$('watch').onclick = toggleWatch;
$('fpRH').onclick = () => sendLimb(2);
$('fpLH').onclick = () => sendLimb(3);
$('fpRF').onclick = () => sendLimb(0);
$('fpLF').onclick = () => sendLimb(1);
$('menuBtn').onclick = () => ui.toggle();
$('eKind').onclick = () => editor.kind();
$('eLeft').onclick = () => editor.turn(15);
$('eRight').onclick = () => editor.turn(-15);
$('eAdd').onclick = () => editor.add();
$('eDel').onclick = () => editor.remove();
$('eReset').onclick = () => editor.reset();
$('eDone').onclick = finishEdit;
// the wheel turns a hold while setting, and otherwise pulls the camera in or out (saved with the settings)
canvas.addEventListener('wheel', (e) => {
	if (poseEd.active) return;
	e.preventDefault();
	if (mode === 'edit') { editor.turn(e.deltaY > 0 ? -10 : 10); return; }
	ui.settings.zoom = clamp(ui.settings.zoom * Math.exp(e.deltaY * 0.0012), 0.45, 2);
	ui.save();
}, { passive: false });
for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => audio.click());
$('tip').textContent = touchy
	? 'left thumb walks, right thumb looks. walk up to a problem and tap its two start holds to pull on.'
	: 'wasd to walk, click to look around with the mouse. walk up to a problem and click its two start holds to pull on.';
const climbTip = touchy
	? 'drag a hand or foot onto a hold. drag empty wall to shift your hips. bare wall is for balance, not pulling.'
	: 'click a hand or foot, move the mouse, click to place it. drag empty wall or use wasd to shift your hips.';

// ---------------------------------------------------------------- each mode's frame

function walk(delta) {
	const f = new Vec3(Math.cos(camYaw), Math.sin(camYaw), 0), r = new Vec3(-f.y, f.x, 0);
	const held = (...names) => names.some(n => keys.has(n)) ? 1 : 0;
	let ix = held('d', 'arrowright') - held('a', 'arrowleft'), iy = held('w', 'arrowup') - held('s', 'arrowdown');
	if (stick) { ix += stick.dx / 50; iy -= stick.dy / 50; }
	let wish = f.mul(iy).add(r.mul(ix));
	if (wish.len() > 1) wish = wish.norm();
	if (wish.len() > 0.15) { walker.auto = null; walker.want = [false, false]; }
	if (walker.auto) {
		walker.autoTime += delta;
		const gap = walker.auto.at.sub(walker.at);
		const flat = new Vec3(gap.x, gap.y, 0);
		if (flat.len() < 5 || walker.autoTime > 6) walker.auto = null;
		else wish = flat.norm().mul(clamp(flat.len() / 45, 0.3, 1));
	}
	const pace = keys.has('shift') ? 1.8 : 1;
	walker.speed += (wish.len() * 165 * pace - walker.speed) * Math.min(1, delta * 8);
	if (wish.len() > 0.05) {
		walker.heading = wish.norm();
		walker.yaw = turn(walker.yaw, Math.atan2(wish.y, wish.x), delta * 10);
	}
	const next = world.move(walker.at, walker.heading.mul(walker.speed * delta));
	const moved = Math.hypot(next.x - walker.at.x, next.y - walker.at.y);
	walker.phase += moved / 130 * Math.PI * 2;
	// a footfall every half stride
	if (Math.floor(walker.phase / Math.PI) !== stride) { stride = Math.floor(walker.phase / Math.PI); audio.pad(); }
	walker.at = new Vec3(next.x, next.y, walker.at.z + (floorAt(next.x, next.y) - walker.at.z) * Math.min(1, delta * 14));
	walker.amp += (clamp(moved / Math.max(delta, 1e-3) / 165, 0, 1.4) - walker.amp) * Math.min(1, delta * 10);
	let near = -1, closest = 170;
	spots.forEach((s, i) => { const d = distanceTo(s); if (d < closest) { closest = d; near = i; } });
	walker.near = near;
	if (near >= 0) sim.route = near;
	// under the start: turn to the wall, then reach each asked-for hand up onto its hold
	const spot = near >= 0 ? spots[near] : null;
	const there = spot && !walker.auto && distanceTo(spot) < 25;
	if (there && walker.want.some(Boolean)) walker.yaw = turn(walker.yaw, spot.yaw, delta * 6);
	const facing = spot && Math.abs(Math.atan2(Math.sin(spot.yaw - walker.yaw), Math.cos(spot.yaw - walker.yaw))) < 0.35;
	for (let k = 0; k < 2; k++) walker.lift[k] = clamp(walker.lift[k] + (there && facing && walker.want[k] ? delta / 0.4 : -delta / 0.3), 0, 1);
	pose = walkerPose();
	if (walker.lift[0] >= 1 && walker.lift[1] >= 1) mount();
}

function walkerPose() {
	const reach = [];
	let look = null;
	if (walker.near >= 0) {
		const face = routes[walker.near];
		look = face.map(new Vec2(0, 1.8));
		for (let k = 0; k < 2; k++) {
			if (walker.lift[k] <= 0) continue;
			const index = 2 + k, side = k === 0 ? -1 : 1, hold = face.holds[index], frame = face.at(hold.point.y);
			const over = hold.kind === 'pinch' ? frame.up : frame.right.mul(-hold.pull.x).add(frame.up.mul(-hold.pull.y)).norm();
			const placed = handOn(frame, face.map(hold.point, 3), over, side, walker.lift[k] > 0.9 ? hold.kind : 'free');
			reach[index] = { ...placed, pole: frame.out.mul(0.6).add(frame.right.mul(side * 0.5)).add(frame.up.mul(-0.6)), weight: walker.lift[k] };
		}
	}
	const p = walkPose({ at: walker.at, yaw: walker.yaw, phase: walker.phase, amp: walker.amp, look }, climber.clock);
	for (const index of [2, 3]) if (reach[index]) p.limbs[index] = blend(p.limbs[index], reach[index], ease(reach[index].weight));
	return solve(p);
}

function climb(delta) {
	if (chalkUp) {
		const dust = chalkUp.update(delta);
		climber.chalking = chalkUp.state;
		if (climber.mouth) for (const amount of dust) chalk.dust(climber.mouth, amount);
		// the hand picks up its chalk as it goes in the bag
		if (chalkUp.chalked) sim.chalk[chalkUp.limb] = Math.min(1, sim.chalk[chalkUp.limb] + delta * 3);
		if (chalkUp.done) {
			const hand = chalkUp.limb, hold = chalkUp.hold;
			endChalk();
			// and back to the hold it left, if the body can still reach it
			if (hold >= 0 && !sim.fallen) sim.grab(hand, hold);
		}
	}
	// the lifted hand or foot follows the pointer until the limb runs out of length; on a phone it rides a little above the finger
	const point = pointer.inside ? cursor(pointer.x, pointer.y - (pointer.touch && drag ? 50 : 0)) : null;
	if (point && limb >= 0) aim = sim.clamp(limb, point);
	sim.reaching = limb;
	sim.target = point && limb >= 0 ? point : aim;
	// wasd or the thumbstick drag shifts the hips; the camera sits behind the climber, so screen right is sim -x
	let lean = fpOn() ? fp.lean.copy() : new Vec2((keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0), (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0));
	if (joystick) lean = lean.add(new Vec2(-joystick.dx / 70, -joystick.dy / 70)).clampLen(1);
	sim.lean = lean.mul(0.6);
	banked = Math.min(banked + delta, 0.25);
	while (banked >= 1 / 60 && !sim.fallen) { sim.step(1 / 60); banked -= 1 / 60; }
	pose = climber.climbPose(sim, limb, delta);
	// what changed on the wall this frame: a catch slaps and puffs chalk, a hold lost to physics squeaks
	const face = routes[sim.route];
	for (let l = 0; l < 4; l++) {
		if (latched[l] < 0 && sim.latch[l] >= 0 && (sim.grips[l] >= 0 || sim.smeared[l])) {
			if (l >= 2) {
				audio.grab(sim.latch[l]);
				if (sim.grips[l] >= 0) {
					// chalk goes up in a puff and leaves a print, and takes some chalk off the hand
					if (sim.chalk[l] > 0.1) chalk.puff(face.map(sim.tips[l], 6), Math.ceil(9 * sim.chalk[l]));
					if (prints.add(face, holdIndexOf(face, sim.grips[l]), sim.grips[l], l === 2 ? -1 : 1, sim.chalk[l])) sim.chalk[l] = Math.max(0, sim.chalk[l] - 0.025);
				}
			}
			else audio.step();
		}
		if (gripped[l] >= 0 && sim.grips[l] < 0 && l !== limb && !sim.fallen) audio.slip();
	}
	latched = [...sim.latch];
	gripped = [...sim.grips];
	if (sim.won && !finished) sent();
	if (sim.fallen) startFall();
}

// ---------------------------------------------------------------- the loop

let baseFov = 50;
function resize() {
	const w = innerWidth, h = innerHeight;
	renderer.setSize(w, h, false);
	poseEd?.resize();
	camera.aspect = w / h;
	// keep the unreal camera's 55 degree horizontal view in landscape; a tall phone gets a taller view instead
	baseFov = camera.aspect >= 1 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(27.5)) / camera.aspect)) : 64;
	camera.fov = baseFov;
	camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let behind = new Vec3(1, 0, 0);
let view = Overview, look = Focus;
let banked = 0, last = performance.now();
const bars = [$('pumpL'), $('pumpR')];
const chalkBars = [$('chalkL'), $('chalkR')];
const loads = [0, 1, 2, 3].map(i => $(`load${i}`));
const show = (id, on) => { $(id).hidden = !on; };

function frame(now) {
	const real = (now - last) / 1000;
	last = now;
	update(real);
	requestAnimationFrame(frame);
}

function update(real) {
	if (poseEd.active) { poseEd.frame(); return; }
	// the menu and the clip viewer pause the climb; the gym keeps drawing behind them
	const paused = ui.open || !!recorder.view;
	const delta = paused ? 0 : Math.min(real, 0.1);
	climber.clock += delta;
	noted += delta;

	if (paused) { /* nothing moves */ }
	else if (mode === 'walk') walk(delta);
	else if (mode === 'climb') climb(delta);
	else if (mode === 'edit') { walker.lift = [0, 0]; pose = walkerPose(); editor.frame(climber.clock); }
	else if (mode === 'fall') {
		ragdoll.step(delta);
		pose = ragdoll.pose();
		if (ragdoll.landed && !landed) { landed = true; audio.thud(); chalk.puff(mid(pose.roots[0], pose.roots[1]), 12, ['#2a2a2e'], 60, 14); }
		if (ragdoll.settled() || ragdoll.time > 3.5) getUp();
	} else if (mode === 'lower') {
		// hanging in the harness, let down the wall to the mats; it is quick from a great height
		lowering.t += delta;
		const k = Math.min(1, lowering.t / lowering.T), e = k * k * (3 - 2 * k);
		sim.position = new Vec2(lowering.x, lowering.y0 + (1.15 - lowering.y0) * e);
		sim.velocity = new Vec2();
		for (let l = 0; l < 4; l++) sim.tips[l] = sim.hang(l);
		pose = climber.climbPose(sim, -1, delta);
		if (k >= 1) getUp();
	} else if (stages) runStages(delta);
	// the setter's view is the wall alone
	climber.group.visible = mode !== 'edit';
	climber.draw(pose);
	chalk.step(delta);
	// The Wall: grown and drawn around whoever is on it, with a light that goes up with them, fog inside its room
	door.update(delta);
	climber.model?.setChalk(sim.chalk[2], sim.chalk[3]);
	if (agent?.climber?.model) agent.climber.model.setChalk(agent.sim.chalk[2], agent.sim.chalk[3]);
	{
		const onWall = routes[sim.route].endless && ['climb', 'mount', 'lower', 'fall', 'hop', 'rise', 'cheer'].includes(mode);
		const inRoom = camera.position.z > 25.7;
		if (onWall) {
			theWall.update(Math.max(1.7, sim.position.y), mode === 'lower');
			if (mode === 'climb' || mode === 'lower') theWall.record(theWall.heightOf(sim.position));
			const slab = routes[sim.route].at(sim.position.y), hips = mid(pose.roots[0], pose.roots[1]);
			wallLight.position.copy(three(hips.add(slab.out.mul(260)).add(Z.mul(70))));
		} else if (inRoom) theWall.update(1.7);
		wallLight.visible = onWall;
		scene.fog.near = inRoom ? 18 : 6000;
		scene.fog.far = inRoom ? 70 : 9000;
	}
	if (agent) {
		agent.player = { mode, route: sim.route, at: walker.at, yaw: walker.yaw, heading: walker.heading, pos: sim.position };
		agent.update(delta);
	}

	// the opening shot holds the whole gym, then swoops in; g flips back to it
	elapsed += real;
	const overview = wide || !ui.started || elapsed < 2.2;
	const tall = camera.aspect < 1;
	const face = routes[sim.route];
	const pelvis = mid(pose.roots[0], pose.roots[1]);
	let goal, target, speed;
	if (overview) { goal = Overview; target = Focus; speed = 1.6; }
	else if (watching.on && agent.on && agent.pose) {
		// watching the AI: over its shoulder on the wall, or behind it as it walks
		const ap = agent.pose, apelvis = mid(ap.roots[0], ap.roots[1]);
		if (['climb', 'mount', 'cheer', 'tumble'].includes(agent.mode) && agent.route) {
			const aface = agent.route, apanel = aface.at(agent.mode === 'tumble' ? 1.2 : agent.sim.position.y);
			const aout = new Vec3(apanel.out.x, apanel.out.y, 0);
			if (aout.len() > 0.3) behind = aout.norm();
			goal = apelvis.add(behind.mul(aface.stand * ui.settings.zoom)).add(apanel.right.mul(aface.aside)).add(new Vec3(0, 0, 30));
			target = apelvis.add(new Vec3(0, 0, 25));
		} else {
			const way = new Vec3(Math.cos(agent.yaw), Math.sin(agent.yaw), 0);
			target = agent.at.add(Z.mul(145));
			goal = target.sub(way.mul(330 * ui.settings.zoom)).add(Z.mul(40));
		}
		speed = view.dist(goal) > 400 ? 2.5 : 5;
	}
	else if (mode === 'walk') {
		// over the shoulder, pulled in rather than looking through a wall
		const direction = new Vec3(Math.cos(camYaw) * Math.cos(camPitch), Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch));
		target = walker.at.add(Z.mul(tall ? 160 : 145));
		const reach = (tall ? 400 : 330) * ui.settings.zoom;
		goal = target.sub(direction.mul(reach));
		for (let d = 40; d <= reach; d += 15) {
			const p = target.sub(direction.mul(d));
			if (world.solid(p, 12) || p.z < floorAt(p.x, p.y) + 15) { goal = target.sub(direction.mul(Math.max(40, d - 20))); break; }
		}
		speed = view.dist(goal) > 400 ? 2.5 : 7;
	} else if (mode === 'edit') {
		// square on to the problem, far enough back to see every hold
		const top = face.panels.reduce((a, p) => a + p.length, 0);
		const middle = face.map(new Vec2(0, top * 0.45), 0);
		const out = face.panels[0].out;
		const flat = new Vec3(out.x, out.y, 0).norm();
		target = middle;
		goal = middle.add(flat.mul(Math.max(560, top * 130) * (tall ? 1.5 : 1))).add(Z.mul(40)).add(face.panels[0].right.mul(face.aside));
		speed = 3;
	} else {
		const panel = face.at(mode === 'climb' || mode === 'lower' ? sim.position.y : 1.2);
		const out = new Vec3(panel.out.x, panel.out.y, 0);
		// under a roof the panel faces the floor; keep the last good direction
		if (out.len() > 0.3) behind = out.norm();
		const lift = tall ? 45 : 0;
		const back = face.stand * (tall ? 1.2 : 1) * (mode === 'climb' || mode === 'mount' ? 1 : 0.8) * ui.settings.zoom;
		goal = pelvis.add(behind.mul(back)).add(panel.right.mul(face.aside)).add(new Vec3(0, 0, 30 + lift));
		target = pelvis.add(new Vec3(0, 0, 25 + lift));
		speed = view.dist(goal) > 300 ? 1.6 : 4;
	}
	view = view.lerp(goal, Math.min(1, delta * speed));
	look = look.lerp(target, Math.min(1, delta * speed * 2));
	// first person blends in from the third person camera and out again, and when fully in the camera is the eye itself
	fp.k = clamp(fp.k + (fpOn() ? delta : -delta) / 0.45, 0, 1);
	if (fp.k > 0) {
		const panel = face.at(sim.position.y);
		fp.F = fp.F ? fp.F.lerp(panel.out.mul(-1), Math.min(1, delta * 6)).norm() : panel.out.mul(-1);
		fp.U = fp.U ? fp.U.lerp(panel.up, Math.min(1, delta * 6)).norm() : panel.up;
		const F = fp.F, U = fp.U.sub(F.mul(fp.U.dot(F))).norm(), R = U.cross(F), cp = Math.cos(fp.pitch);
		const dir = F.mul(cp * Math.cos(fp.yaw)).add(R.mul(cp * Math.sin(fp.yaw))).add(U.mul(Math.sin(fp.pitch)));
		// the eyes sit at the head and never nearer the wall than about a hand's length
		// through the character's own eyes when it is worn, else just ahead of the tubes' head
		const eye = awayFromWall(face, climber.model ? unreal(climber.model.eye()).add(F.mul(9)).add(U.mul(1)) : pose.head.add(F.mul(12)).add(U.mul(2)), 18);
		fp.eye = awayFromWall(face, fp.eye ? fp.eye.lerp(eye, Math.min(1, delta * 30)) : eye, 18);
		const t = ease(fp.k);
		camera.position.copy(three(view.lerp(fp.eye, t)));
		camera.up.copy(new THREE.Vector3(0, 1, 0).lerp(three(U).normalize(), t).normalize());
		camera.lookAt(three(look.lerp(fp.eye.add(dir.mul(100)), t)));
		camera.fov = baseFov + ((camera.aspect >= 1 ? 80 : 90) - baseFov) * t;
		camera.near = fp.k > 0.5 ? 0.03 : 0.05;
		camera.updateProjectionMatrix();
	} else {
		fp.F = fp.U = fp.eye = null;
		camera.up.set(0, 1, 0);
		camera.position.copy(three(view));
		camera.lookAt(three(look));
		if (camera.near !== 0.05 || camera.fov !== baseFov) { camera.fov = baseFov; camera.near = 0.05; camera.updateProjectionMatrix(); }
	}
	climber.setFirstPerson(fp.k > 0.5);
	climber.away = fp.k;
	// the hold in the crosshair glows
	camera.updateMatrixWorld();
	fp.hold = fp.k > 0.9 && fpOn() ? holdInSight() : -1;
	glow.visible = fp.hold >= 0;
	if (glow.visible) {
		const at = face.map(sim.holds()[fp.hold].point, 8);
		glow.position.copy(three(at));
		glow.scale.setScalar(Math.max(0.3, at.dist(unreal(camera.position)) * 0.0012) * (1 + 0.07 * Math.sin(climber.clock * 6)));
		glow.material.opacity = 0.6 + 0.2 * Math.sin(climber.clock * 6);
	}
	const center = three(pelvis);
	// the form lab's training view: its skeleton is in the scene, the camera circles it, the lights follow it and the wall is built round it
	const trainView = formLab.watching ? formLab.view(performance.now() / 1000) : null;
	if (trainView) {
		center.copy(trainView.target);
		wallLight.visible = true;
		wallLight.position.copy(trainView.target).addScaledVector(trainView.out, 2.4).add(new THREE.Vector3(0, 0.6, 0));
		theWall.update(Math.max(1.7, trainView.wallY), trainView.key !== lastTrainKey);
		lastTrainKey = trainView.key;
	}
	key.target.position.copy(center);
	key.position.copy(center).addScaledVector(keyDirection, -15);
	ceiling.target.position.copy(center);
	ceiling.position.copy(center).addScaledVector(ceilingDirection, -15);

	// the tags and the start rings belong to the gym floor, not the climb
	const roaming = mode === 'walk' || mode === 'rise' || mode === 'hop' || mode === 'fall';
	tags.forEach(t => { t.visible = roaming; });
	rings.forEach((ring, k) => {
		ring.visible = mode === 'walk' && walker.near >= 0 && walker.lift[k] < 1;
		if (!ring.visible) return;
		const r = routes[walker.near], hold = r.holds[2 + k].point;
		ring.position.copy(three(r.map(hold, 5)));
		ring.lookAt(three(r.map(hold, 60)));
		ring.scale.setScalar(1 + 0.12 * Math.sin(climber.clock * 5 + k));
	});

	// the hud
	const climbing = mode === 'climb' || mode === 'mount';
	const near = walker.near >= 0 ? routes[walker.near] : null;
	const shown = climbing || mode === 'fall' || mode === 'edit' ? face : near;
	$('route').textContent = shown ? shown.name : 'the rock lounge';
	$('grade').hidden = !shown;
	if (shown) {
		$('grade').lastChild.textContent = shown.grade;
		$('grade').style.setProperty('--tape', `rgb(${shown.tape.map(c => Math.round(c * 255)).join(',')})`);
	}
	$('timer').textContent = shown?.endless && (climbing || mode === 'lower') ? `${theWall.height.toFixed(1)} m · best ${theWall.best.toFixed(1)} m` : climbing && started ? clock(finished || climber.clock - started) : '';
	$('timer').classList.toggle('done', !!finished);
	const sliding = Math.max(sim.strain[2], sim.strain[3]) > 0.9;
	let status;
	if (mode === 'edit') status = editor.hold ? `${editor.label(editor.selected)}: drag to move, q and e or the arrows turn it` : 'pick a hold to move it. green are the starts, red the finish';
	else if (mode === 'fall') status = note;
	else if (fpOn() && fp.side && performance.now() - fp.at < SIDE_WAIT) status = `${fp.side === 'r' ? 'right' : 'left'}: a for the arm, l for the leg`;
	else if (fpOn() && fp.hold >= 0 && limb < 0 && !sim.latch.some(v => v < 0)) status = `${sim.holds()[fp.hold].kind}: r or l, then a (arm) or l (leg)`;
	else if (climbing) status = limb >= 0 ? `${Names[limb]} off the wall` : sliding ? 'fingers sliding: get your feet under you' : (Math.min(sim.chalk[2], sim.chalk[3]) < 0.25 && !chalkUp) ? 'hands are slick: press c to chalk up' : sim.topped > 0 && !sim.won ? 'matched the top, hold it...' : (sim.hint || 'pick a hand or foot');
	else if (note && noted < 4) status = note;
	else if (mode === 'walk' && !near && door.near(walker.at)) status = door.want ? 'press e to close the door' : 'press e to open the door: THE WALL, how high can you go?';
	else if (near) {
		const r = ui.stats[near.name];
		const record = r?.sends ? ` · best ${clock(r.best)}` : '';
		status = (walker.want.some(Boolean) ? 'reaching for the start...' : touchy ? 'tap the two glowing start holds to pull on' : 'click the two glowing start holds, or press e') + record;
	} else status = 'walk up to a problem: each tag shows its grade';
	$('status').textContent = status;
	$('status').classList.toggle('warn', (climbing && sliding && limb < 0) || mode === 'fall');
	show('gauges', climbing && ui.settings.gauges);
	chalkBars[0].style.width = `${sim.chalk[3] * 100}%`;
	chalkBars[1].style.width = `${sim.chalk[2] * 100}%`;
	bars[0].style.width = `${sim.pump[3] * 100}%`;
	bars[1].style.width = `${sim.pump[2] * 100}%`;
	const total = sim.loads.reduce((a, b) => a + b, 0) || 1;
	loads.forEach((bar, i) => { bar.style.width = `${sim.loads[i] / total * 100}%`; });
	show('back', mode === 'climb' && limb >= 0);
	show('hang', mode === 'climb' && limb >= 0);
	show('drop', mode === 'climb' && limb < 0);
	show('retry', mode === 'climb' || mode === 'fall');
	show('fpBtn', mode === 'climb');
	show('chalkBtn', mode === 'climb');
	show('watch', !!agent?.on);
	$('watch').textContent = watching.on ? 'back to me' : 'watch the ai';
	$('ai').hidden = !agent?.on;
	if (agent?.on) $('ai').textContent = agent.summary();
	$('fpBtn').textContent = fp.want ? 'third person' : 'first person';
	for (const id of ['fpRH', 'fpLH', 'fpRF', 'fpLF']) show(id, fpOn());
	show('pull', mode === 'walk' && !!near);
	show('edit', mode === 'walk' && !!near && !near.endless && !touchy);
	show('prev', mode === 'walk');
	show('next', mode === 'walk');
	const locked = document.pointerLockElement === canvas;
	const inside = fp.k > 0.5 && fpOn();
	$('cross').hidden = !(locked && mode === 'walk') && !inside;
	$('cross').classList.toggle('dot', inside);
	$('cross').classList.toggle('on', fp.hold >= 0);
	$('keys').textContent = mode === 'edit' ? 'drag a hold · q e turn · t kind · delete removes · wheel turns · enter done'
		: fpOn() ? 'mouse looks · r/l then a arm or l leg · arrows latch hips, space centers · x hang · j jump down · v third person · m menu'
		: climbing ? 'v first person · wasd hips · esc put back · x hang · j jump down · r retry · wheel zoom · m menu · ` record'
		: locked ? 'wasd walk · shift jog · mouse looks · click a start hold · e pull on · esc frees the mouse'
		: 'wasd walk · shift jog · click to look around · wheel zoom · e pull on · [ ] next · m menu · ` record';
	if (mode === 'mount' && !$('tip').classList.contains('gone') && $('tip').textContent !== climbTip) $('tip').textContent = climbTip;
	if (trainView) { camera.position.copy(trainView.pos); camera.lookAt(trainView.target); camera.updateMatrixWorld(); }
	renderer.render(scene, camera);
}
let lastTrainKey = -1;
applySettings(ui.settings);
if (mode === 'climb') { pose = climber.climbPose(sim, -1, 1 / 60); ui.close(); begin(); }
else { walker.near = -1; pose = walkerPose(); }
$('loading').remove();
requestAnimationFrame(frame);
// a handle for poking at the game from the console
window.rougarou = { bake: (chunks, progress) => bakeWall(bodyCheck, { chunks, progress }), theWall, bodyCheck, formLab, prints, poseEd, agent, watching, camera, climber, fp, sendLimb, sim, routes, get spots() { return spots; }, walker, world, ui, editor, recorder, audio, screenOf, place, lift, pullOn, jumpDown, visit, retry, goTo, editRoute, finishEdit, get mode() { return mode; }, get pose() { return pose; }, view: () => ({ camYaw, camPitch }), aim: (yaw, pitch) => { camYaw = yaw; camPitch = pitch; },
	// run the game forward without waiting on the browser's frame clock
	tick: (seconds) => { for (let t = 0; t < seconds; t += 1 / 60) update(1 / 60); } };
