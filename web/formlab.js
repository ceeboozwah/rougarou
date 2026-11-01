// the form lab (F6, Option + J, or Settings -> tools): an AI mode that trains on realistic limb and joint bending, flexion and rotation.
//
// the learner drives the climber's real skeleton (figure.js, forward kinematics on its bones, the same joint frames limits.js measures with). each task is a
// climbing stance: a target for each hand and each foot, around the body. the learner searches the 57 numbers of a pose (swing toward the front, swing out,
// and twist, for each of 19 joints) with the cross-entropy method, rewarded for putting the hands and feet on their targets and punished for discomfort:
// a joint near the end of its anatomical range, a shoulder blade that does not follow the arm (scapulohumeral rhythm), a spine that bends all in one place.
// the anatomical ranges are the textbook ones in limits.js (the hard walls); comfort is inside 70% of them.
//
// what it learns is the envelope of the poses it settled on across many tasks, joint by joint: how far each one went toward the front, back, out, in and
// both ways of twist, plus the shoulder rhythm and how the spine shared a bend. that becomes a limit set (the same kind the pose editor writes). it is then
// tested on tasks it has not seen against no limits and the textbook limits: how many stances it reaches, how far off it misses, and how natural the poses are.
// Apply puts the learned limits on the characters and, after a second press, writes limits.json.

import * as THREE from 'three';
import { Figure } from './figure.js';
import { jointFrame, measure, clampRel, reach, humanDefaults, loadLimits } from './limits.js';

const V = THREE.Vector3, Q = THREE.Quaternion;
const D2R = Math.PI / 180;
const arc = (a, b) => new Q().setFromUnitVectors(a, b);
const Arms = ['Clavicle', 'Upperarm', 'Forearm', 'Hand'], Legs = ['Thigh', 'Calf', 'Foot'];
export const Joints = ['Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'Head', ...['R', 'L'].flatMap(s => [...Arms.map(a => `${s}_${a}`), ...Legs.map(l => `${s}_${l}`)])];
const Ends = ['R_Hand', 'L_Hand', 'R_Foot', 'L_Foot'];
const HIT = 0.05;
const COMFORT = 0.7;
const Key = 'rougarou-formlab';

function rng(seed) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const pct = (list, p) => { if (!list.length) return 0; const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
const round = (v) => Math.round(v);

export class FormLab {
	constructor({ toast, onApply }) {
		Object.assign(this, { toast, onApply });
		this.active = false;
		this.ready = false;
		this.human = humanDefaults();
		this.learned = null;
		this.report = null;
		this.curve = [];
		this.samples = {};
		this.rhythm = null;
		this.share = null;
		this.pause = false;
		this.busy = false;
		this.best = null;
		this.armed = false;
		try { const s = JSON.parse(localStorage.getItem(Key) || 'null'); if (s?.learned) { this.learned = s.learned; this.report = s.report; this.rhythm = s.rhythm; this.share = s.share; } } catch { /* none */ }
	}

	async build() {
		this.figure = await Figure.load('./assets/character/climber.glb', { limits: false });
		const f = this.figure;
		this.frames = Joints.map(n => {
			const fr = jointFrame(f, n);
			return { ...fr, D: new V().crossVectors(fr.F, fr.T).normalize(), E: new V().crossVectors(fr.S, fr.T).normalize() };
		});
		this.m = Joints.map(() => ({ theta: 0, phi: 0, twist: 0 }));
		this.panel();
		this.ready = true;
	}

	// ---------------------------------------------------------------- the skeleton
	// pose X (57 numbers) onto the bones, each joint held to Lims; fills this.m with how far each joint is turned
	pose(x, lims) {
		const f = this.figure;
		for (let i = 0; i < Joints.length; i++) {
			const fr = this.frames[i], name = Joints[i];
			const a = x[i * 3], b = x[i * 3 + 1], t = x[i * 3 + 2];
			const theta = Math.hypot(a, b) * D2R, phi = Math.atan2(b, a);
			const T2 = fr.T.clone().multiplyScalar(Math.cos(theta)).addScaledVector(fr.D, Math.sin(theta) * Math.cos(phi)).addScaledVector(fr.E, Math.sin(theta) * Math.sin(phi)).normalize();
			let q = arc(fr.T, T2).multiply(new Q().setFromAxisAngle(fr.T, t * D2R / fr.side));
			const lim = lims?.[name];
			if (lim) q = clampRel(q, fr, lim).q;
			const m = measure(q, fr);
			const mine = this.m[i];
			mine.theta = m.theta; mine.phi = m.phi; mine.twist = m.twist;
			f.bones[name].quaternion.copy(f.rest[name].local).multiply(q);
		}
		f.root.updateMatrixWorld(true);
	}

	at(name) { const e = this.figure.bones[name].matrixWorld.elements; return new V(e[12], e[13], e[14]); }

	// how far from comfortable the pose now on the bones is (0 is relaxed): ranges, shoulder rhythm, the spine sharing its bend
	discomfort() {
		let d = 0;
		for (let i = 0; i < Joints.length; i++) {
			const name = Joints[i], ref = this.human[name], m = this.m[i];
			if (!ref) continue;
			const r = m.theta / reach(ref, m.phi * D2R);
			if (r > COMFORT) d += ((r - COMFORT) / (1 - COMFORT)) ** 2;
			const tw = m.twist >= 0 ? m.twist / (ref.twist?.[1] || 180) : m.twist / (ref.twist?.[0] || -180);
			if (tw > COMFORT) d += ((tw - COMFORT) / (1 - COMFORT)) ** 2 * 0.6;
		}
		// the shoulder blade follows the arm: raising it much past the arm's own height is not how a shoulder moves
		for (const s of ['R', 'L']) {
			const up = this.at(`${s}_Upperarm`), el = this.at(`${s}_Forearm`);
			const elevation = Math.acos(Math.max(-1, Math.min(1, el.clone().sub(up).normalize().dot(new V(0, -1, 0))))) / D2R;
			const clav = this.m[Joints.indexOf(`${s}_Clavicle`)].theta;
			const ease = 0.3 * Math.max(0, elevation - 30) + 8;
			if (clav > ease) d += ((clav - ease) / 8) ** 2;
		}
		const sp = ['Waist', 'Spine01', 'Spine02'].map(n => this.m[Joints.indexOf(n)].theta);
		const mean = (sp[0] + sp[1] + sp[2]) / 3;
		d += 0.5 * (sp.reduce((s, v) => s + (v - mean) ** 2, 0) / 3) / 64;
		return d;
	}

	// a stance: a target for each hand and foot. they come from a random pose the textbook limits allow (arms and legs spread around the body), so
	// every task can be reached, and the search then has to find a pose of its own, as natural as it can, that gets there
	stance(r) {
		const x = new Float32Array(Joints.length * 3);
		Joints.forEach((n, i) => {
			const h = this.human[n];
			if (!h) return;
			// climbing goes much further than standing: arms overhead, a knee up at the chest
			const ang = (k) => Math.min(h[k], 130) * 0.5;
			x[i * 3] = gauss(r) * (ang('fwd') + ang('back')) * 0.6; x[i * 3 + 1] = gauss(r) * (ang('out') + ang('inn')) * 0.6;
			x[i * 3 + 2] = gauss(r) * 0.3 * Math.min(h.twist[1], 60);
		});
		this.pose(x, this.human);
		const targets = {};
		for (const e of Ends) targets[e] = this.at(e);
		return targets;
	}

	// the cost of pose X for a task: misses in units of 4 cm, squared, plus discomfort
	cost(x, targets, lims, mu) {
		this.pose(x, lims);
		let miss = 0, worst = 0;
		for (const e of Ends) { const dist = this.at(e).distanceTo(targets[e]); miss += (dist / 0.04) ** 2; worst = Math.max(worst, dist); }
		const disc = this.discomfort();
		return { total: miss + mu * disc, miss: worst, disc };
	}

	// the cross-entropy search for one task, one generation a step
	*search(targets, lims, mu, rand, { gens = 40, pop = 80, elite = 12 } = {}) {
		const n = Joints.length * 3;
		let mean = new Float32Array(n), sigma = new Float32Array(n).fill(0);
		for (let i = 0; i < Joints.length; i++) { sigma[i * 3] = sigma[i * 3 + 1] = 28; sigma[i * 3 + 2] = 18; }
		let best = null;
		for (let g = 0; g < gens; g++) {
			const crowd = [];
			for (let p = 0; p < pop; p++) {
				const x = new Float32Array(n);
				for (let k = 0; k < n; k++) x[k] = mean[k] + sigma[k] * gauss(rand);
				if (g === 0 && p === 0) x.fill(0);
				const c = this.cost(x, targets, lims, mu);
				crowd.push({ x, ...c });
			}
			crowd.sort((a, b) => a.total - b.total);
			if (!best || crowd[0].total < best.total) best = crowd[0];
			for (let k = 0; k < n; k++) {
				let m = 0;
				for (let e = 0; e < elite; e++) m += crowd[e].x[k];
				m /= elite;
				let v = 0;
				for (let e = 0; e < elite; e++) v += (crowd[e].x[k] - m) ** 2;
				mean[k] = 0.3 * mean[k] + 0.7 * m;
				sigma[k] = Math.max(1.5, 0.4 * sigma[k] + 0.6 * Math.sqrt(v / elite));
			}
			yield;
		}
		this.cost(best.x, targets, lims, mu);
		return { x: best.x, total: best.total, miss: best.miss, disc: best.disc, m: this.m.map(m => ({ ...m })) };
	}

	// ---------------------------------------------------------------- training
	*train(count) {
		const rand = rng(1234);
		this.samples = {};
		this.curve = [];
		let hits = 0, tasks = 0, discSum = 0;
		this.rhythmData = { arm: [], clav: [] };
		for (let t = 0; t < count; t++) {
			const targets = this.stance(rand);
			// no hard walls while it learns: the strain penalty alone steers it, so where it settles shows how far a body goes when it moves naturally
			const run = this.search(targets, null, 1.5, rand);
			let step;
			while (!(step = run.next()).done) yield;
			const out = step.value;
			tasks++;
			const ok = out.miss < HIT;
			if (ok) {
				hits++;
				discSum += out.disc;
				Joints.forEach((n, i) => (this.samples[n] ??= []).push(out.m[i]));
			}
			this.pose(out.x, null);
			this.best = this.snapshot(targets);
			this.curve.push({ reach: hits / tasks, disc: hits ? discSum / hits : 0 });
			this.progress = `training: stance ${t + 1} of ${count}, ${hits} reached`;
			yield;
		}
	}

	// the envelope of what it settled on, joint by joint, as a limit set
	fit() {
		const out = {};
		const margin = 1.12;
		for (const name of Joints) {
			const list = this.samples[name] ?? [], base = this.human[name];
			if (!base) continue;
			if (list.length < 12) { out[name] = JSON.parse(JSON.stringify(base)); continue; }
			const dir = { fwd: [], back: [], out: [], inn: [] };
			for (const m of list) {
				const p = m.phi * D2R, c = Math.cos(p), s = Math.sin(p);
				if (c > 0.38) dir.fwd.push(m.theta);
				if (c < -0.38) dir.back.push(m.theta);
				if (s > 0.38) dir.out.push(m.theta);
				if (s < -0.38) dir.inn.push(m.theta);
			}
			const lim = { twist: [0, 0] };
			for (const k of ['fwd', 'back', 'out', 'inn']) {
				const seen = dir[k].length >= 5 ? pct(dir[k], 0.97) * margin : base[k] * 0.5;
				lim[k] = round(Math.min(base[k], Math.max(6, seen)));
			}
			const tw = list.map(m => m.twist);
			lim.twist = [round(Math.max(base.twist[0], Math.min(-4, pct(tw, 0.03) * margin))), round(Math.min(base.twist[1], Math.max(4, pct(tw, 0.97) * margin)))];
			out[name] = lim;
		}
		// the shoulder rhythm: degrees of shoulder-blade lift for each degree of arm elevation, over the stances it settled on
		const rise = [], lift = [];
		for (const s of ['R', 'L']) {
			const u = this.samples[`${s}_Upperarm`] ?? [], c = this.samples[`${s}_Clavicle`] ?? [];
			for (let i = 0; i < Math.min(u.length, c.length); i++) { rise.push(u[i].theta); lift.push(c[i].theta); }
		}
		let num = 0, den = 0;
		for (let i = 0; i < rise.length; i++) { num += rise[i] * lift[i]; den += rise[i] * rise[i]; }
		this.rhythm = den ? num / den : 0;
		const sp = ['Waist', 'Spine01', 'Spine02'].map(n => (this.samples[n] ?? []).reduce((s, m) => s + m.theta, 0) / Math.max(1, (this.samples[n] ?? []).length));
		const total = sp.reduce((a, b) => a + b, 0) || 1;
		this.share = sp.map(v => v / total);
		this.learned = out;
	}

	// the same stance, three ways: no limits, the textbook limits, what it learned. new tasks it has not seen
	*evaluate(count) {
		const rand = rng(98765);
		const conds = [['no limits', null], ['textbook limits', this.human], ['learned limits', this.learned]];
		const sum = conds.map(() => ({ hits: 0, miss: 0, disc: 0, n: 0 }));
		for (let t = 0; t < count; t++) {
			const targets = this.stance(rand);
			for (let c = 0; c < conds.length; c++) {
				const run = this.search(targets, conds[c][1], 0.5, rand, { gens: 40, pop: 80, elite: 12 });
				let step;
				while (!(step = run.next()).done) yield;
				const o = step.value, s = sum[c];
				s.n++; s.miss += o.miss; s.disc += o.disc;
				if (o.miss < HIT) s.hits++;
				if (c === 2) { this.pose(o.x, conds[c][1]); this.best = this.snapshot(targets); }
			}
			this.progress = `testing on new stances: ${t + 1} of ${count}`;
			yield;
		}
		this.report = conds.map(([name], c) => ({ name, reach: sum[c].hits / sum[c].n, miss: sum[c].miss / sum[c].n * 100, disc: sum[c].disc / sum[c].n, natural: 100 * Math.exp(-sum[c].disc / sum[c].n / 6) }));
	}

	// where the joints and the targets are, for the picture
	snapshot(targets) {
		const chain = [['Pelvis', 'Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'Head'], ...['R', 'L'].flatMap(s => [[`${s}_Clavicle`, `${s}_Upperarm`, `${s}_Forearm`, `${s}_Hand`], [`${s}_Thigh`, `${s}_Calf`, `${s}_Foot`, `${s}_ToeBase`]])];
		return { lines: chain.map(c => c.map(n => this.at(n))), targets: Object.values(targets).map(v => v.clone()), hit: Ends.map(e => this.at(e).distanceTo(targets[e]) < HIT) };
	}

	// ---------------------------------------------------------------- the driver
	async run(job) {
		if (this.busy) return;
		this.busy = true;
		this.pause = false;
		try {
			for (const make of job) {
				const gen = make();
				for (;;) {
					const t0 = performance.now();
					let finished = false;
					while (performance.now() - t0 < 12) { if (gen.next().done) { finished = true; break; } }
					this.draw();
					if (finished || !this.active) break;
					while (this.pause && this.active) await new Promise(r => setTimeout(r, 120));
					if (!this.active) return;
					await new Promise(r => setTimeout(r, 0));
				}
				if (!this.active) return;
				if (make.after) make.after();
			}
			this.progress = 'done';
			this.persist();
			this.toast?.('form lab: trained, tested and ready to apply', 'good');
		} finally { this.busy = false; this.draw(); }
	}

	go() {
		const n = Number(this.sizeSel.value);
		const a = () => this.train(n), b = () => this.evaluate(Math.max(24, Math.round(n / 3)));
		a.after = () => this.fit();
		this.run([a, b]);
	}

	persist() { try { localStorage.setItem(Key, JSON.stringify({ learned: this.learned, report: this.report, rhythm: this.rhythm, share: this.share })); } catch { /* this session only */ } }

	// ---------------------------------------------------------------- applying
	ask() {
		if (!this.learned) return;
		if (!this.armed) { this.armed = true; this.applyBtn.textContent = 'really replace limits.json?'; setTimeout(() => { this.armed = false; this.applyBtn.textContent = 'apply learned limits (eased)'; }, 5000); return; }
		this.armed = false;
		this.applyBtn.textContent = 'apply learned limits (eased)';
		this.apply();
	}
	// comfort is a cost, not a wall: climbing goes past where a relaxed body settles (an arm overhead, a knee at the chest), so what is applied is
	// halfway between what it learned and the textbook ranges. the lab's own numbers stay as they were learned
	relaxed() {
		const out = {};
		for (const [n, l] of Object.entries(this.learned)) {
			const h = this.human[n];
			if (!h) { out[n] = l; continue; }
			const mid = (a, b) => round((a + b) / 2);
			out[n] = { fwd: mid(l.fwd, h.fwd), back: mid(l.back, h.back), out: mid(l.out, h.out), inn: mid(l.inn, h.inn), twist: [mid(l.twist[0], h.twist[0]), mid(l.twist[1], h.twist[1])] };
		}
		return out;
	}
	async apply() {
		const set = this.relaxed();
		this.onApply?.(set);
		const body = JSON.stringify({ version: 1, limits: set });
		try {
			const r = await fetch('/dev/limits', { method: 'POST', body });
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `error ${r.status}`);
			const back = await loadLimits();
			this.toast?.(JSON.stringify(back) === JSON.stringify(set) ? 'learned limits saved to limits.json and checked' : 'saved, but the file read back differently', JSON.stringify(back) === JSON.stringify(set) ? 'good' : 'warn');
		} catch (e) { this.toast?.(`on the characters for now; not written to limits.json (${e.message})`, 'warn'); }
	}

	// ---------------------------------------------------------------- the window
	panel() {
		const css = el('style', { textContent: `
#formlab{position:fixed;inset:0;z-index:60;background:rgba(14,15,18,.94);color:#f3efe6;font:13px ui-rounded,system-ui,sans-serif;display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:16px;padding:16px;overflow:auto}
#formlab[hidden]{display:none}
#formlab h2{margin:0 0 4px;font-size:20px;color:#f6d3bd}
#formlab p,#formlab small{color:rgba(243,239,230,.7);margin:4px 0}
#formlab button,#formlab select{font:inherit;background:#2a2d34;color:#f3efe6;border:1px solid #444a55;border-radius:10px;padding:7px 12px;cursor:pointer}
#formlab button.main{background:#f6d3bd;color:#15151a;border-color:#f6d3bd;font-weight:700}
#formlab .row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;align-items:center}
#formlab canvas{background:#1d1f24;border-radius:12px;width:100%;display:block;margin:6px 0}
#formlab table{border-collapse:collapse;width:100%;font:12px ui-monospace,Menlo,monospace}
#formlab td,#formlab th{padding:3px 6px;text-align:right;border-bottom:1px solid #2c3037}
#formlab th:first-child,#formlab td:first-child{text-align:left}
#formlab .good{color:#6fcf8c}#formlab .bad{color:#e0594a}
` });
		document.head.append(css);
		this.root = el('div', { id: 'formlab', hidden: true });
		const left = el('div'), right = el('div');
		this.sizeSel = el('select');
		for (const [v, t] of [[60, 'quick: 60 stances'], [120, 'normal: 120'], [240, 'long: 240']]) this.sizeSel.append(el('option', { value: v, textContent: t }));
		this.sizeSel.value = 120;
		this.applyBtn = el('button', { textContent: 'apply learned limits (eased)', onclick: () => this.ask() });
		this.status = el('p', { textContent: '' });
		this.front = el('canvas', { width: 380, height: 300 });
		this.curveBox = el('canvas', { width: 380, height: 120 });
		this.out = el('div');
		left.append(
			el('h2', { textContent: 'form lab' }),
			el('p', { textContent: 'trains on realistic limb and joint bending, flexion and rotation. it solves climbing stances with the real skeleton, rewarded for reaching and punished for strain, then learns how far each joint goes when a body moves naturally.' }),
			el('div', { className: 'row' }, this.sizeSel, el('button', { className: 'main', textContent: 'train', onclick: () => this.go() }), el('button', { textContent: 'pause / go', onclick: () => { this.pause = !this.pause; } }), this.applyBtn, el('button', { textContent: 'close', onclick: () => this.close() })),
			this.status, this.front, this.curveBox,
			el('small', { textContent: 'top: front and side view of the last stance, targets as rings (green when reached). bottom: share of stances reached (white) and discomfort (red) as it trains.' }),
		);
		right.append(this.out);
		this.root.append(left, right);
		document.body.append(this.root);
	}

	async open() {
		if (!this.ready) { this.toast?.('form lab: loading the skeleton', 'good'); await this.build(); }
		this.active = true;
		this.root.hidden = false;
		this.draw();
	}
	close() { this.active = false; this.root.hidden = true; this.pause = false; }

	draw() {
		if (!this.active) return;
		this.status.textContent = this.progress ?? (this.learned ? 'learned limits from an earlier run are loaded; train again to redo them' : 'press train');
		this.applyBtn.disabled = !this.learned;
		const g = this.front.getContext('2d');
		g.clearRect(0, 0, 380, 300);
		const s = this.best;
		if (s) {
			const view = (ox, key, label) => {
				const px = (v) => ox + 95 + (key === 'x' ? v.x : -v.z) * 95, py = (v) => 280 - v.y * 150;
				g.lineWidth = 3; g.lineCap = 'round';
				s.lines.forEach((line, i) => { g.strokeStyle = i ? (i % 2 ? '#8aa0b8' : '#b6a08a') : '#f3efe6'; g.beginPath(); line.forEach((p, j) => j ? g.lineTo(px(p), py(p)) : g.moveTo(px(p), py(p))); g.stroke(); });
				s.targets.forEach((p, i) => { g.strokeStyle = s.hit[i] ? '#6fcf8c' : '#e0594a'; g.lineWidth = 2; g.beginPath(); g.arc(px(p), py(p), 7, 0, 7); g.stroke(); });
				g.fillStyle = 'rgba(243,239,230,.5)'; g.font = '12px system-ui'; g.fillText(label, ox + 8, 16);
			};
			view(0, 'x', 'front'); view(190, 'z', 'side');
		}
		const c = this.curveBox.getContext('2d');
		c.clearRect(0, 0, 380, 120);
		if (this.curve.length > 1) {
			const peak = Math.max(1, ...this.curve.map(p => p.disc));
			for (const [key, color, scale] of [['reach', '#f3efe6', 1], ['disc', '#e0594a', peak]]) {
				c.strokeStyle = color; c.lineWidth = 2; c.beginPath();
				this.curve.forEach((p, i) => { const x = 6 + i / (this.curve.length - 1) * 368, y = 112 - p[key] / scale * 100; i ? c.lineTo(x, y) : c.moveTo(x, y); });
				c.stroke();
			}
		}
		this.out.replaceChildren();
		if (this.report) {
			const t = el('table'); t.append(el('tr', {}, ...['conditions', 'reached', 'miss cm', 'discomfort', 'natural'].map(h => el('th', { textContent: h }))));
			const top = Math.max(...this.report.map(r => r.natural));
			for (const r of this.report) t.append(el('tr', {}, el('td', { textContent: r.name }), el('td', { textContent: `${round(r.reach * 100)}%` }), el('td', { textContent: r.miss.toFixed(1) }), el('td', { textContent: r.disc.toFixed(2) }), el('td', { className: r.natural === top ? 'good' : '', textContent: `${round(r.natural)}%` })));
			this.out.append(el('h2', { textContent: 'how it performed (new stances)' }), t, el('small', { textContent: 'natural = 100 x e^(-discomfort / 6): ranges, shoulder rhythm and the spine sharing its bend, scored the same way for all three.' }));
		}
		if (this.learned) {
			const t = el('table'); t.append(el('tr', {}, ...['joint', 'front', 'back', 'out', 'in', 'twist'].map(h => el('th', { textContent: h }))));
			for (const n of Joints) {
				const l = this.learned[n], h = this.human[n];
				if (!l || !h) continue;
				const cell = (a, b) => el('td', { textContent: `${a}${a < b ? ` / ${b}` : ''}`, className: a < b ? 'good' : '' });
				t.append(el('tr', {}, el('td', { textContent: n }), cell(l.fwd, h.fwd), cell(l.back, h.back), cell(l.out, h.out), cell(l.inn, h.inn), el('td', { textContent: `${l.twist[0]}..${l.twist[1]}` })));
			}
			this.out.append(el('h2', { textContent: 'what it learned' }), el('small', { textContent: 'degrees from rest. green: tighter than the textbook (learned / textbook).' }), t);
			if (this.rhythm != null) this.out.append(el('p', { textContent: `shoulder rhythm: the shoulder blade lifted ${this.rhythm.toFixed(2)} degrees for each degree the arm turned.` }));
			if (this.share) this.out.append(el('p', { textContent: `the spine shared its bend: waist ${round(this.share[0] * 100)}%, mid ${round(this.share[1] * 100)}%, upper ${round(this.share[2] * 100)}%.` }));
		}
	}
}
