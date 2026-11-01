// try a problem and say how hard it is. the same lookahead the AI climber uses to rehearse a move is run as a solver on a copy of the
// problem: it can be sent or it cannot (a hold that is physically out of reach, a gap no body can cross), and how it was sent (how long,
// how big the reaches, how much pump, how few safe options at each step, how hard the holds are) says what grade it is.

import { Sim, Vec2 } from './sim.js';
import { rehearse, score, Shifts } from './brain.js';

const settle = (sim, frames) => { for (let f = 0; f < frames && !sim.fallen; f++) sim.step(1 / 60); };
const pause = () => new Promise(r => setTimeout(r, 0));
// how much each kind of hold costs a hand
export const Cost = { jug: 0, pinch: 0.8, crimp: 1, pocket: 1.4, sloper: 1.6 };

// a copy of a problem with other holds on it (the panels are shared)
export function withHolds(route, holds) {
	const copy = Object.assign(Object.create(Object.getPrototypeOf(route)), route);
	copy.holds = holds.map(h => ({ point: h.point.copy(), kind: h.kind, pull: h.pull.copy(), seed: h.seed }));
	return copy;
}

// can a body hang on the start holds at all
export function startsHold(route) {
	const sim = new Sim([route]);
	sim.restart();
	settle(sim, 180);
	return !sim.fallen && sim.grips.every(g => g >= 0);
}

// climb it with rehearsal, from the start holds, as far as it goes. Resolves { sent, moves, trace, stuck }
export async function solve(route, { maxMoves = 32, yieldEvery = 1, finish, observe } = {}) {
	const sim = new Sim([route]);
	sim.restart();
	const trace = [];
	const recent = [];
	let flat = 0, best = score(sim), peakPump = 0;
	// a climb is done when the sim says the problem is sent, or when a finish the caller names is true
	const done = () => sim.won || (finish ? finish(sim) : false);
	for (let move = 0; move < maxMoves && !done() && !sim.fallen; move++) {
		const options = rehearse(sim, { max: 20 });
		const fresh = options.filter(c => c.safe && !recent.includes(`${c.limb}:${c.hold}`));
		const choice = fresh.find(c => c.gain > 0.01) ?? fresh[0];
		if (!choice) return { sent: false, moves: move, trace, stuck: stuckAt(sim, options), sim };
		const safe = options.filter(c => c.safe);
		const before = sim.position.y;
		if (choice.lean) { sim.lean = Shifts[choice.lean]; settle(sim, 30); sim.lean = new Vec2(); }
		const distance = sim.distance(choice.limb, sim.holds()[choice.hold].point) / sim.range(choice.limb);
		if (!sim.grab(choice.limb, choice.hold)) return { sent: false, moves: move, trace, stuck: stuckAt(sim, options), sim };
		settle(sim, 45);
		observe?.(sim);
		recent.push(`${choice.limb}:${choice.hold}`);
		if (recent.length > 6) recent.shift();
		peakPump = Math.max(peakPump, ...sim.pump);
		const s = score(sim);
		if (s > best + 0.02) { best = s; flat = 0; } else flat++;
		trace.push({ limb: choice.limb, hold: choice.hold, lean: choice.lean, safe: safe.length, reach: distance, rise: sim.position.y - before, pump: Math.max(...sim.pump), y: sim.position.y });
		if (flat > 12) return { sent: false, moves: move + 1, trace, stuck: stuckAt(sim, options), sim };
		if (move % yieldEvery === 0) await pause();
	}
	return { sent: done(), moves: trace.length, trace, stuck: done() ? null : stuckAt(sim, []), sim, peakPump };
}

// where a climb stopped, in words for the setter: the height reached and which holds were close
function stuckAt(sim, options) {
	const holds = sim.holds();
	const hands = [2, 3].map(l => sim.grips[l]).filter(g => g >= 0);
	const high = hands.length ? Math.max(...hands.map(g => holds[g].point.y)) : sim.position.y;
	const above = holds.map((h, i) => ({ i, y: h.point.y, d: Math.hypot(h.point.x - sim.position.x, h.point.y - sim.position.y) })).filter(h => h.y > high - 0.05).sort((a, b) => a.d - b.d).slice(0, 3);
	return { y: +high.toFixed(2), x: +sim.position.x.toFixed(2), next: above.map(a => `hold ${a.i} (${holds[a.i].point.x.toFixed(2)}, ${holds[a.i].point.y.toFixed(2)}), ${a.d.toFixed(2)} m from your hips`), safeOptions: options.filter(c => c.safe).length };
}

// numbers that say how hard a sent problem was
export function features(route, result) {
	const holds = route.holds, t = result.trace;
	if (!t.length) return null;
	const handMoves = t.filter(m => m.limb >= 2);
	const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
	// the holds the hands actually used, how hard each is, and how steep the wall was under them
	const cost = mean(handMoves.map(m => Cost[holds[m.hold].kind] ?? 0.5));
	const steep = mean(t.map(m => Math.max(0, route.steep(m.y))));
	return {
		moves: t.length,
		cost: +cost.toFixed(2),
		reach: +mean(t.map(m => m.reach)).toFixed(2),
		bigReach: +Math.max(...t.map(m => m.reach)).toFixed(2),
		options: +mean(t.map(m => Math.min(m.safe, 12))).toFixed(1),
		pump: +(result.peakPump ?? 0).toFixed(2),
		steep: +steep.toFixed(2),
		height: +Math.max(...holds.map(h => h.point.y)).toFixed(2),
	};
}

// the grade as a number: a straight line through two features, fitted to this gym's own nine V1 to V5 problems by least squares (rms
// error 0.7 of a grade; the other features added nothing). the wall's steepness counts most, then how hard the holds the hands used are
export function gradeOf(f) {
	if (!f) return 0;
	return Math.max(0, -0.45 + 3.16 * f.cost + 5.24 * f.steep);
}
export const label = (g) => `V${Math.max(0, Math.round(g))}`;
