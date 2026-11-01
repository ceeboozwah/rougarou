// a second climber who is an AI. it tours the gym, goes to the easiest problem it has not sent, pulls on, and climbs it one move at a time:
// each move is chosen by OpenAI (through tools/devserver.py) from moves it has rehearsed on a copy of its own body, or by its own best
// rehearsal when there is no key. every go is written in a notebook (Memory) that goes into the next prompt, so it learns a problem as it falls off it.
// when it sends a problem it moves on to the next hardest. it has its own Sim, so it and the player can be on the wall at once.

import * as THREE from 'three';
import { Sim, Vec2, Vec3 } from './sim.js';
import { Climber, walkPose, blend, solve } from './climber.js';
import { Figure } from './figure.js';
import { Ragdoll } from './ragdoll.js';
import { floorAt } from './world.js';
import { toThree } from './gym.js';
import { Setter } from './setter.js';
import { rehearse, blindList, describe, choose, Shifts, ShiftNames, TEACHER } from './brain.js';

const Z = new Vec3(0, 0, 1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => t * t * (3 - 2 * t);
const mid = (a, b) => a.add(b).mul(0.5);
const turn = (a, b, step) => { const gap = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + clamp(gap, -step, step); };
const three = (v) => new THREE.Vector3(...toThree(v));
const number = (route) => parseInt(String(route.grade).replace(/\D/g, ''), 10) || 0;
// how many sends of a problem before it moves on to the next hardest
const NEED = 1;
// give up an attempt after this many moves, or this long without climbing higher
const MOVES = 30, STALL = 40;
// this many moves in a row without getting higher and it jumps down to try again with what it has learned
const FLAT = 10;
// the last moves it will not repeat
const RECENT = 8;

export class Agent {
	constructor({ scene, routes, spots, world, brain, memory, hooks }) {
		Object.assign(this, { scene, routes, spots, world, brain, memory });
		this.sim = new Sim(routes);
		this.on = false;
		this.blind = false;
		this.apprentice = false;
		this.setting = false;
		this.testing = null;
		this.said = '';
		this.sayUntil = 0;
		this.setter = new Setter({ agent: this, scene, routes, world, brain, memory, hooks });
		this.player = null;
		this.demo = null;
		this.flat = 0;
		this.peak = 0;
		this.mode = 'off';
		this.status = '';
		this.thought = '';
		this.clock = 0;
		this.at = new Vec3(450, 300, 28);
		this.yaw = Math.PI;
		this.heading = new Vec3(-1, 0, 0);
		this.speed = 0;
		this.amp = 0;
		this.phase = 0;
		this.pose = null;
		this.climber = null;
		this.token = 0;
		this.index = 0;
		this.moves = [];
		this.job = null;
		this.thinking = false;
		this.banked = 0;
		this.stop = [];
		this.t = 0;
		this.best = 0;
		this.lastGain = 0;
		this.log = [];
	}

	// the curriculum: problems by grade, easiest first, ties in gym order; the next one it has not sent
	order() { return this.routes.map((r, i) => i).sort((a, b) => number(this.routes[a]) - number(this.routes[b]) || a - b); }
	next() { return this.order().find(i => this.memory.sends(this.routes[i].name) < NEED) ?? -1; }

	async enable() {
		if (this.on) return;
		this.on = true;
		if (!this.climber) {
			this.climber = new Climber(this.scene);
			this.climber.setOutfit({ shorts: '#b8392f' });
			this.tag = this.makeTag();
			if (!new URLSearchParams(location.search).has('tubes'))
				Figure.load('./assets/character/climber.glb').then(f => this.climber.wear(f)).catch(() => {});
		}
		this.climber.group.visible = true;
		this.tag.visible = true;
		await Promise.all([this.memory.load(), this.brain.check()]);
		this.at = new Vec3(450, 300, 28);
		this.pose = solve(walkPose({ at: this.at, yaw: this.yaw }, 0));
		if (!this.memory.data.toured) {
			this.stop = this.order().map(i => i);
			this.mode = 'tour';
		} else this.mode = 'approach';
		this.index = this.next();
		this.t = 0;
	}

	disable() {
		this.on = false;
		this.mode = 'off';
		this.job = null;
		this.token++;
		if (this.climber) this.climber.group.visible = false;
		if (this.tag) this.tag.visible = false;
	}

	makeTag() {
		const paper = document.createElement('canvas');
		paper.width = 512;
		paper.height = 160;
		const map = new THREE.CanvasTexture(paper);
		map.colorSpace = THREE.SRGBColorSpace;
		const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
		sprite.scale.set(0.9, 0.28, 1);
		sprite.renderOrder = 9;
		this.scene.add(sprite);
		this.paper = paper;
		this.map = map;
		return sprite;
	}

	paint(a, b) {
		const key = a + '|' + b;
		if (key === this.painted) return;
		this.painted = key;
		const g = this.paper.getContext('2d');
		g.clearRect(0, 0, 512, 160);
		g.fillStyle = 'rgba(16, 16, 20, 0.84)';
		g.beginPath();
		g.roundRect(0, 0, 512, 160, 30);
		g.fill();
		g.fillStyle = '#f3efe6';
		g.font = '800 62px ui-rounded, system-ui, sans-serif';
		g.fillText(a, 28, 78);
		g.fillStyle = 'rgba(243, 239, 230, 0.7)';
		g.font = '700 38px ui-rounded, system-ui, sans-serif';
		g.fillText(b, 30, 130);
		this.map.needsUpdate = true;
	}

	// a line over his head for a few seconds
	say(text, secs = 3.5) { this.said = String(text).slice(0, 60); this.sayUntil = (this.climber?.clock ?? 0) + secs; }

	get route() { return this.routes[this.index]; }
	get name() { return this.route?.name ?? ''; }

	// a short line for the screen
	summary() {
		if (!this.on) return '';
		const r = this.route;
		const where = r ? `${r.name} ${r.grade}` : 'every problem sent';
		const key = this.brain.key ? `${this.brain.model} ${this.brain.calls}/${this.brain.cap}` : this.brain.error || 'rehearsal only';
		return `ai: ${this.status || this.mode} · ${where} · try ${this.memory.tries(this.name) + (this.mode === 'climb' ? 0 : 1)} · sent ${this.sentCount()}/${this.routes.length} · ${key}`;
	}
	sentCount() { return this.routes.filter(r => this.memory.sends(r.name) >= NEED).length; }

	// ------------------------------------------------------------ walking
	standing(delta, goal, face) {
		const gap = new Vec3(goal.x - this.at.x, goal.y - this.at.y, 0);
		const near = gap.len();
		let wish = near > 6 ? gap.norm().mul(clamp(near / 60, 0.25, 1)) : new Vec3();
		this.speed += (wish.len() * 150 - this.speed) * Math.min(1, delta * 8);
		if (wish.len() > 0.05) { this.heading = wish.norm(); this.yaw = turn(this.yaw, Math.atan2(wish.y, wish.x), delta * 9); }
		else if (face !== undefined) this.yaw = turn(this.yaw, face, delta * 5);
		const next = this.world.move(this.at, this.heading.mul(this.speed * delta));
		const moved = Math.hypot(next.x - this.at.x, next.y - this.at.y);
		this.phase += moved / 130 * Math.PI * 2;
		this.at = new Vec3(next.x, next.y, this.at.z + (floorAt(next.x, next.y) - this.at.z) * Math.min(1, delta * 14));
		this.amp += (clamp(moved / Math.max(delta, 1e-3) / 165, 0, 1.4) - this.amp) * Math.min(1, delta * 10);
		// a wall or a mat edge in the way for too long: step through it
		this.stuck = moved < 0.05 && near > 12 ? (this.stuck ?? 0) + delta : 0;
		if (this.stuck > 4) { this.at = new Vec3(goal.x, goal.y, this.at.z); this.stuck = 0; }
		return near;
	}

	walkPose(look) { return solve(walkPose({ at: this.at, yaw: this.yaw, phase: this.phase, amp: this.amp, look }, this.climber.clock)); }

	// ------------------------------------------------------------ the frame
	update(delta) {
		if (!this.on || !this.climber) return;
		delta = Math.min(delta, 0.1);
		this.climber.clock += delta;
		this.follow();
		const run = this[`mode_${this.mode}`];
		if (run) run.call(this, delta);
		if (this.pose) this.climber.draw(this.pose);
		if (this.pose) {
			const head = mid(this.pose.roots[2], this.pose.roots[3]).add(Z.mul(55));
			this.tag.position.copy(three(head));
			this.paint(`TUCK · ${this.route ? this.route.grade : ''} ${this.name}`.trim(), this.climber.clock < this.sayUntil ? this.said : (this.thought ? this.thought.slice(0, 30) : this.status || this.mode).slice(0, 30));
		}
	}

	// switching between playing and watching the human: leave the wall, or go back to climbing
	follow() {
		if (this.setting && !this.apprentice) {
			if (['approach', 'tour', 'shadow'].includes(this.mode) && !this.testing) { this.mode = 'set'; this.pose ??= this.walkPose(); }
			if (this.mode === 'set' && !this.setter.running) this.setter.start();
			return;
		}
		if (this.mode === 'set' || this.setter.running) {
			this.setter.stop();
			if (this.mode === 'set') this.mode = 'approach';
		}
		if (this.apprentice && ['climb', 'mount', 'cheer', 'approach', 'tour'].includes(this.mode)) {
			if (['climb', 'mount', 'cheer'].includes(this.mode)) { this.token++; this.job = null; this.status = 'jumping down'; this.hopDown(); }
			else this.mode = 'shadow';
		} else if (!this.apprentice && this.mode === 'shadow') this.mode = 'approach';
	}

	// the human's goes, watched: what they did, in order, and how it ended; kept to teach from
	watchStart(route) {
		if (!this.on) return;
		this.watchEnd('left');
		this.demo = { route: this.routes[route].name, moves: [], t0: performance.now() };
	}
	watchMove(limb, hold) {
		if (this.on && this.demo) this.demo.moves.push([limb, hold]);
	}
	watchEnd(result, why = '') {
		const d = this.demo;
		this.demo = null;
		if (!this.on || !d || d.moves.length < 2 || result === 'left') return;
		const entry = { result, why, seconds: +((performance.now() - d.t0) / 1000).toFixed(1), moves: d.moves.slice(0, 40) };
		this.memory.demo(d.route, entry);
		this.status = result === 'sent' ? 'learned from your send' : 'learned from your fall';
		this.learnFrom(d.route, entry);
	}

	// ask the model what the human's climb shows, and keep the lessons as notes for that problem
	async learnFrom(name, entry, tries = 2) {
		if (!this.brain.key) return;
		const route = this.routes.find(r => r.name === name);
		if (!route) return;
		const holds = route.holds.map((h, i) => `${i}: ${h.kind} at (${h.point.x.toFixed(2)}, ${h.point.y.toFixed(2)}) pull (${h.pull.x.toFixed(1)}, ${h.pull.y.toFixed(1)})${i === route.holds.length - 1 ? ' TOP' : ''}`);
		const names = ['right foot', 'left foot', 'right hand', 'left hand'];
		const text = [`PROBLEM: ${route.name} (${route.grade})`, 'HOLDS:', ...holds,
			`THE HUMAN'S MOVES IN ORDER: ${entry.moves.map(([l, h]) => `${names[l]} to ${h}`).join('; ')}`,
			`HOW IT ENDED: ${entry.result === 'sent' ? 'SENT' : `fell (${entry.why})`} after ${entry.seconds}s`,
			`YOUR NOTES: ${this.memory.lessons(name).join(' | ') || 'none'}`].join('\n');
		const answer = await this.brain.ask(text, { system: TEACHER, timeout: 20000 });
		if (!answer && tries > 0) { setTimeout(() => this.learnFrom(name, entry, tries - 1), 3500); return; }
		for (const lesson of (answer?.lessons ?? []).slice(0, 2)) this.memory.note(name, lesson);
	}

	// beside the human at their problem while they climb, or alongside them when they walk
	mode_shadow(delta) {
		const p = this.player;
		if (!p) { this.status = 'waiting for you'; this.wander(delta); return; }
		const side = (v) => new Vec3(-v.y, v.x, 0).norm();
		let goal, face, look;
		if ((p.mode === 'climb' || p.mode === 'mount') && this.spots[p.route]) {
			const spot = this.spots[p.route];
			goal = this.world.clear(spot.at.add(spot.out.mul(115)).add(side(spot.out).mul(105)), spot.out);
			face = spot.yaw;
			look = this.routes[p.route].map(p.pos, 6);
			this.status = this.demo ? `watching you: ${this.demo.moves.length} moves` : 'watching you climb';
		} else {
			goal = this.world.clear(p.at.add(side(p.heading).mul(150)).sub(p.heading.mul(80)), p.heading);
			face = p.yaw;
			this.status = 'following you';
		}
		this.standing(delta, goal, face);
		this.pose = this.walkPose(look);
	}

	// working as the gym's setter: the Setter runs the show a frame at a time
	mode_set(delta) { this.setter.frame(delta); }

	mode_tour(delta) {
		// first visit: walk past every problem and look at it
		const index = this.stop[0];
		if (index === undefined) { this.memory.data.toured = true; this.memory.save(); this.mode = 'approach'; return; }
		const spot = this.spots[index];
		const goal = this.world.clear(spot.at.add(spot.out.mul(130)), spot.out);
		const near = this.standing(delta, goal, spot.yaw);
		this.status = `looking at ${this.routes[index].name}`;
		this.pose = this.walkPose(this.routes[index].map(new Vec2(0, 1.8)));
		if (near < 12) { this.t += delta; if (this.t > 1.4) { this.t = 0; this.stop.shift(); } } else this.t = 0;
	}

	mode_approach(delta) {
		if (this.index < 0) { this.status = 'has sent everything'; this.wander(delta); return; }
		const spot = this.spots[this.index];
		this.status = `walking to ${this.name}`;
		const near = this.standing(delta, spot.at, spot.yaw);
		this.pose = this.walkPose(this.route.map(new Vec2(0, 1.8)));
		const facing = Math.abs(Math.atan2(Math.sin(spot.yaw - this.yaw), Math.cos(spot.yaw - this.yaw))) < 0.3;
		if (near < 18 && facing) this.begin();
	}

	// nothing left to climb: wander between the problems
	wander(delta) {
		if (!this.goal || this.at.dist(this.goal) < 20) {
			const spot = this.spots[Math.floor(Math.random() * this.spots.length)];
			this.goal = this.world.clear(spot.at.add(spot.out.mul(160)), spot.out);
		}
		this.standing(delta, this.goal);
		this.pose = this.walkPose();
	}

	// pulling on: from standing into the start holds
	begin() {
		this.sim.route = this.index;
		this.sim.restart();
		this.climber.reset();
		this.from = this.pose;
		this.mode = 'mount';
		this.t = 0;
		this.moves = [];
		this.job = null;
		this.best = 0;
		this.peak = 0;
		this.flat = 0;
		this.since = 0;
		this.started = this.climber.clock;
		this.token++;
	}

	mode_mount(delta) {
		this.t += delta;
		const k = Math.min(1, this.t / 0.75);
		this.status = 'pulling on';
		this.pose = blend(this.from, this.climber.climbPose(this.sim, -1, 1 / 60), ease(k));
		if (k >= 1) { this.mode = 'climb'; this.idle = 0; this.hang = 0; }
	}

	// ------------------------------------------------------------ climbing
	mode_climb(delta) {
		const sim = this.sim;
		// a job in hand (a shift, then a move) runs on the body each frame; the sim is stepped at 60 Hz
		this.runJob(delta);
		this.banked = Math.min(this.banked + delta, 0.25);
		while (this.banked >= 1 / 60 && !sim.fallen) { sim.step(1 / 60); this.banked -= 1 / 60; }
		this.pose = this.climber.climbPose(sim, -1, delta);
		const height = Math.max(sim.grips[2] >= 0 ? sim.holds()[sim.grips[2]].point.y : 0, sim.grips[3] >= 0 ? sim.holds()[sim.grips[3]].point.y : 0);
		if (height > this.best + 0.05) { this.best = height; this.since = 0; } else this.since += delta;
		if (sim.won) return this.send();
		if (sim.fallen) return this.fall();
		if (this.moves.length >= MOVES || this.since > STALL || this.flat >= FLAT) return this.giveUp();
		if (!this.job && !this.thinking && sim.latch.every(v => v >= 0)) { this.idle += delta; if (this.idle > 0.45) this.decide(); } else this.idle = 0;
		if (!this.thinking && !this.job) this.status = 'hanging on';
	}

	runJob(delta) {
		const sim = this.sim, job = this.job;
		sim.reaching = -1;
		if (!job) { sim.lean = new Vec2(); return; }
		job.t += delta;
		if (job.stage === 'lean') {
			sim.lean = Shifts[job.lean] ?? new Vec2();
			this.status = `shifting ${ShiftNames[job.lean]}`;
			if (!job.lean || job.t >= 0.5) { sim.lean = new Vec2(); job.stage = 'grab'; job.t = 0; }
		} else if (job.stage === 'grab') {
			const ok = sim.grab(job.limb, job.hold);
			this.moves.push({ limb: job.limb, hold: job.hold, lean: job.lean, ok });
			this.status = ok ? `${['right foot', 'left foot', 'right hand', 'left hand'][job.limb]} to ${job.hold}` : 'cannot reach';
			job.stage = ok ? 'settle' : 'done';
			job.t = 0;
		} else if (job.stage === 'settle') {
			if ((sim.latch[job.limb] >= 0 && job.t > 0.5) || job.t > 3) {
				this.job = null;
				// a move that raises a hand or the hips counts as progress; a run of moves that does not means it is going round in circles
				const top = Math.max(this.best, sim.position.y);
				if (top > this.peak + 0.04) { this.peak = top; this.flat = 0; } else this.flat++;
			}
		} else this.job = null;
	}

	// choose the next move: rehearse, ask the model, or take the best rehearsal
	async decide() {
		const sim = this.sim, token = this.token;
		this.thinking = true;
		this.status = this.blind ? 'thinking' : 'rehearsing';
		await new Promise(r => setTimeout(r, 0));
		const candidates = this.blind ? blindList(sim) : rehearse(sim);
		const key = (c) => `${c.limb}:${c.hold}`;
		const recent = this.moves.slice(-RECENT).filter(m => m.limb >= 0).map(m => `${m.limb}:${m.hold}`);
		const star = this.demoNext();
		for (const c of candidates) { c.repeat = recent.includes(key(c)); c.demo = key(c) === star; }
		let move = null;
		if (candidates.length && this.brain.key) {
			this.status = 'asking the model';
			const text = describe({ sim, route: this.route, candidates, attempt: this.memory.tries(this.name) + 1, moves: this.moves, memory: this.memory, calls: this.brain.calls, flat: this.flat });
			const answer = await this.brain.ask(text);
			if (answer) {
				this.thought = String(answer.think ?? '').slice(0, 120);
				if (answer.quip) this.say(answer.quip, 4);
				this.memory.note(this.name, answer.note);
				move = choose(answer, candidates, sim);
			}
		}
		this.thinking = false;
		if (token !== this.token || this.mode !== 'climb') return;
		// no model (or no sense from it): the best safe rehearsal, else the best of anything
		// going round in circles: a model move that repeats a recent one is swapped for something different
		if (move && this.flat >= 3 && recent.includes(`${move.limb}:${move.hold}`)) {
			const other = candidates.find(c => !c.repeat && c.safe);
			if (other) { move = { limb: other.limb, hold: other.hold, lean: other.lean }; this.thought = 'was repeating itself, tried something else'; }
		}
		if (!move) {
			// the human's next step if it is safe, else something not done lately; blind with no model: the highest hand hold
			const fresh = candidates.filter(x => !x.repeat);
			const pool = fresh.length ? fresh : candidates;
			const c = pool.find(x => x.demo && x.safe) ?? (this.blind ? (pool.find(x => x.limb >= 2) ?? pool[0]) : pool.find(x => x.safe && x.gain > 0) ?? pool.find(x => x.safe) ?? pool[0]);
			if (c) move = { limb: c.limb, hold: c.hold, lean: c.lean };
		}
		if (!move) { this.moves.push({ limb: -1, hold: -1, lean: 0, ok: false }); this.job = null; this.status = 'no move found'; this.idle = -1.5; return; }
		this.job = { ...move, stage: 'lean', t: 0 };
	}

	// the next step of the best human climb of this problem that this body has not reached yet, as "limb:hold"
	demoNext() {
		const demos = this.memory.demosFor(this.name).filter(d => d.result === 'sent');
		const demo = demos[demos.length - 1];
		if (!demo) return null;
		const done = new Set(this.moves.filter(m => m.ok !== false).map(m => `${m.limb}:${m.hold}`));
		for (const [l, h] of demo.moves) if (!done.has(`${l}:${h}`) && this.sim.grips[l] !== h) return `${l}:${h}`;
		return null;
	}

	// ------------------------------------------------------------ how an attempt ends
	record(result, why) {
		this.memory.attempt(this.name, { result, moves: this.moves.length, why: why ?? '', seconds: +(this.climber.clock - this.started).toFixed(1), height: +this.best.toFixed(2) });
		this.testing?.(result, why ?? '');
	}

	send() {
		this.record('sent', 'sent');
		this.status = 'SENT it';
		this.say(['sent! put it on my tab', 'ha! take that, wall', 'smooth. very smooth.', 'and the crowd goes mild'][Math.floor(Math.random() * 4)], 4);
		this.thought = '';
		this.token++;
		this.job = null;
		this.mode = 'cheer';
		this.t = 0;
	}

	mode_cheer(delta) {
		this.t += delta;
		this.sim.step(Math.min(delta, 1 / 30));
		this.pose = this.climber.climbPose(this.sim, -1, delta);
		if (this.t > 1.6) this.drop();
	}

	// hop down and on to the next problem
	drop() {
		const spot = this.spots[this.index];
		const hips = this.route.map(this.sim.position, 0);
		this.at = this.world.clear(new Vec3(hips.x, hips.y, 0).add(spot.out.mul(40)), spot.out);
		this.yaw = spot.yaw;
		this.speed = this.amp = 0;
		this.from = this.pose;
		this.to = 'approach';
		this.mode = 'hop';
		this.t = 0;
		if (!this.setting) this.index = this.next();
	}

	mode_hop(delta) {
		this.t += delta;
		const k = Math.min(1, this.t / 1.0);
		this.status = 'dropping off';
		this.pose = blend(this.from, solve(walkPose({ at: this.at, yaw: this.yaw, crouch: 52 }, this.climber.clock)), k * k);
		if (k >= 1) { this.mode = this.apprentice ? 'shadow' : this.testing ? 'approach' : this.setting ? 'set' : 'approach'; this.thought = ''; }
	}

	fall() {
		const sim = this.sim, face = this.route, panel = face.at(sim.position.y);
		this.record('fell', sim.hint);
		this.status = `fell: ${sim.hint}`;
		this.say(['oof. I meant to do that', 'the mat and I are close now', 'gravity: 1, me: 0', 'ow. ok. again.'][Math.floor(Math.random() * 4)], 4);
		this.thought = '';
		this.token++;
		this.job = null;
		const velocity = panel.right.mul(sim.velocity.x * 100).add(panel.up.mul(sim.velocity.y * 100));
		this.ragdoll = new Ragdoll(this.pose, velocity, face);
		this.mode = 'tumble';
		this.t = 0;
	}

	mode_tumble(delta) {
		this.ragdoll.step(delta);
		this.pose = this.ragdoll.pose();
		this.t += delta;
		if (this.ragdoll.settled() || this.ragdoll.time > 3.5) this.rise();
	}

	giveUp(why) {
		this.record('gave up', why ?? (this.flat >= FLAT ? `stuck: no progress for ${this.flat} moves` : this.since > STALL ? 'no higher for a long time' : 'too many moves'));
		this.status = 'jumping down to try again';
		this.token++;
		this.job = null;
		this.hopDown();
	}

	hopDown() {
		this.sim.fall('jumped down');
		const spot = this.spots[this.index] ?? this.spots[0];
		const hips = (this.route ?? this.routes[0]).map(this.sim.position, 0);
		this.at = this.world.clear(new Vec3(hips.x, hips.y, 0).add(spot.out.mul(40)), spot.out);
		this.yaw = spot.yaw;
		this.speed = this.amp = 0;
		this.from = this.pose;
		this.mode = 'hop';
		this.t = 0;
	}

	// up off the mat, a crouch then standing, and back to the start holds
	rise() {
		const spot = this.spots[this.index];
		const pelvis = mid(this.pose.roots[0], this.pose.roots[1]);
		this.at = this.world.clear(new Vec3(pelvis.x, pelvis.y, 0), spot.out);
		this.yaw = spot.yaw;
		this.speed = this.amp = 0;
		this.from = this.pose;
		this.mode = 'hop';
		this.t = 0;
	}
}
