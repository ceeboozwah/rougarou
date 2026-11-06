// the endless wall, as pure data (no three.js, so a node script can walk it too): the angle of every panel and every hold of every 10 meter chunk
// are a function of the chunk number alone, so the wall is the same for everyone, always. nothing is trusted: each chunk is climbed by the solver
// (the same rehearsal lookahead the AI uses) before it is accepted, from the rest holds at its bottom to the rest holds at the top of it, so no
// hold on the wall is impossible. a chunk that cannot be climbed is redrawn from a new seed, then made gentler, then made a plain ladder of jugs.
//
// the layout of the wall: panels 2.5 m long. a chunk is four panels (10 m). the first panel of every chunk is gentle and carries a REST BAND: four
// jugs in fixed places (feet 1.25 m under the hands), so every chunk begins where the last one ended. the other three panels carry the chunk's
// theme: vertical, slab, a lean, steep, or a roof, and the harder, the higher. the wall's lean is kept from drifting out into the room.

import { Panel, Route, Vec2, Vec3 } from './sim.js';
import { solve, withHolds, features } from './grader.js';

export const SEED = 1991;
// a move the skeleton cannot make is not part of a chunk's solution: the page sets this to the body check's gate (bodycheck.js), node leaves it empty
export const Gate = { fn: null };
export const PANEL = 2.5, CHUNK = 4, SPAN = PANEL * CHUNK;
// where the wall stands (unreal centimeters), facing -x; the room is in front of it
export const WALL_X = 4400;
const V = (x, y, z) => new Vec3(x, y, z);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = (d) => d * Math.PI / 180;

// integer hashing: the same numbers on every machine, no floating point involved until the end
const hash = (...n) => { let h = 0x9E3779B9; for (const v of n) { h = Math.imul(h ^ (v | 0), 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16; } return h >>> 0; };
export const dice = (...n) => { let s = hash(SEED, ...n) || 1; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };

// how hard the wall is at a height in meters: 0 at the floor, creeping toward 1 and never past it
export const difficulty = (h) => 1 - Math.exp(-h / 160);

// the widths of the holds in centimeters, as gym.js draws them
const SIZE = { jug: 22, crimp: 18, sloper: 28, pinch: 20, pocket: 18 };
const wide = (kind) => (SIZE[kind] ?? 20) / 2 * 1.05;

// ---------------------------------------------------------------- the shape of the wall

// a theme is a range of lean in degrees (positive leans over the climber, negative is a slab)
const Themes = {
	vertical: [-3, 4], slab: [-16, -6], lean: [8, 20], steep: [24, 38], roof: [44, 56],
};
const themeFor = (section, h, drift) => {
	const r = dice(section, 77)();
	const d = difficulty(h);
	// the lean pulls the wall into the room, so after enough of it a slab or a plain wall pushes it back (the climber's room is 18 m deep)
	if (drift < -650) return r < 0.6 ? 'slab' : 'vertical';
	if (drift > 150) return r < 0.5 ? 'lean' : 'steep';
	const weights = { vertical: 0.3 - 0.18 * d, slab: 0.22 - 0.06 * d, lean: 0.26, steep: 0.16 + 0.3 * d, roof: h > 30 ? 0.05 + 0.3 * d : 0 };
	let x = r * Object.values(weights).reduce((a, b) => a + b, 0);
	for (const [k, w] of Object.entries(weights)) { x -= w; if (x <= 0) return k; }
	return 'vertical';
};

// the wall's panels, grown as far as asked. each panel is 2.5 m, turned by its lean about the line across the wall
export class Wall extends Route {
	constructor() {
		super('The Wall');
		this.endless = true;
		this.grade = '∞';
		this.panels = [];
		this.holds = [];
		this.lean = [];
		this.chunks = [];
		this.stand = 560;
		this.drift = 0;
		this.low = 0;
	}

	// the angle of panel I, which has to be asked for in order (the recurrence needs its past)
	angleOf(i) {
		if (this.lean[i] !== undefined) return this.lean[i];
		for (let j = this.lean.length; j <= i; j++) {
			const chunk = Math.floor(j / CHUNK), slot = j % CHUNK;
			// the first panel of each chunk is gentle, the rest follow a theme that changes every few panels
			// one theme a chunk, chosen once from where the wall has got to
			if (slot === 1 || this.theme === undefined) this.theme = themeFor(chunk, chunk * SPAN, this.driftAt(j));
			const [lo, hi] = slot === 0 ? [-6, 8] : Themes[this.theme];
			const target = lo + (hi - lo) * dice(j, 5)();
			const before = j ? this.lean[j - 1] : 0;
			// no more than a turn of 22 degrees from one panel to the next, except back onto the gentle panel at the start of a chunk
			const step = slot === 0 ? 50 : 22;
			this.lean[j] = clamp(target, before - step, before + step);
		}
		return this.lean[i];
	}
	// how far the wall has leaned into the room (centimeters) at the start of panel J, from the angles so far
	driftAt(j) {
		let x = 0;
		for (let i = 0; i < Math.min(j, this.lean.length); i++) x -= Math.sin(rad(this.lean[i])) * PANEL * 100;
		return x;
	}

	// make sure panels 0..N-1 exist
	grow(n) {
		for (let i = this.panels.length; i < n; i++) {
			const theta = rad(this.angleOf(i));
			const p = new Panel();
			p.start = i * PANEL;
			p.length = PANEL;
			p.right = V(0, -1, 0);
			p.up = V(-Math.sin(theta), 0, Math.cos(theta));
			p.out = p.right.cross(p.up);
			const last = this.panels[i - 1];
			p.origin = last ? last.origin.add(last.up.mul(PANEL * 100)) : V(WALL_X, 0, 0);
			this.panels.push(p);
		}
	}

	at(y) { return this.panels[clamp(Math.floor(y / PANEL), 0, this.panels.length - 1)]; }
	// the few panels around a point in the gym, so the body code does not walk the whole wall
	near(p) {
		let lo = 0, hi = this.panels.length - 1;
		while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.panels[m].origin.z <= p.z) lo = m; else hi = m - 1; }
		return this.panels.slice(Math.max(0, lo - 2), lo + 4);
	}
}

// ---------------------------------------------------------------- holds

// the band at the foot of a chunk: where the last one ends and the next begins. Y is the height of the hands
export const band = (y) => [[-0.25, y - 1.25, 'jug'], [0.25, y - 1.25, 'jug'], [-0.35, y, 'jug'], [0.35, y, 'jug'],
	// three foot chips for the first foot moves, where the gym's own problems put them (a foot cannot be lifted far above its hip)
	[0.05, y - 0.75, 'crimp'], [-0.4, y - 0.5, 'crimp'], [0.4, y - 0.4, 'crimp']].map(([x, h, kind]) => ({ point: new Vec2(x, h), kind, pull: new Vec2(0, -1), line: -1 }));
export const bandY = (k) => k * SPAN + 1.7;

// the wall is wide: four LINES run up it side by side, each a way from this chunk's band to the next one, and between them cross holds that let a
// climber change line wherever they like. a line wanders out from the band toward its Cx and back to the next band; Harder makes it harder than the height
// alone would (the right hand lines are harder, the left easier), so there is a choice of how to go
export const LINES = [{ cx: -1.6, harder: -0.2 }, { cx: -0.55, harder: 0 }, { cx: 0.55, harder: 0.1 }, { cx: 1.6, harder: 0.3 }];
// the two middle lines are the way straight up from the band, and always exist; the outer two are dropped from a chunk if they cannot be climbed
export const CORE = [1, 2];

// the color of each line's holds, by the line's number (-1 is the rest band, 4 the cross holds): easy to hard, green, blue, orange, red
export const Colors = { '-1': [0.95, 0.72, 0.05], 0: [0.04, 0.42, 0.16], 1: [0.02, 0.2, 0.78], 2: [0.92, 0.38, 0.04], 3: [0.78, 0.04, 0.04], 4: [0.8, 0.8, 0.77] };

// one try at one line of chunk K: the holds between its band and the next, from Attempt (0 to 9 random, 10 and 11 kinder, 12 a plain ladder)
export function middle(k, attempt, wall, line = 1) {
	const spec = LINES[line];
	const r = dice(k, 1000 + attempt, line);
	const h0 = k * SPAN, d = clamp(difficulty(h0 + SPAN / 2) + spec.harder * (0.4 + 0.6 * difficulty(h0)), 0, 1);
	const kind = attempt >= 12 ? 0 : attempt >= 10 ? 0.5 : 1;
	const lo = bandY(k), hi = bandY(k + 1);
	// the typical gap grows with height; an easy try keeps it small
	const plain = attempt >= 12;
	const gap = plain ? 0.38 : (0.34 + 0.36 * d) * (kind === 1 ? 1 : 0.8);
	const n = Math.max(5, Math.round((hi - lo) / gap));
	const holds = [];
	const side0 = r() < 0.5 ? -1 : 1;
	const spread = plain ? 0.3 : (0.2 + 0.45 * d) * (kind === 1 ? 1 : 0.6);
	const cruxAt = 2 + Math.floor(r() * (n - 4));
	for (let i = 1; i < n; i++) {
		const y = lo + (hi - lo) * i / n + (r() - 0.5) * 0.08;
		// the lean of the wall here decides what suits it: slopers and crimps like a slab, jugs and pinches an overhang
		const lean = wall.angleOf(Math.min(CHUNK * k + Math.floor((y - h0) / PANEL), CHUNK * k + 3));
		const hard = (i === cruxAt && kind === 1 && d > 0.05) ? 1 : 0;
		const pJug = plain ? 1 : clamp((0.92 - 0.6 * d) * (lean > 20 ? 1.15 : 1) - hard * 0.4, 0.1, 0.95) * (kind === 1 ? 1 : 1.25);
		// the line leaves the band, drifts out to its own place on the wall and comes back to the next band
		const t = i / n, bulge = Math.pow(Math.sin(Math.PI * t), 0.7);
		const zig = (i % 2 ? side0 : -side0) * (0.12 + spread * (0.4 + r() * 0.5)) + (r() - 0.5) * 0.12;
		const x = clamp(zig * (1 - 0.35 * bulge) + spec.cx * bulge, -2.5, 2.5);
		const roll = r();
		let k2;
		if (roll < pJug) k2 = 'jug';
		else if (roll < pJug + (1 - pJug) * 0.4) k2 = lean > 12 ? 'pinch' : 'crimp';
		else if (roll < pJug + (1 - pJug) * 0.7) k2 = lean > 25 ? 'pocket' : 'crimp';
		else k2 = lean < 0 ? 'sloper' : (r() < 0.5 ? 'pinch' : 'crimp');
		const tilt = (r() - 0.5) * (k2 === 'jug' ? 0.25 : 0.55);
		const pull = k2 === 'pinch' ? new Vec2(x < spec.cx ? 1 : -1, 0) : new Vec2(Math.sin(tilt), -Math.cos(tilt));
		holds.push({ point: new Vec2(x, y), kind: k2, pull, line });
		// a foothold under it, less often higher up and on a harder wall, but never none for long
		const pFoot = plain ? 0.97 : clamp(0.95 - 0.35 * d, 0.5, 0.95);
		if (r() < pFoot) holds.push({ point: new Vec2(clamp(x + (r() - 0.5) * 0.5 - Math.sign(x - spec.cx) * 0.1, -2.5, 2.5), y - 0.55 - r() * 0.3), kind: plain || r() < 0.5 + 0.3 * (1 - d) ? 'jug' : 'crimp', pull: new Vec2(0, -1), line });
	}
	// a rest: every 30 m a pair of big jugs side by side near the middle of the chunk, on each line
	if (k % 3 === 2) holds.push({ point: new Vec2(spec.cx - 0.32, lo + 4.3), kind: 'jug', pull: new Vec2(0, -1), line }, { point: new Vec2(spec.cx + 0.32, lo + 4.3), kind: 'jug', pull: new Vec2(0, -1), line });
	return holds;
}

// holds between two neighbouring lines, level with the holds of one of them, so a hand can slide across (never more than about 0.7 m from either)
function crosses(k, left, right, id) {
	const r = dice(k, 5000 + id);
	const out = [];
	const mid = (left.cx + right.cx) / 2;
	const lo = bandY(k), hi = bandY(k + 1);
	for (let y = lo + 0.6 + r() * 0.3; y < hi - 0.5; y += 0.85 + r() * 0.5) {
		const kind = r() < 0.55 ? 'jug' : r() < 0.6 ? 'pinch' : 'crimp';
		const x = mid + (r() - 0.5) * 0.18;
		out.push({ point: new Vec2(x, y), kind, pull: kind === 'pinch' ? new Vec2(r() < 0.5 ? 1 : -1, 0) : new Vec2(0, -1), line: 4 });
	}
	return out;
}

// keep the middle holds off each other, the band and the folds in the wall. the band does not move
function repair(holds, fixed, wall, k) {
	const seams = [];
	for (let i = 1; i <= CHUNK + 1; i++) seams.push(k * SPAN + i * PANEL);
	const height = (k + 1) * SPAN + 3;
	for (let pass = 0; pass < 14; pass++) {
		let moved = false;
		holds.forEach((h, i) => {
			let p = h.point;
			const push = (from, need) => { const gap = p.sub(from), d = gap.len(); const away = d > 1e-3 ? gap.mul(1 / d) : new Vec2(1, 0); p = new Vec2(p.x + away.x * (need - d), p.y + away.y * (need - d)); moved = true; };
			for (const o of [...fixed, ...holds.slice(0, i)]) {
				const need = (wide(h.kind) + wide(o.kind) + 2.5) / 100;
				if (p.dist(o.point) < need) push(o.point, need);
			}
			const r = wide(h.kind) / 100;
			for (const s of seams) if (Math.abs(p.y - s) < r + 0.02) { p = new Vec2(p.x, p.y >= s ? s + r + 0.025 : s - r - 0.025); moved = true; }
			h.point = new Vec2(clamp(p.x, -2.5, 2.5), clamp(p.y, k * SPAN + 0.6, height));
		});
		if (!moved) break;
	}
	return holds;
}

// the chunk as the solver sees it: its own panels, its band at the foot and the next band as the finish. coordinates relative to the chunk's foot
function trial(k, holds, wall) {
	const route = new Route(`chunk ${k}`);
	const base = k * SPAN;
	route.panels = wall.panels.slice(CHUNK * k, CHUNK * k + CHUNK + 1).map((p, i) => Object.assign(new Panel(), p, { start: i * PANEL }));
	const lift = (h) => ({ point: new Vec2(h.point.x, h.point.y - base), kind: h.kind, pull: h.pull });
	const top = band(bandY(k + 1));
	route.holds = [...band(bandY(k)).map(lift), ...holds.map(lift), ...[top[0], top[1], top[3], top[2]].map(lift)];
	route.holds.forEach((h, i) => { h.seed = i; });
	route.grade = 'V?';
	return route;
}

// a chunk is climbed when both hands are on the next band's two hand holds (the last two holds of the trial) and have settled there
const reached = (sim) => {
	const n = sim.holds().length;
	const hands = [sim.grips[2], sim.grips[3]];
	return hands.includes(n - 1) && hands.includes(n - 2) && sim.arrived(2) && sim.arrived(3);
};

// make chunk K. Each line is tried until the solver can climb it alone from this band to the next (the hint is the attempt that worked before); the
// outer lines are dropped if they will not go, the middle ones are flattened and made a ladder if they must. then the cross holds go in, and the
// whole is climbed once more. Resolves { holds (all of the chunk's, band first), attempt (one per line), moves, sent }
export async function makeChunk(k, wall, hint, log) {
	wall.grow(CHUNK * (k + 2));
	const fixed = band(bandY(k)).map(h => ({ ...h }));
	const taken = [...fixed];
	const lines = [];
	const attempts = [];
	let moves = 0;
	for (let li = 0; li < LINES.length; li++) {
		const first = Array.isArray(hint) ? hint[li] : undefined;
		const order = first !== undefined && first >= 0 && first <= 12 ? [first] : [];
		for (let a = 0; a <= 12; a++) if (a !== first) order.push(a);
		let chosen = null;
		for (const attempt of order) {
			const holds = repair(middle(k, attempt, wall, li), taken, wall, k);
			const result = await solve(trial(k, holds, wall), { maxMoves: 140, yieldEvery: 3, finish: reached, gate: Gate.fn });
			log?.(`${li}:${attempt}`, result);
			if (result.sent) { chosen = { holds, attempt, moves: result.moves }; break; }
		}
		if (!chosen && CORE.includes(li)) {
			// nothing worked on this lean: flatten the chunk's three themed panels and use the plain ladder
			for (const flat of [0.5, 0]) {
				for (let i = 1; i < CHUNK; i++) wall.lean[CHUNK * k + i] *= flat;
				wall.panels.length = Math.min(wall.panels.length, CHUNK * k);
				wall.grow(CHUNK * (k + 2));
				const holds = repair(middle(k, 12, wall, li), taken, wall, k);
				const result = await solve(trial(k, holds, wall), { maxMoves: 140, yieldEvery: 3, finish: reached, gate: Gate.fn });
				log?.(`${li}:flat`, result);
				if (result.sent) { chosen = { holds, attempt: flat ? 13 : 14, moves: result.moves }; break; }
			}
		}
		if (!chosen) { attempts.push(-1); continue; }
		attempts.push(chosen.attempt);
		moves += chosen.moves;
		lines[li] = chosen.holds;
		taken.push(...chosen.holds);
	}
	if (!lines[1] || !lines[2]) return { holds: [...fixed, ...(lines[1] ?? []), ...(lines[2] ?? [])], attempt: attempts, moves, sent: false };
	// the holds between the lines
	const between = [];
	for (let li = 0; li + 1 < LINES.length; li++) if (lines[li] && lines[li + 1]) between.push(...repair(crosses(k, LINES[li], LINES[li + 1], li), taken.concat(between), wall, k));
	const all = [...lines.flatMap(l => l ?? []), ...between];
	const result = await solve(trial(k, all, wall), { maxMoves: 160, yieldEvery: 3, finish: reached, gate: Gate.fn });
	log?.('all', result);
	if (!result.sent) return { holds: [...fixed, ...lines.flatMap(l => l ?? [])], attempt: attempts, moves, sent: true, crossed: false };
	return { holds: [...fixed, ...all], attempt: attempts, moves: result.moves, sent: true, crossed: true };
}

export { features, withHolds };
