// the pose restriction editor (F3, Option + P, or Settings -> tools): the character stands on a stage and every joint has a gimbal. turn a joint to the
// furthest it should go, press "set max" (or "set min"), and that is its limit; the gimbal then stops at the limits so you can feel them. Save writes
// limits.json, which the game reads at start and enforces on every character's skeleton (figure.js), so a joint never bends further than it says here.
// each joint is measured as flex (bending), side (swinging away from the middle of the body) and twist (about the bone), all in degrees from rest (limits.js).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Figure } from './figure.js';
import { Groups, Editable, jointFrame, measure, clampRel, reach, humanDefaults, loadLimits } from './limits.js';

const V = THREE.Vector3, Q = THREE.Quaternion;
const DEG = Math.PI / 180;
const inv = (q) => q.clone().invert();
const spin = (v, q) => v.clone().applyQuaternion(q);
// the four directions a bone may swing (the front is the way a joint folds), and the twist
const Swings = [['fwd', 'forward', 'toward the front: an elbow folding, a hip lifting the knee'], ['back', 'back', 'toward the back'], ['out', 'out', 'away from the middle of the body'], ['inn', 'in', 'toward the middle of the body']];
const none = () => ({ fwd: 180, back: 180, out: 180, inn: 180, twist: [-180, 180] });
const full = (l) => !l || (['fwd', 'back', 'out', 'inn'].every(k => (l[k] ?? 180) >= 179.9) && (l.twist?.[0] ?? -180) <= -179.9 && (l.twist?.[1] ?? 180) >= 179.9);
const SWING_COLOR = 0xe0594a, TWIST_COLOR = 0x5b8bd6;
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };

export class PoseEditor {
	constructor({ renderer, canvas, toast, onSaved, seen }) {
		Object.assign(this, { renderer, canvas, toast, onSaved, seen });
		this.active = false;
		this.ready = false;
		this.limits = {};
		this.selected = '';
		this.saved = '';
		this.enforce = true;
		this.arcs = true;
		this.flash = 0;
	}

	// ---------------------------------------------------------------- setting up (once)
	async build() {
		const scene = this.scene = new THREE.Scene();
		scene.background = new THREE.Color(0x1d1f24);
		scene.add(new THREE.HemisphereLight(0xffffff, 0x303338, 1.5));
		const sun = new THREE.DirectionalLight(0xffffff, 2.2);
		sun.position.set(2, 4, 3);
		scene.add(sun);
		const grid = new THREE.GridHelper(4, 16, 0x555a63, 0x34383f);
		scene.add(grid);
		this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
		this.camera.position.set(1.1, 1.35, 3.1);
		this.orbit = new OrbitControls(this.camera, this.canvas);
		this.orbit.target.set(0, 0.95, 0);
		this.orbit.enableDamping = true;
		this.orbit.enabled = false;
		this.figure = await Figure.load('./assets/character/climber.glb', { limits: false });
		scene.add(this.figure.root);
		// the gimbal: rotation only, in the bone's own axes
		this.gimbal = new TransformControls(this.camera, this.canvas);
		this.gimbal.setMode('rotate');
		this.gimbal.setSpace('local');
		this.gimbal.setSize(0.8);
		this.gimbal.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value && this.active; });
		this.gimbal.addEventListener('objectChange', () => this.held());
		this.helper = this.gimbal.getHelper();
		scene.add(this.helper);
		// a dot on every joint that can be limited, to click
		this.dots = {};
		const geometry = new THREE.SphereGeometry(0.014, 12, 8);
		for (const name of Editable) {
			if (!this.figure.bones[name]) continue;
			const dot = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x8aa0b8, depthTest: false, transparent: true, opacity: 0.9 }));
			dot.renderOrder = 6;
			dot.userData.name = name;
			scene.add(dot);
			this.dots[name] = dot;
		}
		// the fans that show a joint's limits
		this.fans = [SWING_COLOR, TWIST_COLOR, 0xffffff].map((color) => {
			const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
			line.renderOrder = 7;
			line.frustumCulled = false;
			scene.add(line);
			return line;
		});
		this.raycaster = new THREE.Raycaster();
		this.canvas.addEventListener('pointerdown', (e) => { if (this.active) this.down = { x: e.clientX, y: e.clientY }; });
		this.canvas.addEventListener('pointerup', (e) => {
			if (!this.active || !this.down) return;
			const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
			this.down = null;
			if (moved < 5 && !this.gimbal.dragging) this.pick(e.clientX, e.clientY);
		});
		this.panel();
		this.ready = true;
	}

	async open() {
		if (!this.ready) await this.build();
		this.limits = await loadLimits();
		this.saved = JSON.stringify(this.limits);
		this.active = true;
		this.orbit.enabled = true;
		document.body.classList.add('pose-editing');
		this.root.hidden = false;
		this.resize();
		this.select(this.selected || 'R_Upperarm');
		this.refresh();
		this.toast?.('pose restriction editor: click a dot, turn the gimbal, set its limits', 'good');
	}

	close() {
		if (!this.active) return;
		this.active = false;
		this.orbit.enabled = false;
		this.gimbal.detach();
		document.body.classList.remove('pose-editing');
		this.root.hidden = true;
	}

	resize() {
		if (!this.ready) return;
		this.camera.aspect = innerWidth / innerHeight;
		this.camera.updateProjectionMatrix();
	}

	// ---------------------------------------------------------------- selecting and turning
	pick(px, py) {
		const rect = this.canvas.getBoundingClientRect();
		this.raycaster.setFromCamera(new THREE.Vector2(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1), this.camera);
		this.raycaster.params.Points = { threshold: 0.03 };
		// the nearest dot to the ray, within a few centimeters
		let best = '', near = 0.035;
		for (const [name, dot] of Object.entries(this.dots)) {
			const d = this.raycaster.ray.distanceToPoint(dot.position);
			if (d < near) { near = d; best = name; }
		}
		if (best) this.select(best);
	}

	select(name) {
		const bone = this.figure.bones[name];
		if (!bone) return;
		this.selected = name;
		this.gimbal.attach(bone);
		this.picker.value = name;
		this.refresh();
	}

	frameOf(name) { return this.figure.frames[name] ??= jointFrame(this.figure, name); }
	// where the selected joint is now, as flex, side and twist from rest
	valuesOf(name) {
		const bone = this.figure.bones[name], rest = this.figure.rest[name], frame = this.frameOf(name);
		return measure(inv(rest.local).multiply(bone.quaternion), frame);
	}

	// while the gimbal is dragged: stop the joint at its limits
	held() {
		const name = this.selected, lim = this.limits[name];
		if (!lim || !this.enforce) return;
		const bone = this.figure.bones[name], rest = this.figure.rest[name];
		const out = clampRel(inv(rest.local).multiply(bone.quaternion), this.frameOf(name), lim);
		if (out.hit) { bone.quaternion.copy(rest.local.clone().multiply(out.q)); this.flash = performance.now(); }
	}

	// ---------------------------------------------------------------- the panel
	panel() {
		const root = this.root = el('div', { className: 'pose-panel glass', hidden: true });
		const head = el('div', { className: 'pose-head' }, el('b', { textContent: 'pose restrictions' }));
		const close = el('button', { textContent: 'close', className: 'ghost' });
		close.onclick = () => this.close();
		this.saveButton = el('button', { textContent: 'save', className: 'hot' });
		this.saveButton.onclick = () => this.ask();
		head.append(this.saveButton, close);
		this.picker = el('select');
		for (const [group, names] of Groups) {
			const og = el('optgroup', { label: group });
			for (const n of names) if (this.figure.bones[n]) og.append(el('option', { value: n, textContent: n.replace(/^[LR]_/, m => m === 'L_' ? 'left ' : 'right ') }));
			this.picker.append(og);
		}
		this.picker.onchange = () => this.select(this.picker.value);
		this.title = el('div', { className: 'pose-title' });
		this.rows = {};
		const table = el('div', { className: 'pose-axes' });
		this.now = el('div', { className: 'pose-now-line' });
		table.append(this.now);
		for (const [key, label, hint] of Swings) {
			const input = el('input', { type: 'number', step: 1, min: 0, max: 180, className: 'pose-num', title: hint });
			const set = el('button', { textContent: 'set from pose', title: `make how far the joint is bent now the most it may swing ${label}` });
			input.onchange = () => this.edit(key, Number(input.value));
			set.onclick = () => this.edit(key, Math.round(measure(this.rel(this.selected), this.frameOf(this.selected)).theta));
			this.rows[key] = { input };
			table.append(el('div', { className: 'pose-line' }, el('span', { textContent: label, style: 'width:62px;color:#e0594a' }), input, el('span', { textContent: '\u00b0' }), set));
		}
		const lo = el('input', { type: 'number', step: 1, className: 'pose-num' }), hi = el('input', { type: 'number', step: 1, className: 'pose-num' });
		lo.onchange = () => this.edit('twist', Number(lo.value), 0);
		hi.onchange = () => this.edit('twist', Number(hi.value), 1);
		const setLo = el('button', { textContent: 'set min', title: 'the furthest this joint may twist one way' }), setHi = el('button', { textContent: 'set max', title: 'the furthest this joint may twist the other way' });
		setLo.onclick = () => this.edit('twist', Math.round(measure(this.rel(this.selected), this.frameOf(this.selected)).twist), 0);
		setHi.onclick = () => this.edit('twist', Math.round(measure(this.rel(this.selected), this.frameOf(this.selected)).twist), 1);
		const bar = el('div', { className: 'pose-bar' }, el('i'), el('b'));
		this.rows.twist = { lo, hi, bar };
		table.append(el('div', { className: 'pose-axis' }, el('div', { className: 'pose-line' }, el('span', { textContent: 'twist', style: 'color:#5b8bd6' }), lo, el('span', { textContent: 'to' }), hi), bar, el('div', { className: 'pose-line' }, setLo, setHi)));
		const toggles = el('div', { className: 'pose-toggles' });
		const check = (text, key) => {
			const box = el('input', { type: 'checkbox', checked: this[key] });
			box.onchange = () => { this[key] = box.checked; };
			toggles.append(el('label', {}, box, text));
		};
		check('hold the gimbal at the limits', 'enforce');
		check('show the limit cone and twist fan', 'arcs');
		const actions = el('div', { className: 'pose-actions' });
		const act = (text, fn, title = '') => { const b = el('button', { textContent: text, title }); b.onclick = fn; actions.append(b); };
		act('reset this joint', () => { this.reset(this.selected); }, 'put this joint back to its rest pose');
		act('no limits here', () => { delete this.limits[this.selected]; this.refresh(); });
		act('copy to the other side', () => this.mirror(), 'give the same limits to the matching joint on the other side of the body');
		act('reset the pose', () => { for (const n of Editable) this.reset(n, true); this.refresh(); });
		act('from the game so far', () => this.fromGame(), 'start every joint from the furthest the game has turned it so far (plus a little), so nothing in the game changes until you tighten a joint');
		act('human defaults', () => { this.limits = humanDefaults(); this.refresh(); this.toast?.('limits for every joint set to a plausible human range: change what you like', 'good'); }, 'start every joint from a plausible human range');
		act('clear all limits', () => { this.limits = {}; this.refresh(); });
		this.count = el('div', { className: 'pose-count' });
		this.confirm = el('div', { className: 'pose-confirm', hidden: true }, el('span', { textContent: 'Are you sure you want to save? It replaces limits.json and every character in the game follows it.' }));
		const yes = el('button', { textContent: 'yes, save', className: 'hot' }), no = el('button', { textContent: 'cancel', className: 'ghost' });
		yes.onclick = () => this.save();
		no.onclick = () => { this.confirm.hidden = true; };
		this.confirm.append(yes, no);
		root.append(head, this.picker, this.title, table, toggles, actions, this.count, this.confirm,
			el('p', { className: 'pose-help', textContent: 'click a dot on the body to pick a joint · drag the rings to turn it, to the furthest it should go, then "set from pose" · the red cone is where the bone may point, the blue fan how far it may twist · orbit with the mouse, scroll to zoom · F3 closes' }));
		document.body.append(root);
	}

	rel(name) { return inv(this.figure.rest[name].local).multiply(this.figure.bones[name].quaternion); }

	// set one limit of the selected joint: a swing (degrees) or one end (Which, 0 or 1) of the twist
	edit(key, value, which) {
		if (!Number.isFinite(value)) return;
		const lim = this.limits[this.selected] ??= none();
		if (key === 'twist') {
			lim.twist ??= [-180, 180];
			lim.twist[which] = Math.max(-360, Math.min(360, value));
			if (lim.twist[0] > lim.twist[1]) lim.twist[1 - which] = lim.twist[which];
		} else lim[key] = Math.max(0, Math.min(180, value));
		this.refresh();
	}

	reset(name, quiet) {
		const bone = this.figure.bones[name];
		if (!bone) return;
		bone.quaternion.copy(this.figure.rest[name].local);
		if (!quiet) this.refresh();
	}

	// every joint limited to a little beyond what the game has asked of it so far
	fromGame() {
		const seen = this.seen?.() ?? {};
		const pad = 8, out = {};
		for (const [name, s] of Object.entries(seen)) {
			if (!this.figure.bones[name] || (s.fwd + s.back + s.out + s.inn < 1 && s.twist[1] - s.twist[0] < 1)) continue;
			const up = (v) => Math.min(180, Math.round(v + pad));
			out[name] = { fwd: up(s.fwd), back: up(s.back), out: up(s.out), inn: up(s.inn), twist: [Math.max(-180, Math.round(s.twist[0] - pad)), Math.min(180, Math.round(s.twist[1] + pad))] };
		}
		if (!Object.keys(out).length) { this.toast?.('the game has not moved a character yet: climb or walk a little, then try again', 'warn'); return; }
		this.limits = out;
		this.refresh();
		this.toast?.(`${Object.keys(out).length} joints limited to what the game has used so far, with ${pad} degrees to spare`, 'good');
	}

	mirror() {
		const name = this.selected, other = name.startsWith('L_') ? `R_${name.slice(2)}` : name.startsWith('R_') ? `L_${name.slice(2)}` : null;
		if (!other || !this.limits[name]) { this.toast?.('nothing to copy: this joint is in the middle of the body or has no limits yet', 'warn'); return; }
		this.limits[other] = JSON.parse(JSON.stringify(this.limits[name]));
		this.toast?.(`copied to ${other.replace('L_', 'left ').replace('R_', 'right ')}`, 'good');
		this.refresh();
	}

	// redraw the numbers for the selected joint, and the count
	refresh() {
		const name = this.selected;
		if (!name || !this.root) return;
		this.title.textContent = name.replace(/^L_/, 'left ').replace(/^R_/, 'right ');
		const lim = this.limits[name];
		for (const [key] of Swings) this.rows[key].input.value = lim?.[key] ?? 180;
		this.rows.twist.lo.value = lim?.twist?.[0] ?? -180;
		this.rows.twist.hi.value = lim?.twist?.[1] ?? 180;
		const used = Object.keys(this.limits).filter(n => !full(this.limits[n])).length;
		this.count.textContent = `${used} joints limited${JSON.stringify(this.clean()) !== this.saved ? ' · unsaved changes' : ''}`;
		this.saveButton.classList.toggle('hot', JSON.stringify(this.clean()) !== this.saved);
	}

	// only the joints that are really limited
	clean() {
		const out = {};
		for (const [n, l] of Object.entries(this.limits)) if (!full(l)) out[n] = { fwd: l.fwd ?? 180, back: l.back ?? 180, out: l.out ?? 180, inn: l.inn ?? 180, twist: l.twist ?? [-180, 180] };
		return out;
	}

	ask() { this.confirm.hidden = false; }
	async save() {
		this.confirm.hidden = true;
		const body = JSON.stringify({ version: 1, limits: this.clean() });
		try {
			const r = await fetch('/dev/limits', { method: 'POST', body });
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `error ${r.status}`);
			// read it back and compare, so "saved" is only said when it is true
			const back = await loadLimits();
			const same = JSON.stringify(back) === JSON.stringify(this.clean());
			this.saved = JSON.stringify(this.clean());
			this.refresh();
			this.onSaved?.(back);
			this.toast?.(same ? 'saved to limits.json and checked: the game follows it now' : 'saved, but the file read back differently', same ? 'good' : 'warn');
		} catch (e) {
			try { localStorage.setItem('rougarou-limits-draft', body); } catch { /* none */ }
			this.toast?.(`not saved to the project (${e.message}). run tools/devserver.py on this machine; a copy is kept in this browser`, 'warn');
		}
	}

	// ---------------------------------------------------------------- every frame
	frame() {
		if (!this.active) return;
		this.orbit.update();
		const name = this.selected, now = performance.now();
		const world = new V();
		for (const [n, dot] of Object.entries(this.dots)) {
			this.figure.bones[n].getWorldPosition(world);
			dot.position.copy(world);
			const limited = this.limits[n] && !full(this.limits[n]);
			dot.material.color.setHex(n === name ? (now - this.flash < 160 ? 0xff4d3d : 0xf6d3bd) : limited ? 0x6fcf8c : 0x8aa0b8);
			dot.scale.setScalar(n === name ? 1.6 : 1);
		}
		if (name) {
			const m = measure(this.rel(name), this.frameOf(name)), lim = this.limits[name];
			const phi = ((m.phi % 360) + 360) % 360, words = m.theta < 2 ? 'at rest' : `toward the ${phi < 22.5 || phi >= 337.5 ? 'front' : phi < 67.5 ? 'front and out' : phi < 112.5 ? 'out' : phi < 157.5 ? 'back and out' : phi < 202.5 ? 'back' : phi < 247.5 ? 'back and in' : phi < 292.5 ? 'in' : 'front and in'}`;
			const most = lim ? reach(lim, m.phi / DEG) : 180;
			this.now.textContent = `bent ${m.theta.toFixed(0)}\u00b0 ${words}${lim && m.theta > most + 0.5 ? ` (over: it may go ${most.toFixed(0)}\u00b0 that way)` : lim ? ` (it may go ${most.toFixed(0)}\u00b0 that way)` : ''} · twist ${m.twist >= 0 ? '+' : ''}${m.twist.toFixed(0)}\u00b0`;
			this.now.classList.toggle('over', !!lim && m.theta > most + 0.5);
			const range = lim?.twist ?? [-180, 180], bar = this.rows.twist.bar;
			bar.firstChild.style.left = `${(range[0] + 180) / 360 * 100}%`;
			bar.firstChild.style.width = `${Math.max(0.5, (range[1] - range[0]) / 360 * 100)}%`;
			bar.lastChild.style.left = `${(Math.max(-180, Math.min(180, m.twist)) + 180) / 360 * 100}%`;
			bar.classList.toggle('over', m.twist < range[0] - 0.5 || m.twist > range[1] + 0.5);
			this.draw(name, m);
		}
		this.renderer.render(this.scene, this.camera);
	}

	// the cone the bone may point inside, the fan the twist may turn through, and where the bone points now
	draw(name, m) {
		const frame = this.frameOf(name), lim = this.limits[name];
		for (const l of this.fans) l.visible = this.arcs && !!frame;
		if (!this.arcs || !frame) return;
		const bone = this.figure.bones[name], parentQ = new Q(), at = new V();
		bone.parent.updateWorldMatrix(true, false);
		bone.parent.matrixWorld.decompose(new V(), parentQ, new V());
		bone.getWorldPosition(at);
		const restWorld = parentQ.multiply(this.figure.rest[name].local);
		const T = spin(frame.T, restWorld), F = spin(frame.F, restWorld), S = spin(frame.S, restWorld);
		const D = new V().crossVectors(F, T).normalize(), E = new V().crossVectors(S, T).normalize();
		const radius = 0.16;
		// the cone: around the compass of directions, the furthest the bone may point
		const ring = [];
		for (let i = 0; i <= 48; i++) {
			const phi = i / 48 * Math.PI * 2, theta = Math.min(reach(lim ?? {}, phi), 179) * DEG;
			const dir = T.clone().multiplyScalar(Math.cos(theta)).addScaledVector(D, Math.sin(theta) * Math.cos(phi)).addScaledVector(E, Math.sin(theta) * Math.sin(phi));
			ring.push(at.clone().add(dir.multiplyScalar(radius)));
			if (i % 12 === 0) { ring.push(at.clone()); ring.push(ring[ring.length - 2].clone()); }
		}
		this.fans[0].geometry.setFromPoints(ring);
		// the twist fan: the way a sideways direction turns about the bone
		const range = (lim?.twist ?? [-180, 180]).map(v => Math.max(-170, Math.min(170, v)) * frame.side * 1).sort((a, b) => a - b);
		const fan = [at.clone()];
		for (let i = 0; i <= 28; i++) fan.push(at.clone().add(spin(F, new Q().setFromAxisAngle(T, (range[0] + (range[1] - range[0]) * i / 28) * DEG)).multiplyScalar(0.11)));
		fan.push(at.clone());
		this.fans[1].geometry.setFromPoints(fan);
		// where the bone points now
		this.fans[2].geometry.setFromPoints([at.clone(), at.clone().add(m.T2.clone().applyQuaternion(restWorld).multiplyScalar(radius * 1.15))]);
	}
}
