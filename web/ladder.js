// a step ladder the setter leans against the wall to reach holds above the floor, and the poses for raising it, climbing it and working from it.
// everything in unreal space (centimeters, x into the room, y across, z up) like the other poses; the mesh is placed through toThree.
// the climb is the real rhythm: three points always on, one limb at a time, right hand, left foot, left hand, right foot, a rung each.

import * as THREE from 'three';
import { Vec3 } from './sim.js';
import { toThree } from './gym.js';
import { walkPose, solve, handOn } from './climber.js';

const Z = new Vec3(0, 0, 1);
const three = (v) => new THREE.Vector3(...toThree(v));
const dirOf = (v) => three(v).normalize();
const ease = (t) => t * t * (3 - 2 * t);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RUNG = 30, FIRST = 30, WIDTH = 46;
// which limb steps when, in rungs of the body's climb: right hand, left foot, left hand, right foot (a diagonal, as a person climbs)
const Order = [{ limb: 2, phase: 0, rise: 5 }, { limb: 1, phase: 0.25, rise: 0 }, { limb: 3, phase: 0.5, rise: 5 }, { limb: 0, phase: 0.75, rise: 0 }];
// the fraction of a rung over which a limb travels to the next
const STEP = 0.32;

export class Ladder {
	constructor(scene) {
		this.scene = scene;
		this.group = new THREE.Group();
		this.group.visible = false;
		scene.add(this.group);
		this.metal = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.45, metalness: 0.6 });
		this.rubber = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.9 });
		this.angle = 75;
		this.raised = 1;
		this.on = false;
	}

	// lean against the wall: the foot on the floor at Base, climbing toward F (a horizontal unit vector, toward the wall), Length long
	place(base, f, length, angle = 75) {
		this.base = base;
		this.f = f;
		this.length = length;
		this.angle = angle;
		this.raised = 0;
		this.on = true;
		for (const c of [...this.group.children]) { c.geometry?.dispose(); this.group.remove(c); }
		const rail = new THREE.BoxGeometry(0.045, length / 100, 0.028);
		for (const side of [-1, 1]) {
			const m = new THREE.Mesh(rail, this.metal);
			m.position.set(side * WIDTH / 200, length / 200, 0);
			m.castShadow = true;
			this.group.add(m);
			const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.05), this.rubber);
			foot.position.set(side * WIDTH / 200, 0.01, 0);
			this.group.add(foot);
		}
		const rung = new THREE.CylinderGeometry(0.016, 0.016, WIDTH / 100, 10);
		rung.rotateZ(Math.PI / 2);
		for (let p = FIRST; p < length - 10; p += RUNG) {
			const m = new THREE.Mesh(rung, this.metal);
			m.position.set(0, p / 100, 0);
			m.castShadow = true;
			this.group.add(m);
		}
		this.group.visible = true;
		this.pose();
	}

	remove() { this.on = false; this.group.visible = false; }

	// the current lean: it tips up from nearly flat to its angle as it is raised (0 to 1)
	get tilt() { return (8 + (this.angle - 8) * ease(clamp(this.raised, 0, 1))) * Math.PI / 180; }
	get axis() { return new Vec3(this.f.x * Math.cos(this.tilt), this.f.y * Math.cos(this.tilt), Math.sin(this.tilt)); }
	get lateral() { return new Vec3(-this.f.y, this.f.x, 0); }
	// the point Param centimeters up the middle of the ladder
	point(param) { return this.base.add(this.axis.mul(param)); }
	rung(index) { return FIRST + index * RUNG; }

	pose() {
		const a = dirOf(this.axis), l = dirOf(this.lateral);
		const x = l, y = a, z = x.clone().cross(y).normalize();
		this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
		this.group.position.copy(three(this.base));
	}
	update(raised) { if (raised !== undefined) this.raised = raised; if (this.on) this.pose(); }
}

// a hand around a rung or rail (or on a hold): the wrist and the frame the fingers shape around
function grip(wrist, over, side, thumbSide) {
	const out = Z;
	const thumb = thumbSide.mul(-side);
	return { end: wrist, pole: new Vec3(0, 0, -0.6).add(thumbSide.mul(side * 0.8)), hand: { palm: wrist.add(over.mul(5.5)).sub(out.mul(0.8)), over, out, thumb, grip: 'jug' } };
}

// where the hips go when the feet are on the rung at coordinate Q: in front of the ladder at their own height, so the body leans into it
// the way a person's does; a floor point for walkPose to stand on, and how far to tip the shoulders and head toward the ladder
function stance(ladder, q) {
	const feet = ladder.point(ladder.rung(q));
	const param = (feet.z + 87 - ladder.base.z) / Math.sin(ladder.tilt);
	const plane = ladder.point(param);
	const f = ladder.f;
	return { at: new Vec3(plane.x - f.x * 20, plane.y - f.y * 20, feet.z - 10), lean: 8 };
}

// the torso tipped toward the ladder: shoulders and head move forward, the hips and legs stay
function tip(p, f, cm) {
	for (const i of [2, 3]) p.roots[i] = p.roots[i].add(f.mul(cm));
	p.head = p.head.add(f.mul(cm));
	const pelvis = p.roots[0].add(p.roots[1]).mul(0.5), chest = p.roots[2].add(p.roots[3]).mul(0.5);
	p.up = chest.sub(pelvis).norm();
}

// both feet on a rung (the floor of the ladder), as when standing and working
function feetOnRung(p, ladder, index) {
	const f = ladder.f, r = new Vec3(-f.y, f.x, 0), rungAt = ladder.point(ladder.rung(index));
	for (const limb of [0, 1]) {
		const side = limb % 2 === 0 ? 1 : -1;
		const toe = rungAt.add(r.mul(side * 12)).add(f.mul(8)).add(Z.mul(2.4));
		const ankle = toe.sub(f.mul(15)).add(Z.mul(7));
		p.limbs[limb] = { end: ankle, pole: f.add(r.mul(side * -0.15)), foot: { toe, heel: ankle.sub(f.mul(5)).sub(Z.mul(6.5)), up: Z, dorsum: Z } };
	}
}

// the climber at rung coordinate Q (a float: the feet's rung) of the ladder, mid climb, with Look for the head
export function ladderPose(ladder, q, clock, look) {
	const f = ladder.f, r = new Vec3(-f.y, f.x, 0);
	const s = stance(ladder, q);
	const p = walkPose({ at: s.at, yaw: Math.atan2(f.y, f.x), look }, clock);
	tip(p, f, s.lean);
	const over = new Vec3(f.x * 0.95, f.y * 0.95, 0.12).norm();
	for (const { limb, phase, rise } of Order) {
		const x = q - phase, n = Math.floor(x), frac = x - n;
		const moving = frac < STEP;
		const index = rise + n + (moving ? ease(frac / STEP) - 1 : 0);
		const lift = moving ? Math.sin(Math.PI * frac / STEP) : 0;
		const side = limb % 2 === 0 ? 1 : -1;
		const rungAt = ladder.point(ladder.rung(index));
		if (limb >= 2) {
			// a hand over the rung, a little in from the rail
			const around = rungAt.add(r.mul(side * 17)).add(f.mul(-lift * 9)).add(Z.mul(lift * 5 + 3.2));
			p.limbs[limb] = grip(around.sub(over.mul(5.5)), over, side, r);
		} else {
			// a foot with the ball on the rung, heel dropped
			const toe = rungAt.add(r.mul(side * 12)).add(f.mul(8 - lift * 12)).add(Z.mul(2.4 + lift * 9));
			const ankle = toe.sub(f.mul(15)).add(Z.mul(7));
			const heel = ankle.sub(f.mul(5)).sub(Z.mul(6.5));
			p.limbs[limb] = { end: ankle, pole: f.add(r.mul(side * -0.15)), foot: { toe, heel, up: Z, dorsum: Z } };
		}
	}
	return solve(p);
}

// raising the ladder: both hands on the rails low down, leaning into it as it comes up
export function raisePose(ladder, clock, look) {
	const f = ladder.f, r = new Vec3(-f.y, f.x, 0);
	const at = ladder.base.sub(f.mul(55)).add(new Vec3(0, 0, 0));
	const p = walkPose({ at: new Vec3(at.x, at.y, ladder.base.z), yaw: Math.atan2(f.y, f.x), look }, clock);
	const over = new Vec3(f.x * 0.2, f.y * 0.2, 0.95).norm();
	for (const limb of [2, 3]) {
		const side = limb === 2 ? 1 : -1;
		const hold = ladder.point(Math.min(ladder.length - 20, 110 + 60 * ladder.raised)).add(r.mul(side * 22));
		p.limbs[limb] = grip(hold.sub(over.mul(5.5)), over, side, r);
	}
	return solve(p);
}

// standing (on the floor or a rung) and working a hold with one hand while the other holds the ladder or hangs: At the floor point under the
// hips, Face the wall (a Route), Spot the hold's point on it, Reach 0 to 1 how far the hand is out, Rail the ladder's rail to hold if any
export function workPose({ at, yaw, face, spot, reach, ladder, q, clock, holding }) {
	const frame = face.at(spot.y);
	const contact = face.map(spot, 3);
	const stand = ladder ? stance(ladder, q) : null;
	const side = contact.sub(stand ? stand.at : at).dot(new Vec3(-Math.sin(yaw), Math.cos(yaw), 0)) > 0 ? -1 : 1;
	const arm = side === -1 ? 2 : 3;
	const p = walkPose({ at: stand ? stand.at : at, yaw, look: face.map(spot, 0) }, clock);
	if (stand) tip(p, ladder.f, stand.lean + 6 * reach);
	const over = frame.up;
	const placed = handOn(frame, contact, over, side, holding ? 'crimp' : 'free');
	// the working hand comes up to the hold; the other takes the rail
	const rest = p.limbs[arm];
	const lerp = (a, b, t) => a.add(b.sub(a).mul(t));
	p.limbs[arm] = { ...placed, pole: frame.out.mul(0.6).add(frame.right.mul(side * 0.5)).add(frame.up.mul(-0.6)), end: lerp(rest.end, placed.end, reach) };
	if (reach < 1) p.limbs[arm].hand = { ...placed.hand, palm: lerp(rest.hand.palm, placed.hand.palm, reach) };
	if (ladder) {
		feetOnRung(p, ladder, Math.floor(q));
		const other = arm === 2 ? 3 : 2, s = other === 2 ? 1 : -1, r = new Vec3(-ladder.f.y, ladder.f.x, 0);
		const rail = ladder.point(ladder.rung(q + 5.4)).add(r.mul(s * 21));
		const h = new Vec3(ladder.f.x * 0.2, ladder.f.y * 0.2, 0.95).norm();
		p.limbs[other] = grip(rail.sub(h.mul(5.5)), h, s, r);
	}
	return solve(p);
}
