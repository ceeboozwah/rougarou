// the AI climber's head: what it can try (rehearsed on a copy of its own body), what it asks OpenAI, and what it remembers.
// nothing here touches the scene. the key never reaches the browser: calls go to tools/devserver.py's /ai/chat.

import { Vec2, Names } from './sim.js';

// a hip shift tried before a move, as the sim's lean (screen right is sim -x): none, right, left, up, down
export const Shifts = [null, new Vec2(-1, 0), new Vec2(1, 0), new Vec2(0, 1), new Vec2(0, -1)].map(v => v && v.mul(0.6));
export const ShiftNames = ['none', 'right', 'left', 'up', 'down'];

const settle = (sim, frames) => { for (let f = 0; f < frames && !sim.fallen; f++) sim.step(1 / 60); };

// how well a body stands: the top is worth a lot, hands count for height, feet for a little, a foot above the hips costs
export function score(sim) {
	let total = sim.won ? 1000 : 0;
	for (let limb = 0; limb < 4; limb++) {
		if (sim.grips[limb] < 0) { total -= limb < 2 ? 0.1 : 0.3; continue; }
		const point = sim.holds()[sim.grips[limb]].point;
		total += point.y * (limb >= 2 ? 1 : 0.3);
		if (limb < 2 && point.y > sim.position.y) total -= 1;
		total -= sim.pump[limb] * 0.4;
	}
	return total;
}

// every move worth considering from here, each tried on a copy: (a hip shift) then one limb to one hold, settled for three quarters of a second.
// a move that drops a hand or falls is kept as a risk, the rest with how it ended
export function rehearse(sim, { max = 12 } = {}) {
	const now = score(sim);
	const best = new Map();
	const holds = sim.holds();
	for (let lean = 0; lean < Shifts.length; lean++) {
		const base = sim.clone();
		if (lean) { base.lean = Shifts[lean]; settle(base, 30); base.lean = new Vec2(); }
		if (base.fallen || (base.grips[2] < 0 && base.grips[3] < 0)) continue;
		for (let limb = 0; limb < 4; limb++) {
			for (let hold = 0; hold < holds.length; hold++) {
				if (sim.grips[limb] === hold) continue;
				if (base.distance(limb, holds[hold].point) > base.range(limb)) continue;
				const trial = base.clone();
				if (!trial.grab(limb, hold)) continue;
				settle(trial, 45);
				const handsOn = trial.grips[2] >= 0 && trial.grips[3] >= 0;
				const safe = !trial.fallen && handsOn && trial.grips[limb] === hold;
				const gain = score(trial) - now;
				const key = `${limb}:${hold}`;
				const have = best.get(key);
				const entry = { limb, hold, lean, safe, gain, won: trial.won, why: trial.hint };
				if (!have || (entry.safe && !have.safe) || (entry.safe === have.safe && (entry.gain > have.gain + 1e-6 || (Math.abs(entry.gain - have.gain) < 1e-6 && entry.lean < have.lean)))) best.set(key, entry);
			}
		}
	}
	const all = [...best.values()];
	const ok = all.filter(c => c.safe).sort((a, b) => b.gain - a.gain);
	const risky = all.filter(c => !c.safe).sort((a, b) => b.gain - a.gain);
	const picked = [...ok.slice(0, max), ...risky.slice(0, 2)];
	// the match on the top (both hands on the finish) has to stay visible even when it scores low
	return picked.map((c, id) => ({ ...c, id }));
}

// hard mode: no rehearsal. every limb-to-hold move the body can physically reach is listed with nothing said about how it will go,
// so the model has to judge balance itself and learn from its falls
export function blindList(sim) {
	const out = [];
	const holds = sim.holds();
	for (let limb = 0; limb < 4; limb++)
		for (let hold = 0; hold < holds.length; hold++) {
			if (sim.grips[limb] === hold) continue;
			const d = sim.distance(limb, holds[hold].point);
			if (d > sim.range(limb) || !sim.open(limb, holds[hold].point)) continue;
			out.push({ limb, hold, lean: 0, safe: true, gain: holds[hold].point.y, blind: true, reach: d / sim.range(limb), won: false, why: '' });
		}
	out.sort((x, y) => y.gain - x.gain);
	return out.slice(0, 40).map((c, id) => ({ ...c, id }));
}

import { SYSTEM, TEACHER } from './instructions.js';

const hold = (h, i, last) => `${i}: ${h.kind} at (${h.point.x.toFixed(2)}, ${h.point.y.toFixed(2)}) pull (${h.pull.x.toFixed(1)}, ${h.pull.y.toFixed(1)})${i < 4 ? ' start' : ''}${i === last ? ' TOP' : ''}`;

export function describe({ sim, route, candidates, attempt, moves, memory, calls, flat = 0 }) {
	const holds = sim.holds(), last = holds.length - 1;
	const tip = (l) => sim.grips[l] >= 0 ? `hold ${sim.grips[l]}` : sim.smeared[l] ? 'smearing the wall' : 'hanging free';
	const lessons = memory.lessons(route.name);
	const history = memory.recent(route.name, 4);
	const demos = memory.demosFor(route.name);
	const said = (list) => list.map(([l, h]) => `${Names[l]} to ${h}`).join(', ');
	return [
		`PROBLEM: ${route.name} (${route.grade}), attempt ${attempt}. Model calls so far: ${calls}.`,
		'HOLDS:', ...holds.map((h, i) => hold(h, i, last)),
		`BODY: hips at (${sim.position.x.toFixed(2)}, ${sim.position.y.toFixed(2)}), tilt ${(sim.angle * 57.3).toFixed(0)} deg.`,
		...[0, 1, 2, 3].map(l => `${Names[l]}: ${tip(l)}, strain ${sim.strain[l].toFixed(2)}, pump ${sim.pump[l].toFixed(2)}`),
		sim.hint ? `LAST EVENT: ${sim.hint}` : '',
		flat >= 3 ? `STUCK: ${flat} moves without getting higher. Do something DIFFERENT from your recent moves.` : '',
		moves.length ? `RECENT MOVES (newest last, do not repeat these): ${moves.slice(-8).map(m => `${Names[m.limb]} to ${m.hold}${m.lean ? ` (hips ${ShiftNames[m.lean]})` : ''}${m.ok === false ? ' [could not reach]' : ''}`).join('; ')}` : '',
		moves.length ? `THIS ATTEMPT SO FAR: ${moves.map(m => `${Names[m.limb]} to ${m.hold}${m.lean ? ` (hips ${ShiftNames[m.lean]})` : ''}`).join('; ')}` : 'THIS ATTEMPT SO FAR: nothing yet',
		history.length ? `PAST ATTEMPTS: ${history.map(a => `#${a.n} ${a.result} after ${a.moves} moves${a.why ? ` (${a.why})` : ''}`).join(' | ')}` : '',
		demos.length ? `HUMAN DEMONSTRATIONS: ${demos.map(d => `${d.result === 'sent' ? 'SENT' : 'fell' + (d.why ? ` (${d.why})` : '')} in ${d.seconds}s: ${said(d.moves)}`).join(' | ')}` : '',
		lessons.length ? `YOUR NOTES: ${lessons.join(' | ')}` : '',
		'CANDIDATES:', ...candidates.map(c => `${c.id}:${c.demo ? ' *' : ''} ${Names[c.limb]} to hold ${c.hold}${c.lean ? `, hips ${ShiftNames[c.lean]} first` : ''} -> ${c.repeat ? '[you did this recently] ' : ''}${c.blind ? `reachable (${(c.reach * 100).toFixed(0)}% of your reach)` : c.won ? 'SENDS' : c.safe ? `safe, gain ${c.gain.toFixed(2)}` : `risky (${c.why || 'loses a hand'})`}`),
	].filter(Boolean).join('\n');
}

// the notebook: what has been sent, how each go ended and what the climber wrote to itself. kept by the server so it survives a reload
export class Memory {
	constructor() { this.data = { sent: {}, attempts: {}, notes: {}, general: [], demos: {}, toured: false }; this.timer = 0; }
	async load() {
		try { const r = await fetch('/ai/memory'); if (r.ok) { const d = await r.json(); this.data = { ...this.data, ...d }; } } catch { /* a fresh notebook */ }
	}
	save() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { fetch('/ai/memory', { method: 'POST', body: JSON.stringify(this.data) }).catch(() => {}); }, 800);
	}
	// a problem that has been reset: what was learned about the old holds no longer applies
	reset(name) {
		delete this.data.sent[name];
		delete this.data.attempts[name];
		delete this.data.notes[name];
		delete this.data.demos?.[name];
		this.save();
	}
	sends(name) { return this.data.sent[name] ?? 0; }
	lessons(name) { return [...(this.data.notes[name] ?? []).slice(-6), ...this.data.general.slice(-3)]; }
	recent(name, n) { return (this.data.attempts[name] ?? []).slice(-n); }
	tries(name) { return (this.data.attempts[name] ?? []).length; }
	attempt(name, entry) {
		const list = this.data.attempts[name] ??= [];
		list.push({ n: list.length + 1, ...entry });
		if (list.length > 40) list.splice(0, list.length - 40);
		if (entry.result === 'sent') this.data.sent[name] = this.sends(name) + 1;
		this.save();
	}
	// a human's climb, kept to teach from: the latest few sends and falls of each problem
	demo(name, entry) {
		const list = this.data.demos[name] ??= [];
		list.push(entry);
		const sent = list.filter(d => d.result === 'sent').slice(-3), fell = list.filter(d => d.result !== 'sent').slice(-2);
		this.data.demos[name] = [...sent, ...fell];
		this.save();
	}
	demosFor(name) { return this.data.demos?.[name] ?? []; }
	general(text) {
		text = String(text ?? '').trim().slice(0, 220);
		if (!text) return;
		if (!this.data.general.includes(text)) this.data.general.push(text);
		if (this.data.general.length > 12) this.data.general.shift();
		this.save();
	}
	note(name, text) {
		text = String(text ?? '').trim().slice(0, 220);
		if (!text) return;
		const list = this.data.notes[name] ??= [];
		if (!list.includes(text)) list.push(text);
		if (list.length > 12) list.shift();
		this.save();
	}
}

// the model, through the local server
export class Brain {
	constructor() {
		this.key = false;
		this.model = '';
		this.calls = 0;
		this.cap = 0;
		this.error = '';
		this.busy = false;
		this.last = 0;
	}
	async check() {
		try {
			const r = await fetch('/ai/status');
			const d = await r.json();
			this.key = !!d.key;
			this.model = d.model;
			this.calls = d.calls;
			this.cap = d.cap;
			this.error = this.key ? '' : 'no key on the server: rehearsal only';
		} catch { this.key = false; this.error = 'no AI server (use tools/devserver.py)'; }
		return this.key;
	}
	// ask for one move; resolves null if the model is unavailable, so the climber can fall back on its own rehearsal
	async ask(text, { system = SYSTEM, timeout = 14000 } = {}) {
		if (!this.key || this.busy) return null;
		this.busy = true;
		// a model that takes too long is not waited for: the climber moves on with its own best rehearsal
		const stop = new AbortController();
		const timer = setTimeout(() => stop.abort(), timeout);
		try {
			const wait = 1100 - (performance.now() - this.last);
			if (wait > 0) await new Promise(r => setTimeout(r, wait));
			const r = await fetch('/ai/chat', { method: 'POST', signal: stop.signal, body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }) });
			const d = await r.json();
			this.last = performance.now();
			if (!r.ok) { this.error = d.error ?? `error ${r.status}`; if (r.status === 429 || r.status === 501) this.key = false; return null; }
			this.calls = d.calls;
			this.error = '';
			const out = JSON.parse(d.content);
			return out && typeof out === 'object' ? out : null;
		} catch (e) { this.error = e.name === 'AbortError' ? 'the model was too slow' : String(e.message ?? e).slice(0, 80); return null; } finally { clearTimeout(timer); this.busy = false; }
	}
}

// the model's answer as a move among what was rehearsed, or null if it makes no sense
export function choose(answer, candidates, sim) {
	if (!answer) return null;
	const c = Number.isInteger(answer.candidate) ? candidates.find(x => x.id === answer.candidate) : null;
	if (c) return { limb: c.limb, hold: c.hold, lean: c.lean, from: 'candidate' };
	const u = answer.custom;
	if (u && Number.isInteger(u.limb) && Number.isInteger(u.hold) && u.limb >= 0 && u.limb < 4 && u.hold >= 0 && u.hold < sim.holds().length)
		return { limb: u.limb, hold: u.hold, lean: Math.max(0, ShiftNames.indexOf(String(u.lean ?? 'none'))), from: 'custom' };
	return null;
}

export { TEACHER };
