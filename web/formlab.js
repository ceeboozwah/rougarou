// the form lab (F6, Option + J, or Settings -> tools): an AI mode that trains on realistic limb and joint bending, flexion and rotation, on the wall itself.
//
// 1. DATA. the rehearsal solver climbs the endless wall (wallpose.js) and every move's body is kept: the full pose of the climber, taken from real holds.
// 2. THE WALLS. the joints obey anatomy (limits.js, `Anatomy`: ranges from the biomechanics literature, turned into this skeleton's frames). a limit is a hard
//    wall: a joint that is asked for more is held to it, and the limb then misses where it was aimed. the lab replays every wall pose under four settings (no limits,
//    the limits file as it is, the anatomical ranges, the ranges with the trained spine) and counts how far hands and feet miss their holds, how many poses hold
//    every limb on its hold, and how strained the body is (joints past 70% of their range, a spine bending in one place).
// 3. TRAINING. the spine and the neck are split over joints (how much of the pelvis-to-chest turn each takes: figure.mix). the lab searches those four shares
//    (cross-entropy method) for the split that, under the anatomical ranges, misses the holds least and strains the body least on the wall poses.
// 4. APPLY. the anatomical ranges and the trained shares go on the characters, and a second press writes limits.json.

import { Vector3 } from 'three';
import { Figure } from './figure.js';
import { Editable, jointFrame, measure, reach, humanDefaults, loadLimits, loadMix } from './limits.js';
import { revive } from './wallpose.js';

const D2R = Math.PI / 180;
const Key = 'rougarou-formlab';
const COMFORT = 0.7;
const HIT = 0.015;
const MIXES = ['waist', 'spine01', 'neck1', 'neck2'];
const DEFAULT = { waist: 0.35, spine01: 0.7, neck1: 0.35, neck2: 0.65 };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
const round = (v) => Math.round(v);
const pct = (list, p) => { if (!list.length) return 0; const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

export class FormLab {
	constructor({ toast, onApply, collect }) {
		Object.assign(this, { toast, onApply, collect });
		this.active = false;
		this.ready = false;
		this.poses = [];
		this.report = null;
		this.mix = null;
		this.needs = null;
		this.curve = [];
		this.busy = false;
		this.pause = false;
		this.armed = false;
		this.shown = 0;
		this.file = {};
		this.anatomy = humanDefaults();
		try { const w = JSON.parse(localStorage.getItem(Key + '-poses') || 'null'); if (w?.length) this.poses = w.map(p => ({ y: p.y, pose: revive(p.pose) })); } catch { /* none */ }
		try { const s = JSON.parse(localStorage.getItem(Key) || 'null'); if (s?.mix) { this.mix = s.mix; this.report = s.report; } } catch { /* none */ }
	}

	async build() {
		this.figure = await Figure.load('./assets/character/climber.glb', { limits: false });
		this.names = Editable.filter(n => this.anatomy[n]);
		this.panel();
		this.ready = true;
	}

	// ---------------------------------------------------------------- replaying a pose
	// the pose on the skeleton under Limits and Mix; returns how far each limb missed (m), the joint turns, and the strain
	replay(pose, limits, mix) {
		const f = this.figure;
		f.limits = limits ?? {};
		f.hits = {};
		f.setMix(mix);
		f.applyPose(pose, 0);
		f.root.updateMatrixWorld(true);
		const turns = {};
		let strain = 0;
		for (const name of this.names) {
			const frame = f.frames[name] ??= jointFrame(f, name);
			const q = f.rest[name].local.clone().invert().multiply(f.bones[name].quaternion);
			const m = measure(q, frame);
			turns[name] = m;
			const lim = this.anatomy[name];
			const r = m.theta / reach(lim, m.phi * D2R);
			if (r > COMFORT) strain += ((r - COMFORT) / (1 - COMFORT)) ** 2;
			const t = m.twist >= 0 ? m.twist / (lim.twist[1] || 180) : m.twist / (lim.twist[0] || -180);
			if (t > COMFORT) strain += ((t - COMFORT) / (1 - COMFORT)) ** 2 * 0.6;
		}
		const sp = ['Waist', 'Spine01', 'Spine02'].map(n => turns[n].theta), mean = (sp[0] + sp[1] + sp[2]) / 3;
		strain += 0.5 * (sp.reduce((s, v) => s + (v - mean) ** 2, 0) / 3) / 64;
		// a knee or an elbow inside the wall (less than 2 cm clear of it)
		let clip = false;
		for (const n of ['R_Calf', 'L_Calf', 'R_Forearm', 'L_Forearm']) { const e = f.bones[n].matrixWorld.elements; if (f.wallDepth(new Vector3(e[12], e[13], e[14])) < 0.02) clip = true; }
		return { miss: [...f.misses], turns, strain, hits: { ...f.hits }, stretch: f.stretch, clip };
	}

	// every pose under one setting: how many limbs land on their holds, how far they miss, how strained the body is, which joints ran into a wall
	study(limits, mix, poses = this.poses) {
		const misses = [], strains = [], held = {};
		let every = 0, knee = 0, elbow = 0, stretched = 0, clips = 0;
		for (const { pose } of poses) {
			const r = this.replay(pose, limits, mix);
			misses.push(...r.miss);
			strains.push(r.strain);
			if (r.miss.every(m => m < HIT)) every++;
			if (r.stretch > 1) stretched++;
			if (r.clip) clips++;
			for (const n of Object.keys(r.hits)) held[n] = (held[n] ?? 0) + 1;
			knee = Math.max(knee, r.turns.R_Calf?.theta ?? 0, r.turns.L_Calf?.theta ?? 0);
			elbow = Math.max(elbow, r.turns.R_Forearm?.theta ?? 0, r.turns.L_Forearm?.theta ?? 0);
		}
		const n = poses.length || 1;
		return {
			reach: misses.filter(m => m < HIT).length / (misses.length || 1),
			every: every / n,
			miss: misses.reduce((a, b) => a + b, 0) / (misses.length || 1) * 100,
			worst: Math.max(0, ...misses) * 100,
			strain: strains.reduce((a, b) => a + b, 0) / n,
			held: Object.fromEntries(Object.entries(held).map(([k, v]) => [k, v / n])),
			knee, elbow, stretched: stretched / n, clip: clips / n,
		};
	}

	// how far the wall poses really take each joint, in each direction (the free body, no limits): the demand
	demand() {
		const out = {};
		for (const name of this.names) out[name] = { fwd: [], back: [], out: [], inn: [], twist: [] };
		for (const { pose } of this.poses) {
			const r = this.replay(pose, null, DEFAULT);
			for (const name of this.names) {
				const m = r.turns[name], p = m.phi * D2R, c = Math.cos(p), s = Math.sin(p), d = out[name];
				if (c > 0.38) d.fwd.push(m.theta);
				if (c < -0.38) d.back.push(m.theta);
				if (s > 0.38) d.out.push(m.theta);
				if (s < -0.38) d.inn.push(m.theta);
				d.twist.push(m.twist);
			}
		}
		const sum = {};
		for (const [name, d] of Object.entries(out)) sum[name] = { fwd: pct(d.fwd, 0.97), back: pct(d.back, 0.97), out: pct(d.out, 0.97), inn: pct(d.inn, 0.97), twist: [pct(d.twist, 0.03), pct(d.twist, 0.97)] };
		return sum;
	}

	// ---------------------------------------------------------------- the job
	*job(gens) {
		const rand = rng(31337);
		this.progress = 'replaying the wall poses with no limits';
		yield;
		this.needs = this.demand();
		const sample = [...this.poses].sort(() => rand() - 0.5).slice(0, 70);
		// how a split does: misses of the holds (in cm, squared) plus strain, under the anatomical ranges
		const score = (m) => { const s = this.study(this.anatomy, m, sample); return (s.miss / 1.5) ** 2 + s.worst / 6 + 6 * s.stretched + 12 * s.clip + 0.35 * s.strain; };
		let mean = MIXES.map(k => DEFAULT[k]), sigma = MIXES.map(() => 0.22);
		const toMix = (v) => Object.fromEntries(MIXES.map((k, i) => [k, Math.min(1, Math.max(0, v[i]))]));
		let best = { v: mean.slice(), cost: score(DEFAULT) };
		this.curve = [best.cost];
		const pop = 14, elite = 4;
		for (let g = 0; g < gens; g++) {
			const crowd = [];
			for (let p = 0; p < pop; p++) {
				const v = mean.map((m, i) => Math.min(1, Math.max(0, m + sigma[i] * gauss(rand))));
				crowd.push({ v, cost: score(toMix(v)) });
				this.progress = `training the spine and neck split: generation ${g + 1} of ${gens}, candidate ${p + 1} of ${pop}`;
				yield;
			}
			crowd.sort((a, b) => a.cost - b.cost);
			if (crowd[0].cost < best.cost) best = { v: crowd[0].v.slice(), cost: crowd[0].cost };
			const top = crowd.slice(0, elite);
			mean = mean.map((m, i) => 0.4 * m + 0.6 * top.reduce((s, c) => s + c.v[i], 0) / elite);
			sigma = sigma.map((s, i) => Math.max(0.03, 0.5 * s + 0.5 * Math.sqrt(top.reduce((a, c) => a + (c.v[i] - mean[i]) ** 2, 0) / elite)));
			this.curve.push(best.cost);
		}
		this.mix = toMix(best.v);
		this.progress = 'testing every wall pose under each setting';
		yield;
		const free = this.study(null, DEFAULT), file = this.study(this.file, DEFAULT), anat = this.study(this.anatomy, DEFAULT), trained = this.study(this.anatomy, this.mix);
		this.report = [['no limits', free], ['limits.json as it was', file], ['anatomical ranges', anat], ['ranges + trained spine', trained]].map(([name, s]) => ({ name, ...s }));
		this.persist();
	}

	go() {
		if (!this.poses.length) { this.toast?.('climb the wall and take poses first', 'warn'); return; }
		this.run(this.job(Number(this.genSel.value)));
	}

	async gather() {
		if (this.busy) return;
		this.busy = true;
		try {
			this.progress = 'Tuck is climbing the wall to take poses...';
			this.draw();
			const out = await this.collect(Number(this.chunkSel.value), (k) => { this.progress = `climbing the wall: ${Math.round(k * 100)}%`; this.draw(); });
			this.poses = out.poses.map(p => ({ y: p.y, pose: revive(p.pose) }));
			try { localStorage.setItem(Key + '-poses', JSON.stringify(out.poses)); } catch { /* too big or blocked: this session only */ }
			this.file = await loadLimits();
			this.progress = `${this.poses.length} poses taken from the wall, up to ${out.reached.toFixed(1)} m${out.sent ? '' : ' (the climb stopped there)'}`;
			this.shown = 0;
			this.slider.max = Math.max(0, this.poses.length - 1);
			this.slider.value = 0;
			this.toast?.(`form lab: ${this.poses.length} poses off the wall`, 'good');
		} catch (e) { this.progress = `could not climb the wall: ${e.message}`; } finally { this.busy = false; this.draw(); }
	}

	async run(gen) {
		if (this.busy) return;
		this.busy = true;
		this.pause = false;
		try {
			for (;;) {
				const t0 = performance.now();
				let done = false;
				while (performance.now() - t0 < 14) { if (gen.next().done) { done = true; break; } }
				this.draw();
				if (done || !this.active) break;
				while (this.pause && this.active) await new Promise(r => setTimeout(r, 120));
				await new Promise(r => setTimeout(r, 0));
			}
			this.progress = 'done';
			this.toast?.('form lab: trained and tested on the wall poses', 'good');
		} finally { this.busy = false; this.draw(); }
	}

	persist() { try { localStorage.setItem(Key, JSON.stringify({ mix: this.mix, report: this.report })); } catch { /* this session only */ } }

	// ---------------------------------------------------------------- applying
	ask() {
		if (!this.mix) return;
		if (!this.armed) { this.armed = true; this.applyBtn.textContent = 'really replace limits.json?'; setTimeout(() => { this.armed = false; this.applyBtn.textContent = 'apply ranges + trained spine'; }, 5000); return; }
		this.armed = false;
		this.applyBtn.textContent = 'apply ranges + trained spine';
		this.apply();
	}
	async apply() {
		const set = JSON.parse(JSON.stringify(this.anatomy)), mix = { ...this.mix };
		this.onApply?.(set, mix);
		this.file = set;
		try {
			const r = await fetch('/dev/limits', { method: 'POST', body: JSON.stringify({ version: 1, limits: set, mix }) });
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `error ${r.status}`);
			const back = await loadLimits(), m = await loadMix();
			const ok = JSON.stringify(back) === JSON.stringify(set) && JSON.stringify(m) === JSON.stringify(mix);
			this.toast?.(ok ? 'anatomical limits and the trained spine saved to limits.json and checked' : 'saved, but the file read back differently', ok ? 'good' : 'warn');
		} catch (e) { this.toast?.(`on the characters for now; not written to limits.json (${e.message})`, 'warn'); }
	}

	// ---------------------------------------------------------------- the window
	panel() {
		document.head.append(el('style', { textContent: `
#formlab{position:fixed;inset:0;z-index:60;background:rgba(14,15,18,.95);color:#f3efe6;font:13px ui-rounded,system-ui,sans-serif;display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:16px;padding:16px;overflow:auto}
#formlab[hidden]{display:none}
#formlab h2{margin:12px 0 4px;font-size:18px;color:#f6d3bd}
#formlab h2:first-child{margin-top:0;font-size:20px}
#formlab p,#formlab small{color:rgba(243,239,230,.7);margin:4px 0;display:block}
#formlab button,#formlab select{font:inherit;background:#2a2d34;color:#f3efe6;border:1px solid #444a55;border-radius:10px;padding:7px 12px;cursor:pointer}
#formlab button:disabled{opacity:.4;cursor:default}
#formlab button.main{background:#f6d3bd;color:#15151a;border-color:#f6d3bd;font-weight:700}
#formlab .row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;align-items:center}
#formlab canvas{background:#1d1f24;border-radius:12px;width:100%;display:block;margin:6px 0}
#formlab table{border-collapse:collapse;width:100%;font:12px ui-monospace,Menlo,monospace}
#formlab td,#formlab th{padding:3px 6px;text-align:right;border-bottom:1px solid #2c3037}
#formlab th:first-child,#formlab td:first-child{text-align:left}
#formlab .good{color:#6fcf8c}#formlab .bad{color:#e0594a}
#formlab input[type=range]{width:100%}
` }));
		this.root = el('div', { id: 'formlab', hidden: true });
		const left = el('div'), right = el('div');
		this.chunkSel = el('select');
		for (const [v, t] of [[3, 'a short climb: 30 m'], [6, 'a long climb: 60 m'], [12, 'a very long climb: 120 m']]) this.chunkSel.append(el('option', { value: v, textContent: t }));
		this.genSel = el('select');
		for (const [v, t] of [[8, 'quick: 8 generations'], [14, 'normal: 14'], [24, 'long: 24']]) this.genSel.append(el('option', { value: v, textContent: t }));
		this.genSel.value = 14;
		this.gatherBtn = el('button', { className: 'main', textContent: 'climb the wall and take poses', onclick: () => this.gather() });
		this.trainBtn = el('button', { className: 'main', textContent: 'train and test', onclick: () => this.go() });
		this.applyBtn = el('button', { textContent: 'apply ranges + trained spine', onclick: () => this.ask() });
		this.status = el('p');
		this.front = el('canvas', { width: 380, height: 300 });
		this.slider = el('input', { type: 'range', min: 0, max: 0, value: 0, oninput: () => { this.shown = Number(this.slider.value); this.draw(); } });
		this.curveBox = el('canvas', { width: 380, height: 100 });
		this.out = el('div');
		left.append(
			el('h2', { textContent: 'form lab' }),
			el('p', { textContent: 'trains on realistic bending, flexion and rotation, on the wall itself. the AI climbs the endless wall, every joint obeys anatomical ranges from the biomechanics literature, and it learns how the spine and neck should share a turn so the hands and feet stay on their holds and the body stays relaxed.' }),
			el('div', { className: 'row' }, this.chunkSel, this.gatherBtn),
			el('div', { className: 'row' }, this.genSel, this.trainBtn),
			el('div', { className: 'row' }, this.applyBtn, el('button', { textContent: 'pause / go', onclick: () => { this.pause = !this.pause; } }), el('button', { textContent: 'close', onclick: () => this.close() })),
			this.status, this.front, this.slider,
			el('small', { textContent: 'a pose off the wall, front and side: white is the body under the anatomical ranges, grey the same pose with no limits at all. drag to step through the poses.' }),
			this.curveBox, el('small', { textContent: 'the training cost of the best spine split, by generation (lower is better).' }),
		);
		right.append(this.out);
		this.root.append(left, right);
		document.body.append(this.root);
	}

	async open() {
		if (!this.ready) { this.toast?.('form lab: loading the skeleton', 'good'); await this.build(); }
		this.file = await loadLimits();
		this.slider.max = Math.max(0, this.poses.length - 1);
		this.active = true;
		this.root.hidden = false;
		this.draw();
	}
	close() { this.active = false; this.root.hidden = true; this.pause = false; }

	// the lines of the body now on the skeleton
	lines() {
		const f = this.figure, at = (n) => { const e = f.bones[n].matrixWorld.elements; return [e[12], e[13], e[14]]; };
		const chain = [['Hip', 'Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'NeckTwist02', 'Head'], ...['R', 'L'].flatMap(s => [[`${s}_Clavicle`, `${s}_Upperarm`, `${s}_Forearm`, `${s}_Hand`], [`${s}_Thigh`, `${s}_Calf`, `${s}_Foot`, `${s}_ToeBase`]])];
		return chain.map(c => c.map(at));
	}

	draw() {
		if (!this.active) return;
		this.status.textContent = this.progress ?? (this.poses.length ? '' : 'press "climb the wall and take poses"');
		this.gatherBtn.disabled = this.busy; this.trainBtn.disabled = this.busy || !this.poses.length;
		this.applyBtn.disabled = !this.mix;
		const g = this.front.getContext('2d');
		g.clearRect(0, 0, 380, 300);
		const entry = this.poses[this.shown];
		if (entry && !this.busy) {
			const mix = this.mix ?? DEFAULT;
			this.replay(entry.pose, null, mix);
			const freeLines = this.lines();
			this.replay(entry.pose, this.anatomy, mix);
			const lines = this.lines();
			const all = [...freeLines.flat(), ...lines.flat()];
			const xs = all.map(p => p[0]), ys = all.map(p => p[1]), zs = all.map(p => p[2]);
			const scale = 250 / Math.max(1.4, Math.max(...ys) - Math.min(...ys));
			const view = (ox, key, label) => {
				const cs = key === 'x' ? xs : zs, mid = (Math.max(...cs) + Math.min(...cs)) / 2;
				const px = (p) => ox + 95 + ((key === 'x' ? p[0] : p[2]) - mid) * scale, py = (p) => 285 - (p[1] - Math.min(...ys)) * scale;
				for (const [ls, color] of [[freeLines, '#6c7380'], [lines, '#f3efe6']]) {
					g.lineWidth = 3; g.lineCap = 'round'; g.strokeStyle = color;
					for (const line of ls) { g.beginPath(); line.forEach((p, j) => j ? g.lineTo(px(p), py(p)) : g.moveTo(px(p), py(p))); g.stroke(); }
				}
				g.fillStyle = 'rgba(243,239,230,.5)'; g.font = '12px system-ui'; g.fillText(label, ox + 8, 16);
			};
			view(0, 'x', 'front'); view(190, 'z', `side · ${entry.y.toFixed(1)} m up`);
		}
		const c = this.curveBox.getContext('2d');
		c.clearRect(0, 0, 380, 100);
		if (this.curve.length > 1) {
			const hi = Math.max(...this.curve), lo = Math.min(...this.curve);
			c.strokeStyle = '#f6d3bd'; c.lineWidth = 2; c.beginPath();
			this.curve.forEach((v, i) => { const x = 6 + i / (this.curve.length - 1) * 368, y = 92 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 80; i ? c.lineTo(x, y) : c.moveTo(x, y); });
			c.stroke();
		}
		this.out.replaceChildren();
		if (this.report) {
			const t = el('table'); t.append(el('tr', {}, ...['on the wall poses', 'on hold', 'every limb', 'miss cm', 'worst cm', 'past range', 'in wall', 'strain', 'knee°', 'elbow°'].map(h => el('th', { textContent: h }))));
			const bestStrain = Math.min(...this.report.slice(1).map(r => r.strain));
			for (const r of this.report) t.append(el('tr', {}, el('td', { textContent: r.name }), el('td', { textContent: `${round(r.reach * 100)}%` }), el('td', { textContent: `${round(r.every * 100)}%` }), el('td', { textContent: r.miss.toFixed(2) }), el('td', { textContent: r.worst.toFixed(1) }), el('td', { textContent: `${round(r.stretched * 100)}%` }), el('td', { className: r.clip > 0.02 ? 'bad' : 'good', textContent: `${round(r.clip * 100)}%` }), el('td', { className: r.strain === bestStrain ? 'good' : '', textContent: r.strain.toFixed(2) }), el('td', { textContent: round(r.knee) }), el('td', { textContent: round(r.elbow) })));
			this.out.append(el('h2', { textContent: 'how it performed' }), t, el('small', { textContent: 'on hold: limbs that land within 1.5 cm of where the climber aimed. in wall: poses where a knee or elbow is less than 2 cm clear of the wall. every limb: poses where all four do. past range: poses where the sim asked for a reach no body can make within the ranges, so the joints were stretched just far enough to keep the hold. knee and elbow: the most they folded, in degrees (a person folds a knee 135-155 and an elbow 145-150).' }));
			if (this.mix) this.out.append(el('p', { textContent: `trained split: the waist takes ${round(this.mix.waist * 100)}% and the mid spine ${round(this.mix.spine01 * 100)}% of the turn from pelvis to chest; the lower neck ${round(this.mix.neck1 * 100)}% and the mid neck ${round(this.mix.neck2 * 100)}% of the turn from chest to face (it was 35, 70, 35, 65).` }));
		}
		if (this.needs) {
			const t = el('table'); t.append(el('tr', {}, ...['joint', 'front', 'back', 'out', 'in', 'twist'].map(h => el('th', { textContent: h }))));
			for (const n of this.names) {
				const need = this.needs[n], lim = this.anatomy[n];
				const cell = (a, b) => el('td', { textContent: `${round(a)} / ${b}`, className: a > b * 0.95 ? 'bad' : '' });
				t.append(el('tr', {}, el('td', { textContent: n }), cell(need.fwd, lim.fwd), cell(need.back, lim.back), cell(need.out, lim.out), cell(need.inn, lim.inn), el('td', { textContent: `${round(need.twist[0])}..${round(need.twist[1])} / ±${lim.twist[1]}` })));
			}
			this.out.append(el('h2', { textContent: 'what the wall asks of each joint' }), el('small', { textContent: 'degrees from rest: the 97th percentile of the wall poses with no limits, then the anatomical limit. red: the wall asks for nearly all of the joint\'s range.' }), t);
		}
	}
}
