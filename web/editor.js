// the route setter: pick any hold on a problem, drag it across the wall, turn it, change what kind of hold it is, add or pull holds.
// a turned hold is pulled a different way, so the climbing changes with it. sets are kept in this browser and can be reset.

import * as THREE from 'three';
import { Vec2 } from './sim.js';
import { toThree } from './gym.js';

const Kinds = ['jug', 'crimp', 'sloper', 'pinch', 'pocket'];
const Key = 'rougarou-sets', Meta = 'rougarou-setter';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const three = (v) => new THREE.Vector3(...toThree(v));
const pack = (h) => ({ x: h.point.x, y: h.point.y, kind: h.kind, px: h.pull.x, py: h.pull.y, seed: h.seed });
const unpack = (h) => ({ point: new Vec2(h.x, h.y), kind: h.kind, pull: new Vec2(h.px, h.py), seed: h.seed });

export class Editor {
	// Hooks: cursor(px, py) on the active problem's wall, screenOf(point), rebuild(index), toast(text)
	constructor(scene, routes, originals, hooks) {
		this.routes = routes;
		this.originals = originals;
		this.hooks = hooks;
		this.index = -1;
		this.selected = -1;
		this.drag = null;
		this.dirty = false;
		this.rings = Array.from({ length: 40 }, () => {
			const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.007, 6, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false }));
			ring.renderOrder = 5;
			ring.visible = false;
			scene.add(ring);
			return ring;
		});
		// an arrow on the picked hold showing which way it is pulled
		this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), 0.22, 0xf2a007, 0.07, 0.05);
		this.arrow.visible = false;
		this.arrow.traverse(o => { if (o.material) { o.material.depthTest = false; o.renderOrder = 6; } });
		scene.add(this.arrow);
		// every hold gets a stable seed so its shape survives other holds being added or removed
		routes.forEach(r => r.holds.forEach((h, i) => { h.seed ??= i; }));
		originals.forEach(r => r.holds.forEach((h, i) => { h.seed ??= i; }));
		let saved = {};
		try { saved = JSON.parse(localStorage.getItem(Key) || '{}'); } catch { /* none */ }
		// sets are kept under the problem's original name, since the setter can rename a problem
		routes.forEach((r, i) => { const key = originals[i].name; if (saved[key]) { r.holds = saved[key].map(unpack); r.edited = true; } });
		let meta = {};
		try { meta = JSON.parse(localStorage.getItem(Meta) || '{}'); } catch { /* none */ }
		routes.forEach((r, i) => { const m = meta[originals[i].name]; if (m) { r.name = m.name ?? r.name; r.grade = m.grade ?? r.grade; r.setter = m.by; } });
	}

	// keep a problem as it is now, however it was changed (the user's setter or the AI's): its holds, and its name and grade if given
	commitRoute(index, meta) {
		const keep = this.index;
		this.index = index;
		this.save();
		this.index = keep;
		if (!meta) return;
		let all = {};
		try { all = JSON.parse(localStorage.getItem(Meta) || '{}'); } catch { /* none */ }
		all[this.originals[index].name] = meta;
		try { localStorage.setItem(Meta, JSON.stringify(all)); } catch { /* this session only */ }
	}

	get active() { return this.index >= 0; }
	get route() { return this.routes[this.index]; }
	get hold() { return this.route?.holds[this.selected]; }

	start(index) { this.index = index; this.selected = -1; this.sync(); }
	stop() {
		if (!this.active) return;
		this.save();
		this.index = -1;
		this.selected = -1;
		this.drag = null;
		for (const r of this.rings) r.visible = false;
		this.arrow.visible = false;
	}

	save() {
		let saved = {};
		try { saved = JSON.parse(localStorage.getItem(Key) || '{}'); } catch { /* none */ }
		const route = this.route, original = this.originals[this.index];
		const same = route.holds.length === original.holds.length && route.holds.every((h, i) => JSON.stringify(pack(h)) === JSON.stringify(pack(original.holds[i])));
		const key = this.originals[this.index].name;
		if (same) delete saved[key]; else saved[key] = route.holds.map(pack);
		route.edited = !same;
		try { localStorage.setItem(Key, JSON.stringify(saved)); } catch { /* this session only */ }
	}

	// the hold under the pointer, by screen distance
	pick(px, py) {
		let best = -1, closest = 46;
		this.route.holds.forEach((h, i) => {
			const s = this.hooks.screenOf(h.point);
			const gap = Math.hypot(s.x - px, s.y - py);
			if (s.front && gap < closest) { closest = gap; best = i; }
		});
		return best;
	}

	down(px, py) {
		this.selected = this.pick(px, py);
		if (this.selected >= 0) this.drag = { x: px, y: py };
		this.sync();
	}
	move(px, py) {
		if (!this.drag || this.selected < 0) return;
		const point = this.hooks.cursor(px, py);
		if (!point) return;
		const top = this.route.panels.reduce((a, p) => a + p.length, 0);
		this.hold.point = new Vec2(clamp(point.x, -2.7, 2.7), clamp(point.y, 0.25, top - 0.12));
		this.dirty = true;
	}
	up() { this.drag = null; }

	turn(degrees) {
		if (!this.hold) return;
		this.hold.pull = this.hold.pull.rot(degrees * Math.PI / 180).norm();
		this.dirty = true;
	}
	kind() {
		if (!this.hold) return;
		this.hold.kind = Kinds[(Kinds.indexOf(this.hold.kind) + 1) % Kinds.length];
		this.dirty = true;
		this.sync();
	}
	add() {
		const holds = this.route.holds;
		if (holds.length >= 38) { this.hooks.toast('that is a lot of holds already', 'warn'); return; }
		// a new jug just above the middle of the problem, before the finish hold so the top stays the top
		const around = this.selected >= 0 ? this.hold.point : new Vec2(0, 2.2);
		const seed = Math.max(...holds.map(h => h.seed ?? 0)) + 1;
		holds.splice(holds.length - 1, 0, { point: new Vec2(clamp(around.x + 0.3, -2.7, 2.7), around.y + 0.15), kind: 'jug', pull: new Vec2(0, -1), seed });
		this.selected = holds.length - 2;
		this.dirty = true;
		this.sync();
	}
	remove() {
		const holds = this.route.holds;
		// the four start holds and the finish define the problem
		if (this.selected < 4 || this.selected === holds.length - 1) { this.hooks.toast('start and finish holds can move but not come off', 'warn'); return; }
		holds.splice(this.selected, 1);
		this.selected = -1;
		this.dirty = true;
		this.sync();
	}
	reset() {
		this.route.holds = this.originals[this.index].holds.map(h => ({ point: h.point.copy(), kind: h.kind, pull: h.pull.copy(), seed: h.seed }));
		this.selected = -1;
		this.dirty = true;
		this.sync();
	}

	label(i) {
		const n = this.route.holds.length;
		return i < 2 ? 'start foot' : i < 4 ? 'start hand' : i === n - 1 ? 'finish' : this.route.holds[i].kind;
	}

	sync() { document.getElementById('eKind').textContent = this.hold ? this.hold.kind : 'pick a hold'; }

	// once a frame: rebuild a moved hold's mesh and keep the rings on the holds
	frame(time) {
		if (!this.active) return;
		if (this.dirty) { this.dirty = false; this.hooks.rebuild(this.index); }
		const route = this.route;
		this.rings.forEach((ring, i) => {
			const h = route.holds[i];
			ring.visible = !!h;
			if (!h) return;
			ring.position.copy(three(route.map(h.point, 6)));
			ring.lookAt(three(route.map(h.point, 60)));
			const picked = i === this.selected;
			const start = i < 4, finish = i === route.holds.length - 1;
			ring.material.color.set(picked ? 0xf2a007 : start ? 0x8fd6a8 : finish ? 0xff6b5a : 0xffffff);
			ring.scale.setScalar(picked ? 1.25 + 0.08 * Math.sin(time * 6) : 1);
		});
		const h = this.hold;
		this.arrow.visible = !!h;
		if (h) {
			const face = route.at(h.point.y);
			const pull = face.right.mul(h.pull.x).add(face.up.mul(h.pull.y));
			this.arrow.position.copy(three(route.map(h.point, 12)));
			this.arrow.setDirection(three(pull.mul(100)).normalize());
		}
	}
}
