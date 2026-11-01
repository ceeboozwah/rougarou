// the AI as a gym worker: Tuck sets routes. he picks a problem, designs new holds for it (the model, or his own generator without a key), has the
// design rejected or accepted by a solver that really climbs it (a hold no body can reach, a start that cannot hold, a grade far from the one
// asked for), then physically goes and does it: walks to the wall, stands a ladder against it when the hold is above his reach, climbs the ladder
// a rung at a time, takes each hold off and puts it where it goes. then he climbs the new problem to prove it, and revises or puts it back.

import * as THREE from 'three';
import { Vec2, Vec3 } from './sim.js';
import { walkPose, solve } from './climber.js';
import { Ladder, ladderPose, raisePose, workPose } from './ladder.js';
import { solve as solveRoute, features, gradeOf, label, startsHold, withHolds } from './grader.js';
import { floorAt } from './world.js';
import { toThree } from './gym.js';
import { SETTER } from './instructions.js';

const Z = new Vec3(0, 0, 1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const three = (v) => new THREE.Vector3(...toThree(v));
const Kinds = ['jug', 'crimp', 'sloper', 'pinch', 'pocket'];
// how fast things happen: rungs a second on the ladder, and a multiplier on every pause so a watcher is not bored
// a person climbs a ladder at about a rung and a half a second, and a hold goes on or off in a couple of seconds
const RUNGS = 1.4, PACE = 1, TEMPO = 1.25;
// the width of each kind of hold in centimeters, as gym.js draws it
const SIZE = { jug: 22, crimp: 18, sloper: 28, pinch: 20, pocket: 18 };
const WIDE = (h) => (SIZE[h.kind] ?? 20) / 2 * 1.05;
const top = (route) => route.panels.reduce((a, p) => a + p.length, 0);

// a small seeded generator for his own designs
function dice(seed) { let s = seed >>> 0 || 1; return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const Names = {
	slab: ['Slab Happy', 'Hold My Smear', 'Friction Fiction', 'Footwork Fever'],
	steep: ['Hang Time', 'Gravity Check', 'Overhang Overture', 'Pump Fiction'],
	general: ['Jug Life', 'Crimp My Style', 'The Sloper Whisperer', 'Tuck and Roll', 'Beta Than Nothing', 'Reach For It', 'Holdin\' Pattern', 'Send Help'],
};
const Quips = {
	design: ['hm. what if the wall had feelings?', 'let me cook', 'a little chaos, a little jug', 'sketching in my head'],
	ladder: ['ladder time, the best time', 'up we go', 'three points, always three points', 'rung by rung'],
	hold: ['hello gorgeous', 'you go there', 'tighter than a crimp', 'perfect. no notes.'],
	reject: ['bad hold! no. bad.', 'physics said no', 'ok, ok, that gap was rude', 'back to the drawing board'],
	test: ['now we find out', 'moment of truth', 'testing, testing, hold on'],
	done: ['a masterpiece, probably', 'nailed it', 'set and sweaty'],
};
const pick = (list, r = Math.random) => list[Math.floor(r() * list.length)];

export class Setter {
	constructor({ agent, scene, routes, originals, world, brain, memory, hooks }) {
		Object.assign(this, { agent, scene, routes, originals, world, brain, memory, hooks });
		this.ladder = new Ladder(scene);
		this.running = false;
		this.token = 0;
		this.task = null;
		this.carry = null;
		this.sets = 0;
		// the hold in his hand, drawn as a small blob in the hold's color
		this.proxy = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshStandardMaterial({ color: 0xf2a007, roughness: 0.5 }));
		this.proxy.scale.set(1, 0.6, 1.3);
		this.proxy.visible = false;
		scene.add(this.proxy);
	}

	say(text, secs = 3.5) { this.agent.say(text, secs); }

	start() {
		if (this.running) return;
		this.running = true;
		const token = ++this.token;
		(async () => {
			while (this.running && token === this.token) {
				try { await this.cycle(token); } catch (e) { console.warn('setter:', e); await sleep(2500); }
			}
		})();
	}

	stop() {
		this.running = false;
		this.token++;
		this.task = null;
		this.ladder.remove();
		this.proxy.visible = false;
		if (this.carry) { this.carry.hold.carried = false; this.hooks.rebuild(this.carry.index); this.carry = null; }
	}

	live(token) { return this.running && token === this.token; }

	// ---------------------------------------------------------------- one problem, start to finish
	choose() {
		const player = this.agent.player;
		const busy = (i) => player && (player.mode === 'climb' || player.mode === 'mount') && player.route === i;
		const options = this.routes.map((r, i) => i).filter(i => !busy(i));
		// the one set longest ago (or never) goes first
		options.sort((a, b) => (this.memory.data.setAt?.[this.routes[a].name] ?? 0) - (this.memory.data.setAt?.[this.routes[b].name] ?? 0));
		return options[0] ?? -1;
	}

	async cycle(token) {
		const agent = this.agent;
		const index = this.choose();
		if (index < 0) { agent.status = 'no free wall to set'; await sleep(3000); return; }
		const route = this.routes[index];
		agent.index = index;
		const before = route.holds.map(h => ({ point: h.point.copy(), kind: h.kind, pull: h.pull.copy(), seed: h.seed }));
		const oldName = route.name, oldGrade = route.grade;
		this.say(`${pick(Quips.design)}`);
		agent.status = `looking at ${route.name}`;
		// walk to the wall first and look the problem over
		await this.go(token, this.standFor(route, new Vec2(0, 1.8)));
		let design = null, feedback = [];
		for (let round = 0; round < 3 && this.live(token); round++) {
			agent.status = round ? `redesigning ${route.name}` : `designing ${route.name}`;
			design = await this.design(route, feedback, design);
			if (design.ok) break;
			feedback = design.reasons;
			this.say(pick(Quips.reject));
			await sleep(300);
		}
		if (!this.live(token)) return;
		if (!design?.ok) { this.say('no set I would sign. leaving it be.'); this.memory.data.setAt = { ...this.memory.data.setAt, [route.name]: Date.now() }; this.memory.save(); await sleep(2000); return; }
		this.say(design.quip || `meet "${design.name}"`);
		await this.build(token, index, design.holds);
		if (!this.live(token)) return;
		route.name = design.name;
		route.grade = design.grade;
		this.memory.reset(oldName);
		this.memory.reset(route.name);
		this.hooks.commit(index, { by: 'Tuck', name: route.name, grade: route.grade });
		this.hooks.retag(index);
		// the proof: climb it
		this.say(pick(Quips.test));
		const proof = await this.test(token, index);
		if (!this.live(token)) return;
		if (!proof.sent) {
			this.say('it bit me. fixing it.');
			const stuck = await this.solveStuck(route);
			const again = await this.design(route, [`Tuck could not send it in ${proof.tries} real attempts: ${proof.why}. ${stuck}`], design);
			if (again.ok) {
				await this.build(token, index, again.holds);
				route.name = again.name;
				route.grade = again.grade;
				this.memory.reset(route.name);
				this.hooks.commit(index, { by: 'Tuck', name: route.name, grade: route.grade });
				this.hooks.retag(index);
				const second = await this.test(token, index);
				if (!second.sent) await this.revert(token, index, before, oldName, oldGrade);
			} else await this.revert(token, index, before, oldName, oldGrade);
		} else this.say(pick(Quips.done));
		this.memory.data.setAt = { ...this.memory.data.setAt, [route.name]: Date.now() };
		this.memory.save();
		this.sets++;
		await sleep(600);
	}

	async revert(token, index, before, name, grade) {
		this.say('putting it back how it was. no hard feelings.');
		await this.build(token, index, before);
		const route = this.routes[index];
		route.name = name;
		route.grade = grade;
		this.hooks.commit(index, { by: 'Tuck', name, grade });
		this.hooks.retag(index);
	}

	async solveStuck(route) {
		const res = await solveRoute(withHolds(route, route.holds));
		return res.sent ? 'The solver says it can be sent, so the real attempts were just unlucky.' : `The solver stops near ${JSON.stringify(res.stuck)}.`;
	}

	// ---------------------------------------------------------------- designing and checking
	describeWall(route) {
		const panels = route.panels.map((p, i) => `panel ${i}: from y=${p.start.toFixed(2)} for ${p.length.toFixed(2)} m, ${(Math.atan2(-p.out.z, Math.hypot(p.out.x, p.out.y)) * 57.3).toFixed(0)} degrees ${-p.out.z > 0.05 ? 'overhanging' : -p.out.z < -0.05 ? 'slab' : 'vertical'}`);
		return [`WALL ${route.name}: ${top(route).toFixed(2)} m tall along the surface, x between -2.6 and 2.6.`, ...panels,
			`CURRENT GRADE ${route.grade}.`, 'CURRENT HOLDS (index: kind at (x, y) pull):', ...route.holds.map((h, i) => `${i}: ${h.kind} at (${h.point.x.toFixed(2)}, ${h.point.y.toFixed(2)}) pull (${h.pull.x.toFixed(1)}, ${h.pull.y.toFixed(1)})`)].join('\n');
	}

	// ---------------------------------------------------------------- holds must not touch
	// the holds already on the wall that a new hold could run into: the scattered ones (nearest to the problem's wall only)
	decorNear(route) {
		const all = this.hooks.decor?.() ?? [];
		const mid = route.map(new Vec2(0, top(route) / 2), 0);
		return all.filter(d => d.at.dist(mid) < 520);
	}

	// every pair that overlaps, in words
	clashes(route, holds, decor = this.decorNear(route)) {
		const out = [];
		const worlds = holds.map(h => route.map(h.point, 0));
		for (let i = 0; i < holds.length; i++) {
			for (let j = 0; j < i; j++) {
				const need = WIDE(holds[i]) + WIDE(holds[j]) + 2;
				if (worlds[i].dist(worlds[j]) < need) out.push(`holds ${j} and ${i} clip into each other (${worlds[i].dist(worlds[j]).toFixed(0)} cm apart, they need ${need.toFixed(0)})`);
			}
			for (const d of decor) if (worlds[i].dist(d.at) < WIDE(holds[i]) + d.size / 2 * 1.05 + 2) { out.push(`hold ${i} sits on a hold that is already on the wall at (${holds[i].point.x.toFixed(2)}, ${holds[i].point.y.toFixed(2)})`); break; }
			// a fold in the wall: a hold over it would stick into the next panel
			const r = WIDE(holds[i]) / 100;
			for (const p of route.panels.slice(1)) if (Math.abs(holds[i].point.y - p.start) < r + 0.015) { out.push(`hold ${i} straddles the fold in the wall at y=${p.start.toFixed(2)}`); break; }
		}
		return out;
	}

	// nudge holds apart, off the scattered ones and off the folds until nothing touches (it may not find room: the check still has the last word)
	repair(route, holds) {
		const decor = this.decorNear(route), height = top(route);
		for (let pass = 0; pass < 14; pass++) {
			let moved = false;
			holds.forEach((h, i) => {
				const r = WIDE(h) / 100;
				let p = h.point;
				const push = (away, need) => { p = new Vec2(p.x + away.x * need, p.y + away.y * need); moved = true; };
				for (let j = 0; j < i; j++) {
					const q = holds[j].point, gap = p.sub(q), d = gap.len(), need = (WIDE(h) + WIDE(holds[j]) + 2.5) / 100;
					if (d < need) push(d > 1e-3 ? gap.norm() : new Vec2(1, 0), need - d);
				}
				const panel = route.at(p.y), here = route.map(p, 0);
				for (const d of decor) {
					const gap = d.at.sub(here), d3 = gap.len(), need = WIDE(h) + d.size / 2 * 1.05 + 2.5;
					if (d3 >= need) continue;
					const away = new Vec2(-gap.dot(panel.right), -gap.dot(panel.up)).norm();
					push(away.len() > 0 ? away : new Vec2(0, 1), (need - d3) / 100);
				}
				for (const f of route.panels.slice(1)) if (Math.abs(p.y - f.start) < r + 0.02) { p = new Vec2(p.x, p.y >= f.start ? f.start + r + 0.025 : f.start - r - 0.025); moved = true; }
				h.point = new Vec2(clamp(p.x, -2.55, 2.55), clamp(p.y, Math.max(0.3, r + 0.08), height - r - 0.04));
			});
			if (!moved) break;
		}
		return holds;
	}

	// a design: from the model if there is one, else his own generator, then checked by the solver; { ok, holds, name, grade, quip, reasons }
	async design(route, feedback, previous) {
		const target = parseInt(String(route.grade).replace(/\D/g, ''), 10) || 0;
		let draft = null;
		if (this.brain.key) {
			const prompt = [this.describeWall(route), `TARGET GRADE: V${target}`, previous ? `YOUR PREVIOUS DESIGN: ${JSON.stringify(previous.raw ?? previous.holds)}` : '', feedback.length ? `REJECTED BECAUSE: ${feedback.join(' | ')}` : '', `MAKE IT NOTICEABLY DIFFERENT from the current holds: new positions for at least a third of them, a new rhythm and crux, a new name.`, this.memory.data.general.length ? `THINGS YOU HAVE LEARNED: ${this.memory.data.general.slice(-4).join(' | ')}` : ''].filter(Boolean).join('\n');
			const answer = await this.brain.ask(prompt, { system: SETTER, timeout: 30000 });
			draft = this.parse(answer, route, target);
		}
		let reasons = [];
		if (draft) {
			const checked = await this.check(route, draft.holds, target);
			if (checked.ok) return { ...draft, ...checked, ok: true };
			reasons = checked.reasons;
			draft.raw = answer_(draft);
		}
		// his own generator: try a handful of seeds and keep the first that passes
		const salt = Math.floor(Math.random() * 1e6);
		let lastReasons = reasons;
		for (let k = 0; k < 14; k++) {
			const holds = this.repair(route, this.generate(route, target, salt + k));
			const checked = await this.check(route, holds, target);
			if (checked.ok) {
				return { ok: true, holds, name: this.nameFor(route, target, salt + k), grade: checked.grade, quip: pick(Quips.design), features: checked.features, raw: null };
			}
			lastReasons = checked.reasons;
		}
		return { ok: false, reasons: [...reasons, ...lastReasons].slice(0, 5), holds: draft?.holds ?? route.holds, raw: draft ? answer_(draft) : null };
	}

	nameFor(route, target, seed) {
		const steep = Math.max(0, ...route.panels.map(p => -p.out.z)) > 0.3;
		return pick([...(steep ? Names.steep : Names.slab), ...Names.general], dice(seed));
	}

	// the model's answer as holds, cleaned up: kinds and pulls made legal, positions put on the wall
	parse(answer, route, target) {
		if (!answer || !Array.isArray(answer.holds) || answer.holds.length < 9) return null;
		const height = top(route);
		const holds = answer.holds.slice(0, 26).map((h, i) => {
			const kind = Kinds.includes(h.kind) ? h.kind : 'jug';
			let px = Array.isArray(h.pull) ? Number(h.pull[0]) : 0, py = Array.isArray(h.pull) ? Number(h.pull[1]) : -1;
			if (!Number.isFinite(px) || !Number.isFinite(py) || Math.hypot(px, py) < 0.2) { px = 0; py = -1; }
			const pull = new Vec2(px, py).norm();
			return { point: new Vec2(clamp(Number(h.x) || 0, -2.6, 2.6), clamp(Number(h.y) || 1, 0.3, height - 0.12)), kind, pull, seed: i + 100 };
		});
		const mid = holds.slice(4, -1).sort((a, b) => a.point.y - b.point.y);
		return { holds: this.repair(route, [...holds.slice(0, 4), ...mid, holds[holds.length - 1]]), name: String(answer.name ?? '').slice(0, 24) || this.nameFor(route, target, 1), grade: `V${Math.max(0, parseInt(String(answer.grade).replace(/\D/g, ''), 10) || target)}`, quip: String(answer.quip ?? '').slice(0, 90) };
	}

	// the rules of the wall and the solver: the reasons a design is thrown out, in words he can use
	async check(route, holds, target) {
		const reasons = [];
		const height = top(route);
		if (holds.length < 9 || holds.length > 26) reasons.push(`${holds.length} holds: use 9 to 24`);
		for (let i = 0; i < holds.length; i++) {
			const h = holds[i];
			if (h.point.y > height - 0.1 || h.point.y < 0.25 || Math.abs(h.point.x) > 2.7) reasons.push(`hold ${i} is off the wall at (${h.point.x.toFixed(2)}, ${h.point.y.toFixed(2)})`);
		}
		const clash = this.clashes(route, holds);
		if (clash.length) return { ok: false, reasons: clash.slice(0, 5) };
		const finish = holds[holds.length - 1];
		if (holds.some(h => h.point.y > finish.point.y + 0.05)) reasons.push('the top hold must be the highest on the wall');
		if (reasons.length) return { ok: false, reasons: reasons.slice(0, 5) };
		// a refresh, not a copy: at least a third of the holds have to be somewhere new
		const moved = holds.filter((h, i) => !route.holds[i] || h.point.dist(route.holds[i].point) > 0.15 || h.kind !== route.holds[i].kind).length;
		if (moved < holds.length / 3) return { ok: false, reasons: [`too much like the current set: only ${moved} of ${holds.length} holds are new. Design a noticeably different problem (change at least a third of the holds, a new rhythm and crux)`] };
		const copy = withHolds(route, holds);
		if (!startsHold(copy)) return { ok: false, reasons: ['the start holds cannot hold a body: bring the hands closer together, jugs only, and put the feet under them'] };
		const result = await solveRoute(copy);
		if (!result.sent) {
			const s = result.stuck;
			return { ok: false, reasons: [`impossible as set: the solver climbed to about y=${s?.y} and stopped with ${s?.safeOptions ?? 0} safe moves. Nearest holds above: ${(s?.next ?? []).join('; ')}. Bring the next holds closer (under about 0.7 m) and add a foothold under them.`] };
		}
		const f = features(copy, result);
		const measured = gradeOf(f);
		if (Math.abs(measured - target) > 1.15) return { ok: false, reasons: [`measured ${label(measured)}, you wanted V${target}: ${measured > target ? 'use bigger, kinder holds and shorter moves' : 'use smaller holds (crimps, pinches, a sloper) and a longer move or two'}`], features: f };
		// the label stays what was asked for when the measure agrees (within about half a grade), otherwise it is what was measured
		return { ok: true, grade: Math.abs(measured - target) <= 0.6 ? `V${target}` : label(measured), features: f, reasons: [] };
	}

	// his own design, without a model: rhythm of hands up the wall, a foot under each, kinds by grade, a little style
	generate(route, target, seed) {
		const r = dice(seed), height = top(route);
		const gentle = clamp(1 - target * 0.16, 0.12, 0.9);
		const kind = (hard) => {
			const x = r();
			if (x < gentle * (hard ? 0.5 : 1)) return 'jug';
			if (x < gentle + 0.2) return r() < 0.5 ? 'pinch' : 'crimp';
			if (x < gentle + 0.2 + 0.05 * target) return 'pocket';
			return r() < 0.35 + 0.08 * target ? 'sloper' : 'crimp';
		};
		const pullOf = (k, x) => {
			if (k === 'pinch') return new Vec2(x < 0 ? 1 : -1, 0);
			const tilt = (r() - 0.5) * (k === 'jug' ? 0.2 : 0.5);
			return new Vec2(Math.sin(tilt), -Math.cos(tilt));
		};
		const H = (x, y, k, seedNo) => ({ point: new Vec2(clamp(x, -2.4, 2.4), y), kind: k, pull: pullOf(k, x), seed: seedNo });
		const jitter = (a) => (r() - 0.5) * 2 * a;
		const holds = [H(-0.25 + jitter(0.06), 0.45 + jitter(0.05), 'jug', 1), H(0.25 + jitter(0.06), 0.45 + jitter(0.05), 'jug', 2), H(-0.35 + jitter(0.06), 1.7 + jitter(0.05), 'jug', 3), H(0.35 + jitter(0.06), 1.7 + jitter(0.05), 'jug', 4)];
		const count = 5 + Math.floor(r() * 3) + (height > 4.4 ? 1 : 0);
		const lean = r() < 0.5 ? -1 : 1;
		const cruxAt = 2 + Math.floor(r() * (count - 3));
		const middle = [];
		for (let i = 0; i < count; i++) {
			const y = 2.05 + (height - 0.35 - 2.05) * (count > 1 ? i / (count - 1) : 0) + jitter(0.06);
			// a rhythm across the wall with a wobble; the crux is a longer step to the side
			const swing = (i % 2 === 0 ? -1 : 1) * lean * (0.2 + r() * 0.2 + (i === cruxAt ? 0.15 : 0));
			const x = swing + jitter(0.06);
			const hard = target >= 2 && (i === cruxAt || r() < 0.3);
			const k = i === cruxAt - 1 ? 'jug' : kind(!hard);
			middle.push(H(x, y, k, 10 + i));
			// a foothold under it on the near side
			if (r() < 0.85) middle.push(H(x * 0.6 + jitter(0.25), y - 0.5 - r() * 0.25, r() < 0.55 + gentle * 0.4 ? 'jug' : 'crimp', 40 + i));
		}
		middle.sort((a, b) => a.point.y - b.point.y);
		const all = [...holds, ...middle, H(0 + jitter(0.1), height - 0.25, 'jug', 99)];
		// no two holds on top of each other: push the later one away from the earlier until they are 22 cm apart
		for (let pass = 0; pass < 6; pass++)
			for (let i = 1; i < all.length; i++)
				for (let j = 0; j < i; j++) {
					const gap = all[i].point.sub(all[j].point), d = gap.len();
					if (d >= 0.22) continue;
					const away = d > 1e-3 ? gap.norm() : new Vec2(1, 0);
					if (i >= all.length - 1 || i < 4) { all[j].point = all[j].point.sub(away.mul(0.24 - d)); continue; }
					all[i].point = new Vec2(clamp(all[i].point.x + away.x * (0.24 - d), -2.4, 2.4), clamp(all[i].point.y + away.y * (0.24 - d), 0.4, height - 0.4));
				}
		return all;
	}

	// ---------------------------------------------------------------- the physical work
	// where to stand to work a spot on a wall: on the floor in front of it, or on a ladder leaning against it
	access(route, spot) {
		const panel = route.at(spot.y);
		const wall = route.map(spot, 0);
		let outH = new Vec3(panel.out.x, panel.out.y, 0);
		if (outH.len() < 0.2) outH = new Vec3(-1, 0, 0);
		outH = outH.norm();
		const f = outH.mul(-1);
		const yaw = Math.atan2(f.y, f.x);
		if (wall.z <= 205) {
			const at = wall.add(outH.mul(58));
			const stand = this.world.clear(new Vec3(at.x, at.y, 0), outH);
			return { kind: 'floor', at: new Vec3(stand.x, stand.y, floorAt(stand.x, stand.y)), yaw, f, outH, spot };
		}
		// the ladder: its top rests on the wall about 1.35 m over the standing feet, which are 1.3 m under the hold (a hand's reach from the shoulder)
		const feet = wall.z - 128;
		const touch = Math.min(feet + 135, top(route) * 100 - 20);
		let y2 = spot.y;
		for (let y = spot.y; y < top(route); y += 0.03) if (route.map(new Vec2(spot.x, y), 0).z >= touch) { y2 = y; break; }
		const contact = route.map(new Vec2(spot.x, y2), 0).add(outH.mul(4));
		const run = (touch - 28) / Math.tan(75 * Math.PI / 180);
		const base = new Vec3(contact.x + outH.x * run, contact.y + outH.y * run, floorAt(contact.x + outH.x * run, contact.y + outH.y * run));
		const length = (touch - base.z) / Math.sin(75 * Math.PI / 180) + 25;
		const q = Math.max(0, ((feet - base.z) / Math.sin(75 * Math.PI / 180) - 30) / 30);
		return { kind: 'ladder', base, f, outH, yaw, length, q, spot, standBase: base.add(outH.mul(60)) };
	}

	standFor(route, spot) { return this.access(route, spot); }

	async go(token, access) {
		const goal = access.kind === 'ladder' ? access.standBase : access.at;
		await this.run(token, (delta) => {
			const near = this.agent.standing(delta, goal, access.yaw);
			this.agent.pose = this.agent.walkPose(this.agent.routes[this.agent.index]?.map(access.spot, 0));
			return near < 14 && Math.abs(Math.atan2(Math.sin(access.yaw - this.agent.yaw), Math.cos(access.yaw - this.agent.yaw))) < 0.25;
		});
	}

	// run a per-frame task until it says it is finished
	run(token, update) {
		return new Promise((resolve) => {
			this.task = { update, resolve, token };
		});
	}

	// called by the agent every frame while it is in setting mode
	frame(delta) {
		// a brisk working pace: a person's walk, a ladder at about a rung and a third a second, a hold on or off in two seconds
		delta *= TEMPO;
		const t = this.task;
		if (!t) { if (!this.agent.pose) this.agent.pose = this.agent.walkPose(); return; }
		if (t.token !== this.token) { this.task = null; t.resolve(); return; }
		let done = false;
		try { done = t.update(delta); } catch (e) { console.warn('setter task:', e); done = true; }
		if (done) { this.task = null; t.resolve(); }
	}

	// every change in the order that saves the most walking: low ones on the floor first, then the ladder ones from left to right
	plan(index, holds) {
		const route = this.routes[index], old = route.holds;
		const edits = [];
		const n = Math.min(old.length - 1, holds.length - 1);
		for (let i = 0; i < n; i++) {
			const a = old[i], b = holds[i];
			if (a.point.dist(b.point) > 0.03 || a.kind !== b.kind || a.pull.dist(b.pull) > 0.1) edits.push({ type: 'shift', ref: a, to: b });
		}
		const a = old[old.length - 1], b = holds[holds.length - 1];
		if (a.point.dist(b.point) > 0.03 || a.kind !== b.kind) edits.push({ type: 'shift', ref: a, to: b });
		for (let i = n; i < holds.length - 1; i++) edits.push({ type: 'add', to: holds[i] });
		for (let i = old.length - 2; i >= n; i--) edits.push({ type: 'remove', ref: old[i] });
		const reach = (e) => route.map((e.ref ?? e).point ?? e.to.point, 0).z;
		const x = (e) => ((e.ref ?? e).point ?? e.to.point).x;
		return edits.sort((p, q) => (reach(p) > 205) - (reach(q) > 205) || (reach(p) > 205 ? x(p) - x(q) || reach(p) - reach(q) : reach(p) - reach(q)));
	}

	async build(token, index, holds) {
		const route = this.routes[index];
		const edits = this.plan(index, holds);
		this.say(edits.length ? `${edits.length} holds to move. let's go.` : 'already how I like it.');
		let ladderAt = null;
		this.up = null;
		for (const edit of edits) {
			if (!this.live(token)) return;
			const spotOld = edit.ref ? edit.ref.point.copy() : null;
			const spotNew = edit.to?.point ?? null;
			const far = spotOld && spotNew && spotOld.dist(spotNew) > 0.75;
			if (edit.type === 'shift' && far) {
				await this.work(token, index, edit, spotOld, 'take', ladderAt, (v) => { ladderAt = v; });
				await this.work(token, index, edit, spotNew, 'put', ladderAt, (v) => { ladderAt = v; });
			} else {
				await this.work(token, index, edit, spotOld ?? spotNew, 'do', ladderAt, (v) => { ladderAt = v; });
			}
		}
		if (this.up != null) { await this.climb(token, ladderAt, this.up, 0); this.up = null; if (ladderAt) this.agent.at = new Vec3(ladderAt.standBase.x, ladderAt.standBase.y, floorAt(ladderAt.standBase.x, ladderAt.standBase.y)); }
		if (ladderAt) await this.stow(token);
		this.agent.pose = this.agent.walkPose();
	}

	// one visit to one spot: walk there, ladder up if it is high, do the job with a hand, come down
	async work(token, index, edit, spot, phase, ladderAt, setLadder) {
		const route = this.routes[index], agent = this.agent;
		const access = this.access(route, spot);
		const slot = edit.ref ? route.holds.indexOf(edit.ref) : undefined;
		// the ladder is kept for the next job if it is nearby, otherwise taken down and stood up again
		const near = ladderAt && access.kind === 'ladder' && ladderAt.base.dist(access.base) < 130;
		const sameLadder = near && ladderAt.base.dist(access.base) < 12;
		// still up the ladder from the last job: stay up if the next one is from the same spot, else come down first
		if (this.up != null && !sameLadder) { await this.climb(token, ladderAt, this.up, 0); this.up = null; agent.at = new Vec3(ladderAt.standBase.x, ladderAt.standBase.y, floorAt(ladderAt.standBase.x, ladderAt.standBase.y)); }
		if (ladderAt && !near) { await this.stow(token); setLadder(null); }
		agent.status = `${access.kind === 'ladder' ? 'ladder, ' : ''}${phase === 'take' ? 'taking off' : phase === 'put' ? 'putting on' : 'setting'} hold ${slot ?? 'new'}`;
		if (access.kind === 'floor') {
			if (this.up != null) { await this.climb(token, ladderAt, this.up, 0); this.up = null; if (ladderAt) agent.at = new Vec3(ladderAt.standBase.x, ladderAt.standBase.y, floorAt(ladderAt.standBase.x, ladderAt.standBase.y)); }
			await this.go(token, access);
			if (!this.live(token)) return;
			await this.hands(token, index, edit, spot, phase, { at: access.at, yaw: access.yaw, ladder: null });
			return;
		}
		if (near && !sameLadder) {
			// close by: walk the ladder along the wall rather than putting it away
			await this.shuffle(token, access);
			setLadder(access);
		} else if (!sameLadder) {
			await this.go(token, access);
			if (!this.live(token)) return;
			await this.raise(token, access);
			setLadder(access);
			this.ladder.update(1);
		}
		const q = access.q;
		await this.climb(token, access, this.up ?? 0, q);
		this.up = q;
		if (!this.live(token)) return;
		await this.hands(token, index, edit, spot, phase, { ladder: this.ladder, q, access, yaw: access.yaw });
	}

	// walk the ladder sideways to the next job: it is lifted, carried a step or two and set down
	shuffle(token, access) {
		const ladder = this.ladder, agent = this.agent;
		const from = ladder.base, f0 = ladder.f;
		ladder.place(from, f0, access.length);
		ladder.update(1);
		agent.status = 'moving the ladder over';
		let t = 0;
		return this.run(token, (delta) => {
			t += delta;
			const k = clamp(t / 1.4, 0, 1), e = k * k * (3 - 2 * k);
			ladder.base = from.lerp(access.base, e);
			ladder.f = f0.lerp(access.f, e).norm();
			ladder.update(1);
			agent.at = new Vec3(ladder.base.x - ladder.f.x * 55, ladder.base.y - ladder.f.y * 55, floorAt(ladder.base.x, ladder.base.y));
			agent.pose = raisePose(ladder, agent.climber.clock, ladder.point(120));
			return t >= 1.5;
		});
	}

	// raise the ladder from the floor to the wall
	raise(token, access) {
		const ladder = this.ladder, agent = this.agent;
		ladder.place(access.base, access.f, access.length);
		this.say(pick(Quips.ladder));
		agent.status = 'raising the ladder';
		let t = 0;
		return this.run(token, (delta) => {
			t += delta;
			ladder.update(clamp(t / 1.4, 0, 1));
			agent.at = new Vec3(access.base.x - access.f.x * 55, access.base.y - access.f.y * 55, floorAt(access.base.x, access.base.y));
			agent.pose = raisePose(ladder, agent.climber.clock, ladder.point(120));
			return t >= 1.6;
		});
	}

	stow(token) {
		const ladder = this.ladder, agent = this.agent;
		if (!ladder.on) return Promise.resolve();
		agent.status = 'putting the ladder away';
		let t = 0;
		const access = { base: ladder.base, f: ladder.f };
		return this.run(token, (delta) => {
			t += delta;
			ladder.update(clamp(1 - t / 1.1, 0, 1));
			agent.at = new Vec3(access.base.x - access.f.x * 55, access.base.y - access.f.y * 55, floorAt(access.base.x, access.base.y));
			agent.pose = raisePose(ladder, agent.climber.clock, ladder.point(120));
			if (t >= 1.2) { ladder.remove(); return true; }
			return false;
		});
	}

	// up or down the ladder from rung coordinate A to B, one limb at a time
	climb(token, access, a, b) {
		const ladder = this.ladder, agent = this.agent;
		let q = a;
		const up = b > a;
		return this.run(token, (delta) => {
			q += (up ? 1 : -1) * delta * (up ? RUNGS : RUNGS * 1.3);
			if ((up && q >= b) || (!up && q <= b)) q = b;
			agent.pose = ladderPose(ladder, q, agent.climber.clock, access.spot ? this.routes[agent.index].map(access.spot, 0) : ladder.point(ladder.length));
			agent.status = up ? `climbing the ladder (rung ${Math.floor(q) + 1})` : 'coming down the ladder';
			agent.at = new Vec3(ladder.point(ladder.rung(q)).x - ladder.f.x * 20, ladder.point(ladder.rung(q)).y - ladder.f.y * 20, agent.at.z);
			return q === b;
		});
	}

	// the job itself: reach, take hold of it, change it, let go
	hands(token, index, edit, spot, phase, stance) {
		const route = this.routes[index], agent = this.agent;
		const holds = route.holds;
		let t = 0, did = false;
		const target = spot;
		const at = stance.ladder ? null : stance.at;
		const hold = edit.ref;
		this.say(pick(Quips.hold), 2.5);
		return this.run(token, (delta) => {
			t += delta;
			// reach for it, work it, let go and bring the hand back: about two seconds
			const reach = clamp(t < 0.5 ? t / 0.5 : t > 1.7 ? 1 - (t - 1.7) / 0.5 : 1, 0, 1);
			const here = stance.ladder ? stance.ladder.point(stance.ladder.rung(stance.q)) : at;
			const pose = workPose({ at, yaw: stance.yaw, face: route, spot: target, reach, ladder: stance.ladder, q: stance.q, clock: agent.climber.clock, holding: !!this.carry });
			agent.pose = pose;
			// at the middle of the job the hold changes
			if (!did && t > 1.0) {
				did = true;
				this.apply(index, edit, phase, hold);
			}
			// the hold in the hand
			const arm = [2, 3].map(l => pose.limbs[l]).find(l => l.hand.palm.dist(route.map(target, 3)) < 40) ?? pose.limbs[2];
			this.proxy.visible = !!this.carry;
			if (this.carry) { this.proxy.position.copy(three(arm.hand.palm)); this.proxy.material.color.setHex(this.carry.color); }
			return t >= 2.2;
		});
	}

	// the change to the route's data, at the moment the hand lets go
	apply(index, edit, phase, hold) {
		const route = this.routes[index];
		const c = route.holds.indexOf(hold);
		const color = { jug: 0xe8b21c, crimp: 0xd9482b, sloper: 0x8a6bd1, pinch: 0x2f9e8f, pocket: 0x3a7bd5 }[hold?.kind ?? edit.to?.kind] ?? 0xf2a007;
		if (edit.type === 'add' || (edit.type === 'shift' && phase === 'put' && this.carry)) {
			if (edit.type === 'add') {
				const h = { point: edit.to.point.copy(), kind: edit.to.kind, pull: edit.to.pull.copy(), seed: (Math.max(0, ...route.holds.map(x => x.seed ?? 0)) + 1) };
				route.holds.splice(route.holds.length - 1, 0, h);
			} else {
				const h = this.carry.hold;
				h.point = edit.to.point.copy();
				h.kind = edit.to.kind;
				h.pull = edit.to.pull.copy();
				h.carried = false;
				this.carry = null;
			}
		} else if (edit.type === 'remove') {
			if (c >= 0) route.holds.splice(c, 1);
		} else if (edit.type === 'shift' && phase === 'take') {
			hold.carried = true;
			this.carry = { hold, index, color };
		} else if (edit.type === 'shift') {
			hold.point = edit.to.point.copy();
			hold.kind = edit.to.kind;
			hold.pull = edit.to.pull.copy();
		}
		this.hooks.rebuild(index);
		this.hooks.puff(route.map(edit.to?.point ?? hold?.point ?? new Vec2(), 6));
	}

	// the proof: he climbs it with the same moves as ever, up to three goes
	test(token, index) {
		const agent = this.agent;
		return new Promise((resolve) => {
			let tries = 0, why = '';
			agent.index = index;
			agent.testing = (result, reason) => {
				tries++;
				why = reason;
				if (result === 'sent' || tries >= 3) { agent.testing = null; resolve({ sent: result === 'sent', tries, why }); }
			};
			agent.mode = 'approach';
		});
	}
}

const answer_ = (d) => d.holds.map(h => ({ kind: h.kind, x: +h.point.x.toFixed(2), y: +h.point.y.toFixed(2), pull: [+h.pull.x.toFixed(1), +h.pull.y.toFixed(1)] }));
