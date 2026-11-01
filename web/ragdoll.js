// a fall: the climber's body as a loose chain of points under gravity, tumbling off the wall onto the mats.
// verlet points joined by fixed-length links; the torso and head are braced rigid, elbows and knees cannot fold flat. unreal centimeters.

import { Vec3 } from './sim.js';
import { floorAt } from './world.js';
import { Bones } from './climber.js';

const Gravity = 980, Tick = 1 / 120;
// points: 0-3 the hips and shoulders (right, left), 4 the head, 5-8 the knees and elbows, 9-12 the ankles and wrists, 13-14 the toes, 15-16 the palms
const Radius = [9, 9, 8, 8, 11, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4];

export class Ragdoll {
	// from a solved pose, moving at Velocity (cm/s), falling off the wall of Route
	constructor(pose, velocity, route) {
		const l = pose.limbs;
		const points = [...pose.roots, pose.head, ...l.map(x => x.bend), ...l.map(x => x.end), l[0].foot.toe, l[1].foot.toe, l[2].hand.palm, l[3].hand.palm];
		// anything that slid below the mat surface on the way off the wall starts on top of it
		this.now = points.map((p, i) => new Vec3(p.x, p.y, Math.max(p.z, floorAt(p.x, p.y) + Radius[i])));
		// the body pushes off and the top tips back first, so it lands on its back and shoulders the way most falls do
		const out = new Vec3(pose.back.x, pose.back.y, 0).norm();
		this.was = points.map((p, i) => {
			const tumble = i === 4 ? 130 : i === 2 || i === 3 ? 95 : i === 0 || i === 1 ? 45 : [11, 12, 15, 16].includes(i) ? 80 : 20;
			return this.now[i].sub(velocity.add(out.mul(tumble)).mul(Tick));
		});
		const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2], [4, 2], [4, 3], [4, 0], [4, 1]];
		for (let i = 0; i < 4; i++) pairs.push([i, 5 + i], [5 + i, 9 + i]);
		pairs.push([9, 13], [5, 13], [10, 14], [6, 14], [11, 15], [7, 15], [12, 16], [8, 16]);
		this.links = pairs.map(([a, b]) => ({ a, b, rest: points[a].dist(points[b]), apart: false }));
		for (let i = 0; i < 4; i++) this.links.push({ a: i, b: 9 + i, rest: Bones[i] * (i < 2 ? 0.55 : 0.5), apart: true });
		this.route = route;
		this.time = 0;
		this.motion = Infinity;
		this.landed = false;
	}

	step(delta) {
		this.time += delta;
		let moved = 0;
		for (let n = Math.max(1, Math.round(delta / Tick)); n > 0; n--) {
			for (let i = 0; i < this.now.length; i++) {
				const p = this.now[i];
				const v = p.sub(this.was[i]).mul(0.996);
				this.was[i] = p;
				this.now[i] = p.add(v).add(new Vec3(0, 0, -Gravity * Tick * Tick));
			}
			for (let pass = 0; pass < 8; pass++) {
				for (const link of this.links) {
					const a = this.now[link.a], b = this.now[link.b];
					const gap = b.sub(a);
					const length = gap.len();
					if (length < 1e-6 || (link.apart && length >= link.rest)) continue;
					const fix = gap.mul((length - link.rest) / length * 0.5);
					this.now[link.a] = a.add(fix);
					this.now[link.b] = b.sub(fix);
				}
				for (let i = 0; i < this.now.length; i++) this.now[i] = this.collide(this.now[i], Radius[i]);
			}
			// the mats grab whatever lies on them
			for (let i = 0; i < this.now.length; i++) {
				const p = this.now[i];
				if (p.z > floorAt(p.x, p.y) + Radius[i] + 0.5) continue;
				this.landed = true;
				const w = this.was[i];
				// and soak up the landing instead of bouncing it back
				this.was[i] = new Vec3(p.x + (w.x - p.x) * 0.55, p.y + (w.y - p.y) * 0.55, Math.max(w.z, p.z - 0.4));
			}
		}
		for (let i = 0; i < this.now.length; i++) moved = Math.max(moved, this.now[i].dist(this.was[i]) / Tick);
		this.motion = moved;
	}

	collide(p, r) {
		const floor = floorAt(p.x, p.y) + r;
		if (p.z < floor) p = new Vec3(p.x, p.y, floor);
		// the wall the body came off stays solid behind it
		for (const panel of this.route.near ? this.route.near(p) : this.route.panels) {
			const rel = p.sub(panel.origin);
			const along = rel.dot(panel.up);
			if (along < -20 || along > panel.length * 100 + 20) continue;
			const depth = rel.dot(panel.out);
			if (depth < r && depth > -60) p = p.add(panel.out.mul(r - depth));
		}
		return p;
	}

	// down and still
	settled() { return this.landed && this.time > 1.2 && this.motion < 25; }

	pose() {
		const P = this.now;
		const pelvis = P[0].add(P[1]).mul(0.5), chest = P[2].add(P[3]).mul(0.5);
		const up = chest.sub(pelvis).norm();
		const right = P[2].sub(P[3]).norm();
		const forward = right.cross(up).norm();
		const limbs = [0, 1, 2, 3].map(i => {
			const end = P[9 + i], bend = P[5 + i];
			if (i < 2) {
				const toe = P[13 + i];
				const shin = bend.sub(end).norm();
				return { end, bend, joint: end, pole: forward, foot: { toe, heel: end.sub(toe.sub(end).mul(0.35)).sub(shin.mul(6)), up: shin } };
			}
			const palm = P[15 + i - 2];
			const over = palm.sub(end).norm();
			const side = right.mul(i === 2 ? 1 : -1);
			const out = side.sub(over.mul(side.dot(over))).norm();
			const thumb = forward.sub(over.mul(forward.dot(over))).sub(out.mul(forward.dot(out))).norm();
			return { end, bend, joint: end, pole: forward, hand: { palm, over, out, thumb, grip: 'free' } };
		});
		return { roots: P.slice(0, 4), up, back: forward.mul(-1), head: P[4], look: forward, limbs, marker: null };
	}
}
