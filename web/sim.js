// the climbing model on an unrolled wall, in meters: x across the wall, y measured up the wall's surface from the floor.
// a problem's wall is a stack of flat angled panels; gravity and peel come from whichever panel a body part is on.
// limbs are 0 right foot, 1 left foot, 2 right hand, 3 left hand.
// a port of unreal/Source/Rougarou/ClimbSim.cpp: keep the two in step.

export class Vec2 {
	constructor(x = 0, y = 0) { this.x = x; this.y = y; }
	add(o) { return new Vec2(this.x + o.x, this.y + o.y); }
	sub(o) { return new Vec2(this.x - o.x, this.y - o.y); }
	mul(s) { return new Vec2(this.x * s, this.y * s); }
	dot(o) { return this.x * o.x + this.y * o.y; }
	len() { return Math.hypot(this.x, this.y); }
	dist(o) { return Math.hypot(this.x - o.x, this.y - o.y); }
	norm() { const l = this.len(); return l > 1e-8 ? this.mul(1 / l) : new Vec2(); }
	clampLen(max) { const l = this.len(); return l > max ? this.mul(max / l) : new Vec2(this.x, this.y); }
	rot(a) { const c = Math.cos(a), s = Math.sin(a); return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c); }
	copy() { return new Vec2(this.x, this.y); }
}

// unreal-space vectors in centimeters: x into the room, y across, z up
export class Vec3 {
	constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
	add(o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
	sub(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
	mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
	dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
	cross(o) { return new Vec3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x); }
	len() { return Math.hypot(this.x, this.y, this.z); }
	dist(o) { return this.sub(o).len(); }
	norm() { const l = this.len(); return l > 1e-8 ? this.mul(1 / l) : new Vec3(); }
	lerp(o, t) { return this.add(o.sub(this).mul(t)); }
	nearZero() { return this.len() < 1e-4; }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const Names = ['right foot', 'left foot', 'right hand', 'left hand'];

export class Panel {
	constructor() {
		this.start = 0;
		this.length = 5;
		this.origin = new Vec3();
		this.right = new Vec3(0, 1, 0);
		this.up = new Vec3(0, 0, 1);
		this.out = new Vec3(1, 0, 0);
	}
}

export class Route {
	constructor(name) {
		this.name = name;
		this.holds = [];
		this.panels = [new Panel()];
		// where the camera stands, centimeters: back from the wall, and to the side along it
		this.stand = 540;
		this.aside = 0;
		// the v-scale grade on the tag at the start
		this.grade = 'V0';
	}
	at(y) {
		for (const p of this.panels) if (y < p.start + p.length) return p;
		return this.panels[this.panels.length - 1];
	}
	// a point on the unrolled wall, Depth centimeters off its surface, in the gym
	map(point, depth = 0) {
		const p = this.at(point.y);
		return p.origin.add(p.right.mul(point.x * 100)).add(p.up.mul((point.y - p.start) * 100)).add(p.out.mul(depth));
	}
	// gravity along the panel as a fraction of g
	down(y) { const p = this.at(y); return new Vec2(-p.right.z, -p.up.z); }
	// 0 vertical, positive overhanging, negative slab
	steep(y) { return -this.at(y).out.z; }
}

export const Spec = { gravity: 9.8, mass: 65, shift: 850, reach: 1.35 };

const Body = {
	seats: [new Vec2(-0.11, -0.26), new Vec2(0.11, -0.26), new Vec2(-0.28, 0.26), new Vec2(0.28, 0.26)],
	lengths: [0.46, 0.46, 0.27, 0.27],
	depths: [0.1, 0.1, 0.14, 0.14],
	// a leg is about a sixth of the body's mass and an arm a twentieth: where they hang turns the body, which is what a flag uses
	masses: [10.5, 10.5, 3.3, 3.3],
	inertia: 5,
};
// how much a hold lets a hand pull the hips in toward the wall: the squeeze a smearing foot or a palm grips with
const Incut = { jug: 1, crimp: 0.55, pocket: 0.75, pinch: 0.85, sloper: 0.25 };
// rubber on plywood grips well, skin much less
const Friction = [1.1, 1.1, 0.6, 0.6];

export class Sim {
	constructor(routes) {
		this.routes = routes;
		this.body = Body;
		this.route = 0;
		this.falls = 0;
		this.hint = '';
		// sweat: hands wear their chalk off and slick hands grip worse. off for the solvers (they climb a hundred meters in a minute) and on for a body being played
		this.sweat = false;
		this.lean = new Vec2();
		this.reaching = -1;
		this.target = new Vec2();
		this.restart();
	}

	// a copy of the body and its state to try a move on, for an agent rehearsing before it commits
	clone() {
		const c = new Sim(this.routes);
		c.route = this.route;
		for (const k of ['position', 'velocity', 'lean', 'goal', 'target']) c[k] = this[k].copy();
		for (const k of ['grips', 'smeared', 'slips', 'pump', 'latch', 'strain', 'loads', 'chalk']) c[k] = [...this[k]];
		c.sweat = this.sweat;
		c.gate = this.gate;
		c.posts = this.posts.map(p => p.copy());
		c.tips = this.tips.map(p => p.copy());
		for (const k of ['angle', 'spin', 'won', 'topped', 'reaching', 'squeeze', 'tipping', 'fallen', 'falls', 'hint']) c[k] = this[k];
		return c;
	}

	holds() { return this.routes[this.route].holds; }
	turn(o) { return o.rot(this.angle); }
	joint(limb) { return this.position.add(this.turn(Body.seats[limb])); }
	rest(limb) {
		const side = limb % 2 === 0 ? -1 : 1;
		return Body.seats[limb].add(new Vec2(side * 0.06, limb >= 2 ? Body.lengths[limb] : -Body.lengths[limb] * 1.6));
	}
	range(limb) { return Math.min(Spec.reach, Body.lengths[limb] * 2 + (limb >= 2 ? 0.08 : 0.04)); }
	distance(limb, point) {
		const across = this.joint(limb).dist(point);
		return Math.sqrt(across * across + Body.depths[limb] * Body.depths[limb]);
	}
	clamp(limb, point) {
		const root = this.joint(limb);
		let result = root.add(point.sub(root).clampLen(this.range(limb)));
		for (let step = 0; step < 80 && this.distance(limb, result) > this.range(limb) - 0.001; step++)
			result = root.add(result.sub(root).mul(0.98));
		if (limb < 2) {
			// a foot stops where the hip runs out of motion: about a high step up, a short way across the body
			const side = limb % 2 === 0 ? -1 : 1;
			result.y = Math.min(result.y, root.y + Body.lengths[limb] * 0.55);
			if (side * (result.x - root.x) < -0.3) result.x = root.x - side * 0.3;
		}
		return result;
	}
	open(limb, point) {
		if (limb >= 2) return true;
		const side = limb % 2 === 0 ? -1 : 1;
		const hip = this.joint(limb);
		return point.y - hip.y <= Body.lengths[limb] * 0.55 + 0.001 && side * (point.x - hip.x) >= -0.3 - 0.001;
	}
	hang(limb) {
		const side = limb % 2 === 0 ? -1 : 1;
		return this.joint(limb).add(new Vec2(side * 0.1, limb >= 2 ? -0.35 : -0.6));
	}
	spot(limb) {
		if (this.grips[limb] >= 0) return this.holds()[this.grips[limb]].point;
		if (this.smeared[limb]) return this.posts[limb];
		if (limb === this.reaching) return this.clamp(limb, this.target);
		return this.hang(limb);
	}
	arrived(limb) { return this.latch[limb] >= 0; }

	restart() {
		// the hips start a little above the middle of the four start holds, wherever a setter put them
		const starts = [0, 1, 2, 3].map(l => this.holds()[l].point);
		this.position = new Vec2(starts.reduce((a, p) => a + p.x, 0) / 4, starts.reduce((a, p) => a + p.y, 0) / 4 + 0.175);
		this.velocity = new Vec2();
		this.angle = 0;
		this.spin = 0;
		this.lean = new Vec2();
		this.grips = [0, 1, 2, 3];
		this.smeared = [false, false, false, false];
		this.posts = [new Vec2(), new Vec2(), new Vec2(), new Vec2()];
		this.slips = [0, 0, 0, 0];
		this.pump = [0, 0, 0, 0];
		this.latch = [1, 1, 1, 1];
		this.strain = [0, 0, 0, 0];
		this.tips = [0, 1, 2, 3].map(l => this.holds()[l].point.copy());
		// how much chalk is on each hand, 1 fresh from the bag to 0 bare (only the hands count): it wears off, and slick hands hold less
		this.chalk = [1, 1, 1, 1];
		this.won = false;
		this.topped = 0;
		this.reaching = -1;
		this.goal = this.position.copy();
		this.loads = [0, 0, 0, 0];
		this.squeeze = 0;
		this.tipping = 0;
		this.fallen = false;
	}

	grab(limb, hold) {
		const holds = this.holds();
		if (hold < 0 || hold >= holds.length) return false;
		if (this.distance(limb, holds[hold].point) > this.range(limb)) {
			this.hint = `${Names[limb]} cannot reach: shift your hips or move a foot`;
			return false;
		}
		if (!this.open(limb, holds[hold].point)) {
			this.hint = `${Names[limb]}: the hip will not open that far`;
			return false;
		}
		// the skeleton has the last word (bodycheck.js): a hold the joints cannot reach, or that would push a knee or elbow into the wall, is refused
		const why = this.gate ? this.gate(this, limb, hold) : null;
		if (why) {
			this.hint = `${Names[limb]}: ${why}`;
			return false;
		}
		this.grips[limb] = hold;
		this.smeared[limb] = false;
		this.slips[limb] = 0;
		this.latch[limb] = -1;
		this.hint = `${Names[limb]} going for the ${holds[hold].kind}`;
		return true;
	}

	smear(limb, point) {
		if (this.distance(limb, point) > this.range(limb) || !this.open(limb, point)) {
			this.hint = `${Names[limb]} cannot reach the wall`;
			return false;
		}
		this.grips[limb] = -1;
		this.smeared[limb] = true;
		this.posts[limb] = point.copy();
		this.slips[limb] = 0;
		this.latch[limb] = -1;
		this.hint = limb >= 2 ? `${Names[limb]} palming the wall: balance, not a pull` : `${Names[limb]} smearing: it sticks as hard as you press it in`;
		return true;
	}

	drop(limb) {
		this.grips[limb] = -1;
		this.smeared[limb] = false;
		this.latch[limb] = 0;
		this.strain[limb] = 0;
	}

	// off the wall: everything lets go and the game takes the body from here
	fall(why) {
		this.fallen = true;
		this.falls++;
		for (let limb = 0; limb < 4; limb++) this.drop(limb);
		this.hint = why;
	}

	step(delta) {
		if (this.fallen) return;
		const face = this.routes[this.route];
		const holds = this.holds();
		const weight2D = face.down(this.position.y).mul(Spec.gravity * Spec.mass);
		let force = this.lean.mul(Spec.shift).add(weight2D);
		// hands and feet travel to where they are sent: quick but not instant, easing in at the end like a placed hand.
		// a limb sent to a hold only bears weight once it gets there, and how settled the catch is depends on how still the body is
		for (let limb = 0; limb < 4; limb++) {
			const destination = this.spot(limb);
			const gap = destination.sub(this.tips[limb]);
			const speed = (limb >= 2 ? 3.2 : 2.4) + this.velocity.len();
			this.tips[limb] = this.tips[limb].add(gap.mul(Math.min(1, delta * 14)).clampLen(speed * delta));
			const root = this.joint(limb);
			this.tips[limb] = root.add(this.tips[limb].sub(root).clampLen(this.range(limb) * 1.15));
			if (this.latch[limb] < 0 && this.tips[limb].dist(destination) < 0.025) {
				this.tips[limb] = destination.copy();
				// the deadpoint: a hold caught with the hips at rest locks right in, one caught mid-swing has to be fought for
				const still = clamp(1 - (this.velocity.len() - 0.15) / 0.9, 0.3, 1);
				this.latch[limb] = still;
				if (limb >= 2 && this.grips[limb] >= 0) this.hint = still > 0.9 ? `${Names[limb]} latched` : `${Names[limb]} caught it moving: hold on`;
			} else if (this.latch[limb] >= 0 && (this.grips[limb] >= 0 || this.smeared[limb])) this.latch[limb] = Math.min(1, this.latch[limb] + delta * 3);
		}
		// reaching past a comfortable stretch: shift the hips toward the target and turn the torso so that shoulder leads.
		// a limb still travelling to its hold keeps reaching for it
		let mover = this.reaching >= 0 && this.grips[this.reaching] < 0 && !this.smeared[this.reaching] ? this.reaching : -1;
		let toward = this.target;
		for (let limb = 0; limb < 4 && mover < 0; limb++)
			if (this.latch[limb] < 0) { mover = limb; toward = this.spot(limb); }
		let reach = new Vec2();
		let twist = 0;
		if (mover >= 0) {
			const excess = this.joint(mover).dist(toward) - this.range(mover) * 0.85;
			if (excess > 0) reach = toward.sub(this.joint(mover)).norm().mul(Math.min(excess, 0.35));
			const seat = this.turn(Body.seats[mover]);
			const lead = toward.sub(this.position);
			const swing = Math.atan2(seat.x * lead.y - seat.y * lead.x, seat.dot(lead));
			if (mover >= 2) twist = clamp(swing * 0.35, -0.5, 0.5);
		}
		// core tension squares the torso back up (or into the reaching twist); one-sided contact can still barn-door
		let torque = clamp(-(this.angle - twist) * 180 - this.spin * 25, -90, 90);
		// each limb's weight hangs where the limb is: a leg out to one side turns the body that way.
		// a free leg flagged across to the side of the holds is a counterweight that stops a barn door
		const pull = face.down(this.position.y).mul(Spec.gravity);
		for (let limb = 0; limb < 4; limb++) {
			const arm = this.joint(limb).add(this.tips[limb]).mul(0.5).sub(this.position);
			torque += (arm.x * pull.y - arm.y * pull.x) * Body.masses[limb];
		}
		// hands that end up below the shoulder stop the legs from standing the hips up past them
		let stretch = 0;
		for (let limb = 2; limb < 4; limb++)
			if (this.grips[limb] >= 0 && this.arrived(limb) && holds[this.grips[limb]].point.y < this.joint(limb).y)
				stretch = Math.max(stretch, this.distance(limb, holds[this.grips[limb]].point) / (Body.lengths[limb] * 2));

		// bare wall only grips by friction, so it needs something pressing the body into the wall: a slab leaning the body onto it,
		// or hands on holds pulling the hips in (body tension). an overhang pulls the body off and eats that squeeze
		let squeeze = Spec.mass * Spec.gravity * -face.steep(this.position.y);
		let sharing = 0;
		for (let limb = 0; limb < 4; limb++) {
			if (!this.arrived(limb)) continue;
			if (this.smeared[limb] && this.grips[limb] < 0) sharing += limb < 2 ? 2 : 1;
			else if (limb >= 2 && this.grips[limb] >= 0)
				squeeze += 380 * (Incut[holds[this.grips[limb]].kind] ?? 0.5) * (1 - 0.5 * this.pump[limb]) * (0.5 + 0.5 * this.latch[limb]);
		}
		this.squeeze = Math.max(0, squeeze);
		const friction = (limb) => Friction[limb] * this.squeeze * (limb < 2 ? 2 : 1) / Math.max(sharing, 1);

		const contacts = [];
		let stance = new Vec2();
		let weight = 0;
		for (let limb = 0; limb < 4; limb++) {
			const press = this.grips[limb] < 0 && this.smeared[limb];
			if ((this.grips[limb] < 0 && !press) || !this.arrived(limb)) { this.strain[limb] = 0; continue; }
			const hold = press ? null : holds[this.grips[limb]];
			const point = press ? this.posts[limb] : hold.point;
			// legs are far stronger than arms; pump saps the arms; a smear only carries a fraction
			// a press can be loaded past what friction holds: it then skates off, gradually
			let capacity = (limb < 2 ? 1100 : 700 * (1 - 0.4 * this.pump[limb])) * (0.5 + 0.5 * this.latch[limb]);
			if (press) capacity = Math.min(capacity, friction(limb) * 1.3);
			contacts.push({ limb, point, hold, press, capacity, applied: new Vec2() });
			// a palm steadies the body but never decides where the hips go
			const vote = limb < 2 ? 2 : press ? 0 : 1;
			if (!vote) continue;
			stance = stance.add(point.sub(this.turn(this.rest(limb))).mul(vote));
			weight += vote;
		}

		// what one limb can actually deliver of a requested force on the body
		const allow = (c, request) => {
			const away = this.joint(c.limb).sub(c.point).norm();
			const extension = this.distance(c.limb, c.point) / (Body.lengths[c.limb] * 2);
			const push = request.dot(away);
			if (c.press) {
				// bare wall cannot be pulled on, only pushed against: a palm presses, a smear stands
				if (push < 0) request = request.sub(away.mul(push));
				else if (c.limb < 2) request = request.sub(away.mul(push * clamp((extension - 0.9) / 0.15, 0, 1)));
			} else if (c.limb >= 2) {
				// hands only pull, and a hand below its shoulder only steadies until the arm runs out of length
				if (push > 0) request = request.sub(away.mul(push));
				if (c.point.y < this.joint(c.limb).y && request.y < 0)
					request = new Vec2(request.x, request.y * (0.15 + 0.85 * clamp((extension - 0.9) / 0.1, 0, 1)));
			} else if (push > 0) {
				// legs push until straight, and never stand the hips up past a gripping hand
				request = request.sub(away.mul(push * clamp(Math.max(extension - 0.9, stretch - 0.6) / 0.15, 0, 1)));
			} else {
				// a foot can barely pull
				request = request.sub(away.mul(push * 0.8));
			}
			return request;
		};

		if (weight > 0) {
			// the hips ease toward the stance at a human pace instead of snapping, which keeps the load on the fingers smooth
			const wanted = stance.mul(1 / weight).add(reach);
			this.goal = this.goal.add(wanted.sub(this.goal).mul(Math.min(1, delta * 6)).clampLen(1.2 * delta));
			let needed = this.goal.sub(this.position).mul(2400).sub(this.velocity.mul(520)).sub(weight2D);
			for (let pass = 0; pass < 4 && needed.len() > 1; pass++) {
				let open = 0;
				for (const c of contacts) open += Math.max(0, c.capacity - c.applied.len());
				if (open <= 1) break;
				let given = new Vec2();
				for (const c of contacts) {
					const headroom = Math.max(0, c.capacity - c.applied.len());
					if (headroom <= 0) continue;
					const total = c.applied.add(allow(c, needed.mul(headroom / open))).clampLen(c.capacity);
					given = given.add(total.sub(c.applied));
					c.applied = total;
				}
				needed = needed.sub(given);
				if (given.len() < 1) break;
			}
		}

		for (const c of contacts) {
			const limb = c.limb;
			force = force.add(c.applied);
			const seat = this.turn(Body.seats[limb]);
			torque += seat.x * c.applied.y - seat.y * c.applied.x;
			const load = c.applied.mul(-1);
			const direction = c.press ? new Vec2(0, -1) : c.hold.pull;
			const kind = c.press ? 'smear' : c.hold.kind;
			let matchup = load.len() > 0.001 ? Math.max(0, load.norm().dot(direction)) : 1;
			// a pinch is squeezed from both sides, so it holds in most directions; a pocket only works pulled straight
			if (kind === 'pinch') matchup = Math.max(matchup, 0.6);
			if (kind === 'pocket') matchup = matchup * matchup;
			const grip = { smear: 260, jug: 1000, crimp: 600, pinch: 650, pocket: 560 }[kind] ?? 480;
			// steep faces try to peel the body off: holds need more grip and feet cut loose; slabs press the feet in
			const steep = face.steep(c.point.y);
			const peel = steep > 0 ? 1 - steep * (limb < 2 ? 0.7 : 0.45) : 1 - steep * (limb < 2 ? 0.3 : 0);
			// a fresh catch has not settled yet: the fingers are still finding the hold
			const limit = c.press ? friction(limb) * (0.45 + 0.55 * this.latch[limb])
				: grip * (0.5 + 0.5 * matchup) * (limb < 2 ? 1.45 : 1) * (1 - 0.5 * this.pump[limb]) * peel * (0.45 + 0.55 * this.latch[limb]) * (limb >= 2 && this.sweat ? 0.8 + 0.2 * this.chalk[limb] : 1);
			const effort = load.len() / Math.max(limit, 1);
			this.strain[limb] = effort;
			this.loads[limb] = load.len();
			if (limb >= 2 && !c.press) {
				// hard holds pump the forearm, a bent lock-off far faster than hanging off a straight arm; a relaxed hang slowly recovers
				const bend = clamp((0.95 - this.distance(limb, c.point) / (Body.lengths[limb] * 2)) / 0.4, 0, 1);
				this.pump[limb] = clamp(this.pump[limb] + delta * (effort > 0.3 ? (effort - 0.3) * 0.12 * (0.7 + 0.9 * bend) : -0.03), 0, 1);
			}
			// sliding is gradual: a brief spike is held, a sustained overload creeps off, a big one rips straight off
			this.slips[limb] = effort > 1 ? this.slips[limb] + delta * (effort - 1) * 5 : Math.max(0, this.slips[limb] - delta * 1.5);
			if (this.slips[limb] <= 0.25 && this.distance(limb, c.point) <= this.range(limb) * 1.15) continue;
			this.drop(limb);
			this.slips[limb] = 0;
			this.hint = c.press ? `${Names[limb]} skated off: bare wall needs weight pressing it in` : `${Names[limb]} slipped: adjust your weight`;
		}
		for (let limb = 0; limb < 4; limb++) if (!contacts.some(c => c.limb === limb)) this.loads[limb] = 0;

		// a hand on a hold sweats its chalk away, faster under load and when pumped
		if (this.sweat)
			for (let limb = 2; limb < 4; limb++)
				if (this.grips[limb] >= 0 && this.arrived(limb)) this.chalk[limb] = Math.max(0, this.chalk[limb] - delta * (0.006 + 0.03 * Math.min(1, this.strain[limb]) + 0.02 * this.pump[limb]));

		// a hand off the wall shakes out
		for (let limb = 2; limb < 4; limb++)
			if (this.grips[limb] < 0) this.pump[limb] = Math.max(0, this.pump[limb] - delta * 0.2);
		this.velocity = this.velocity.add(force.mul(delta / Spec.mass)).mul(1 / (1 + delta * 0.55));
		this.spin = (this.spin + torque / Body.inertia * delta) / (1 + delta * 6);
		this.position = this.position.add(this.velocity.mul(delta));
		this.angle += this.spin * delta;
		// standing on feet alone only works on a low slab; anywhere steeper the body tips back off the wall
		// a palm only steadies while something presses it into the wall
		const steadied = [2, 3].some(l => this.arrived(l) && (this.grips[l] >= 0 || (this.smeared[l] && Friction[l] * this.squeeze > 120)));
		this.tipping = steadied || face.steep(this.position.y) < -0.4 ? 0 : this.tipping + delta;
		if (this.position.y < 0.62) this.fall('fell: try moving a foot before reaching');
		else if (this.tipping > 0.35) this.fall('tipped off: keep a hand on before moving the other');
		else if (Math.abs(this.angle) > 1.5) this.fall('barn-doored off: flag a leg or get a foot on that side');
		const top = holds.length - 1;
		// a send is both hands matched on the finish hold, held under control
		this.topped = this.grips[2] === top && this.grips[3] === top && this.arrived(2) && this.arrived(3) ? this.topped + delta : 0;
		if (this.topped > 0.5 && !face.endless) this.won = true;
	}
}
