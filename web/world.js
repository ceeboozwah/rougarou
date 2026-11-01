// the gym as something to walk around in and fall onto: the floor and mats, and what is solid at a given height.
// walls come from the same sections, arch and blockout gym.js builds, so the collision matches what is drawn. unreal centimeters.

import { Vec3 } from './sim.js';
import { Sections, ArchOuter, ArchInner, ArchStart, ArchLength, ArchCenter, Door, Room } from './gym.js';

// how wide the walker is
export const Radius = 22;

// the mats cover the room right up to the back wall
export const floorAt = (x, y) => (x > -58 && x < 2548 && Math.abs(y) < 1498) || (x >= 2548 && x < Room.x1 && Math.abs(y) < (x < Room.x0 ? Door.width / 2 : Room.half)) ? 28 : 0;

// where a horizontal line at height Z crosses a closed cross-section: its left and right edges, or null above it
function span(points, z) {
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i], b = points[i + 1];
		if (a.y === b.y || (z - a.y) * (z - b.y) > 0) continue;
		const x = a.x + (b.x - a.x) * (z - a.y) / (b.y - a.y);
		lo = Math.min(lo, x);
		hi = Math.max(hi, x);
	}
	return lo <= hi ? [lo, hi] : null;
}

// how far a section's wall stands out into the room at height Z, or null above its top
function standout(profile, z) {
	for (let i = 0; i + 1 < profile.length; i++) {
		const a = profile[i], b = profile[i + 1];
		if (z >= a.y && z <= b.y) return a.x + (b.x - a.x) * (z - a.y) / Math.max(b.y - a.y, 1e-3);
	}
	return null;
}

export class World {
	constructor(blocks) {
		this.doorOpen = false;
		// the blockout pieces a body could walk into: not the floor, the mats or the roof
		this.boxes = blocks.filter(b => b.center.z - b.size.z / 2 < 200 && b.center.z + b.size.z / 2 > 35)
			.map(b => ({ lo: b.center.sub(b.size.mul(0.5)), hi: b.center.add(b.size.mul(0.5)) }));
	}

	// whether a ball of radius R at P is inside anything
	solid(p, r = 0) {
		for (const s of Sections) {
			const rel = p.sub(s.base);
			const a = rel.dot(s.along);
			if (a < -r || a > s.width + r) continue;
			const wall = standout(s.profile, p.z);
			if (wall === null) continue;
			const d = rel.dot(s.into);
			if (d < wall + r && d > wall - 150) return true;
		}
		if (p.x > ArchStart - r && p.x < ArchStart + ArchLength + r) {
			const dy = p.y - ArchCenter;
			const outer = span(ArchOuter, p.z);
			if (outer && dy > outer[0] - r && dy < outer[1] + r) {
				const inner = span(ArchInner, p.z);
				if (!inner || dy < inner[0] + r || dy > inner[1] - r) return true;
			}
		}
		for (const b of this.boxes)
			if (p.x > b.lo.x - r && p.x < b.hi.x + r && p.y > b.lo.y - r && p.y < b.hi.y + r && p.z > b.lo.z - r && p.z < b.hi.z + r) return true;
		// the front wall has a doorway in it: shut, the gap is as solid as the wall; open, it leads to the room with The Wall in it
		if (p.x > Door.x - 10 - r && p.x < Room.x0 + r && Math.abs(p.y - Door.y) < Door.width / 2 + r && !this.doorOpen) return true;
		if (p.x > Room.x1 - 70 - r) return true;
		return p.x < -300 || (p.x < 2550 && Math.abs(p.y) > 1640);
	}

	// whether a standing body at floor point P fits: feet, hips and head
	blocked(p) {
		const floor = floorAt(p.x, p.y);
		return [35, 100, 165].some(h => this.solid(new Vec3(p.x, p.y, floor + h), Radius));
	}

	// a step that slides along whatever it runs into
	move(from, step) {
		for (const s of [step, new Vec3(step.x, 0, 0), new Vec3(0, step.y, 0)]) {
			const to = from.add(s);
			if (!this.blocked(to)) return to;
		}
		return from;
	}

	// the nearest spot along Direction from P where a standing body fits
	clear(p, direction) {
		let at = new Vec3(p.x, p.y, 0);
		for (let i = 0; i < 60 && this.blocked(at); i++) at = at.add(direction.mul(5));
		at.z = floorAt(at.x, at.y);
		return at;
	}

	// where to stand to pull onto a problem: under its two start holds, out from the wall, facing in
	startSpot(route) {
		const a = route.map(route.holds[2].point), b = route.map(route.holds[3].point);
		const middle = a.add(b).mul(0.5);
		const out = route.panels[0].out;
		const o = new Vec3(out.x, out.y, 0).norm();
		return { at: this.clear(middle.add(o.mul(38)), o), yaw: Math.atan2(-o.y, -o.x), out: o };
	}
}
