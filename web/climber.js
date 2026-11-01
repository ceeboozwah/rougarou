// the climber: a jointed mannequin in blaize's colors (tee, olive shorts, yellow shoes) drawn from a pose.
// a pose comes from the climbing sim (a port of unreal/Source/Rougarou/ClimberActor.cpp's Draw), from walking the gym, or from a fall.
// solve() bends the elbows and knees, blend() eases between two solved poses, and draw() places the meshes.
// poses are in unreal space, centimeters.

import * as THREE from 'three';
import { Vec2, Vec3 } from './sim.js';
import { toThree } from './gym.js';
import { Tube, bent } from './tube.js';
import { Bag } from './chalkbag.js';

const Gap = 30;
const Skin = 0xc98e6d, Tee = 0xe6dfcc, Shorts = 0x3f4a2c, Shoe = 0xe9b812, Sole = 0x161616, Hair = 0x4a3324, Beard = 0x8a5634;
// points around each ring of the tee
const Around = 20;
const Y = new THREE.Vector3(0, 1, 0);
const Z = new Vec3(0, 0, 1);
const three = (v) => new THREE.Vector3(...toThree(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mid = (a, b) => a.add(b).mul(0.5);
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
// each limb's two bones in centimeters: the sim's limb lengths
export const Bones = [46, 46, 27, 27];
// -1 for the right side, which is the sim's -x
const sideOf = (limb) => limb % 2 === 0 ? -1 : 1;

// a hand at Contact on a wall frame, its fingers along Over: the wrist, and the palm frame the fingers shape around
export function handOn(frame, contact, over, side, grip, shake = 0) {
	let thumb = frame.right.mul(-side);
	thumb = thumb.sub(over.mul(thumb.dot(over))).sub(frame.out.mul(thumb.dot(frame.out))).norm();
	if (thumb.nearZero()) thumb = frame.out.cross(over).norm().mul(-side);
	const palm = contact.sub(over.mul(3.5)).add(frame.out.mul(grip === 'crimp' ? 5.5 : 3.8)).add(thumb.mul(shake));
	return { end: palm.sub(over.mul(5.5)).add(frame.out.mul(0.8)), hand: { palm, over, out: frame.out, thumb, grip } };
}

// push a point out of the wall it sits near, so a limb or the eyes never poke through a panel. Min is the clearance in centimeters
export function awayFromWall(face, p, min) {
	let out = p;
	for (const panel of face.near ? face.near(p) : face.panels) {
		const along = p.sub(panel.origin).dot(panel.up) / 100 + panel.start;
		if (along < panel.start - 0.15 || along > panel.start + panel.length + 0.15) continue;
		const depth = out.sub(panel.origin).dot(panel.out);
		if (depth < min && depth > -60) out = out.add(panel.out.mul(min - depth));
	}
	return out;
}

// the tightest an elbow or knee folds, as the angle between its two bones: legs, then arms
export const Folds = [30, 30, 35, 35].map(d => d * Math.PI / 180);

// move a hand or foot, and everything drawn from it, by a shift
function slide(limb, shift) {
	limb.end = limb.end.add(shift);
	if (limb.hand) limb.hand = { ...limb.hand, palm: limb.hand.palm.add(shift) };
	if (limb.foot) limb.foot = { ...limb.foot, toe: limb.foot.toe.add(shift), heel: limb.foot.heel.add(shift) };
}

// how far each joint turns, from the torso's own frame (front, outward, up). the shoulder swings freely except behind the back
// (about 50 degrees past the shoulder line) and the hip is stiffer: a leg goes about 60 degrees behind the torso (the torso itself leans in on a steep wall,
// which counts), 85 out to the side and 70 across.
// the spine twists 50 degrees between hips and shoulders and the neck 80 each way, 55 down and 65 up. angles in degrees
export const Joints = { arm: { behind: 50, across: 90 }, leg: { behind: 60, out: 85, across: 70 }, twist: 50, neck: { yaw: 80, down: 55, up: 65 } };
// what the limits did, for checking them against real play: the most a limit moved a hand or foot or turned the body
export const limitStats = { swing: 0, twist: 0, neck: 0, shift: 0, by: [0, 0, 0, 0] };
const rad = (d) => d * Math.PI / 180;

// a vector turned by Angle about Axis
function turnAbout(v, axis, angle) {
	const c = Math.cos(angle), s = Math.sin(angle);
	return v.mul(c).add(axis.cross(v).mul(s)).add(axis.mul(axis.dot(v) * (1 - c)));
}

// keep the body's joints inside what a person can do, before the elbows and knees are bent: the spine twist, each shoulder
// and hip's swing (a hand or foot asked past it is carried back to the edge) and the neck on the look direction
function limitJoints(pose) {
	const [hipR, hipL, shoR, shoL] = pose.roots;
	const pelvis = mid(hipR, hipL);
	let chest = mid(shoR, shoL);
	const up = chest.sub(pelvis).norm();
	if (up.nearZero() || !pose.back) return;
	const flat = (v) => v.sub(up.mul(v.dot(up)));
	const front = flat(pose.back.mul(-1)).norm();
	// the spine: the shoulders turn against the hips about the spine, up to Twist
	const hips = flat(hipL.sub(hipR)).norm(), shoulders = flat(shoL.sub(shoR)).norm();
	if (!hips.nearZero() && !shoulders.nearZero()) {
		const twist = Math.atan2(hips.cross(shoulders).dot(up), hips.dot(shoulders));
		const excess = Math.abs(twist) - rad(Joints.twist);
		if (excess > 0) {
			const back = -Math.sign(twist) * excess;
			pose.roots[2] = chest.add(turnAbout(shoR.sub(chest), up, back));
			pose.roots[3] = chest.add(turnAbout(shoL.sub(chest), up, back));
			limitStats.twist = Math.max(limitStats.twist, excess * 180 / Math.PI);
		}
	}
	chest = mid(pose.roots[2], pose.roots[3]);
	// each shoulder and hip: the direction of the limb in the torso's frame, held off the sides it cannot reach
	pose.limbs.forEach((limb, index) => {
		const leg = index < 2;
		const root = pose.roots[index];
		const side = flat(root.sub(leg ? pelvis : chest)).norm();
		const outward = side.sub(front.mul(side.dot(front))).norm();
		const reach = limb.end.sub(root);
		const length = reach.len();
		if (length < 1e-3 || outward.nearZero()) return;
		const d = reach.mul(1 / length);
		let f = d.dot(front), s = d.dot(outward);
		const u = d.dot(up);
		const [behind, out, across] = leg ? [Joints.leg.behind, Joints.leg.out, Joints.leg.across] : [Joints.arm.behind, 90, Joints.arm.across];
		// behind: how far past the line through the joint the limb may point backward. an arm pointing down can go further back than
		// a leg, and nothing stops either swinging forward
		const f2 = Math.max(f, -Math.sin(rad(behind)));
		const s2 = Math.min(Math.max(s, -Math.sin(rad(across))), Math.sin(rad(out)));
		if (f2 === f && s2 === s) return;
		const u2 = (u < 0 ? -1 : 1) * Math.sqrt(Math.max(0, 1 - f2 * f2 - s2 * s2));
		const end = root.add(front.mul(f2).add(outward.mul(s2)).add(up.mul(u2)).mul(length));
		limitStats.swing = Math.max(limitStats.swing, Math.acos(Math.min(1, d.dot(end.sub(root).norm()))) * 180 / Math.PI);
		limitStats.shift = Math.max(limitStats.shift, end.dist(limb.end));
		limitStats.by[index] = Math.max(limitStats.by[index], end.dist(limb.end));
		slide(limb, end.sub(limb.end));
	});
	// the neck: the look direction can turn Yaw each way and tip Down and Up from the way the chest faces
	if (pose.look) {
		const across = flat(shoL.sub(shoR)).norm();
		const side = across.sub(front.mul(across.dot(front))).norm();
		const look = pose.look.norm();
		const lf = look.dot(front), ls = look.dot(side), lu = look.dot(up);
		const yaw = Math.atan2(ls, lf), pitch = Math.atan2(lu, Math.hypot(lf, ls));
		const y = Math.max(-rad(Joints.neck.yaw), Math.min(rad(Joints.neck.yaw), yaw));
		const p = Math.max(-rad(Joints.neck.down), Math.min(rad(Joints.neck.up), pitch));
		if (y !== yaw || p !== pitch) {
			limitStats.neck = Math.max(limitStats.neck, Math.max(Math.abs(y - yaw), Math.abs(p - pitch)) * 180 / Math.PI);
			pose.look = front.mul(Math.cos(p) * Math.cos(y)).add(side.mul(Math.cos(p) * Math.sin(y))).add(up.mul(Math.sin(p)));
		}
	}
}

// elbows and knees: a two-bone bend toward each limb's pole, at the real limb length. an elbow or knee is a hinge: it only
// folds toward its pole side (the pole is steadied by the body's back direction, so it cannot flip when the limb lines up
// with it), it never hyperextends, and it closes no tighter than Folds, which holds a hand off the shoulder or a foot off the hip
export function solve(pose) {
	limitJoints(pose);
	pose.limbs.forEach((limb, index) => {
		if (limb.bend) return;
		const root = pose.roots[index];
		let toward = limb.end.sub(root);
		// a limb asked past its length stretches a little rather than coming apart from the hand or foot
		const length = Math.max(Bones[index], toward.len() / 2 + 0.5);
		// asked to fold tighter than the joint can, the end stops at the tightest fold and carries the hand or foot with it
		const closest = 2 * length * Math.sin(Folds[index] / 2);
		if (toward.len() < closest) {
			const along = toward.len() > 1e-4 ? toward.norm() : limb.pole.norm();
			slide(limb, along.mul(closest - toward.len()));
			toward = limb.end.sub(root);
		}
		const reach = Math.min(toward.len(), length * 2 - 0.1);
		const direction = toward.norm();
		const side = limb.pole.norm();
		let pole = side.sub(direction.mul(side.dot(direction)));
		if (pole.len() < 0.35 && pose.back) {
			// the limb runs along its pole: lean on the back direction so the joint keeps the side it had
			const back = pose.back.sub(direction.mul(pose.back.dot(direction)));
			pole = pole.add(back.norm().mul(0.35 - pole.len()));
		}
		pole = pole.norm();
		limb.bend = root.add(direction.mul(reach / 2)).add(pole.mul(Math.sqrt(Math.max(0, length * length - reach * reach / 4))));
		limb.joint = root.add(direction.mul(reach));
	});
	return pose;
}

// a pose part way from A to B
export function blend(a, b, t) {
	if (a instanceof Vec3) return a.lerp(b, t);
	if (typeof a === 'number') return a + (b - a) * t;
	if (Array.isArray(a)) return a.map((x, i) => blend(x, b[i], t));
	if (a && typeof a === 'object' && b && typeof b === 'object') {
		const out = {};
		for (const k of Object.keys(a)) out[k] = a[k] == null || b[k] == null ? (t < 0.5 ? a[k] : b[k]) : blend(a[k], b[k], t);
		return out;
	}
	return t < 0.5 ? a : b;
}

// standing and walking on the mats. At is the floor under the hips, Yaw the way the body faces; Phase runs the stride,
// Amp is how hard it is walking (0 standing), Crouch drops the hips. Reach can replace an arm with a hand placed on a hold
export function walkPose(w, clock) {
	const f = new Vec3(Math.cos(w.yaw), Math.sin(w.yaw), 0);
	const r = new Vec3(-f.y, f.x, 0);
	const amp = w.amp ?? 0, crouch = w.crouch ?? 0, phase = w.phase ?? 0;
	const breath = Math.sin(clock * 1.7) * 0.6;
	// the hips ride highest mid-stride, over the planted foot
	const pelvis = w.at.add(Z.mul(97 - crouch - 1.6 * amp * (1 - Math.cos(2 * phase)))).sub(f.mul(crouch * 0.3));
	const chest = pelvis.add(Z.mul(52 + breath - crouch * 0.15)).add(f.mul(4 * amp + crouch * 0.45));
	// the pelvis turns with each stride and the shoulders turn against it
	const sway = Math.sin(phase) * 0.16 * amp;
	const hipLine = r.mul(Math.cos(sway)).add(f.mul(Math.sin(sway))), shoulderLine = r.mul(Math.cos(sway * 0.8)).sub(f.mul(Math.sin(sway * 0.8)));
	const roots = [pelvis.add(hipLine.mul(11)), pelvis.sub(hipLine.mul(11)), chest.add(shoulderLine.mul(20)), chest.sub(shoulderLine.mul(20))];
	const limbs = [0, 1].map(l => {
		const step = phase + (l === 0 ? 0 : Math.PI);
		const swing = Math.sin(step) * 24 * amp, lift = Math.max(0, Math.cos(step)) * 9 * amp;
		const ankle = w.at.add(r.mul(l === 0 ? 12 : -12)).add(f.mul(swing + crouch * 0.2)).add(Z.mul(8 + lift));
		const pitch = Math.max(0, Math.cos(step)) * amp * 0.25;
		const toe = ankle.add(f.mul(15)).sub(Z.mul(7 + 15 * pitch));
		const heel = ankle.sub(f.mul(5)).sub(Z.mul(6.5 - 5 * pitch));
		return { end: ankle, pole: f.add(r.mul((l === 0 ? 1 : -1) * 0.2)), foot: { toe, heel, up: Z, dorsum: Z } };
	});
	for (const l of [2, 3]) {
		const s = l === 2 ? 1 : -1;
		if (w.reach?.[l]) { limbs.push(w.reach[l]); continue; }
		// each arm swings with the opposite leg
		const swing = -Math.sin(phase + (l === 2 ? 0 : Math.PI)) * 20 * amp;
		const shoulder = roots[l];
		const wrist = shoulder.sub(Z.mul(49 - crouch * 0.4)).add(f.mul(swing + 5 + crouch * 0.3)).add(r.mul(s * 6));
		const over = wrist.sub(shoulder).norm();
		const out = r.mul(s).sub(over.mul(r.mul(s).dot(over))).norm();
		const thumb = f.sub(over.mul(f.dot(over))).sub(out.mul(f.dot(out))).norm();
		limbs.push({ end: wrist, pole: f.mul(-1).add(r.mul(s * 0.3)), hand: { palm: wrist.add(over.mul(5.5)).sub(out.mul(0.8)), over, out, thumb, grip: 'free' } });
	}
	const head = chest.add(Z.mul(24)).add(f.mul(1 + crouch * 0.1));
	const look = w.look ? w.look.sub(head).norm().add(f.mul(0.8)).norm() : f;
	return { roots, up: chest.sub(pelvis).norm(), back: f.mul(-1), head, look, limbs, marker: null };
}

export class Climber {
	constructor(scene) {
		this.group = new THREE.Group();
		scene.add(this.group);
		const rod = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
		// limbs taper toward the hand or foot: the top of the cylinder lands on the far end of a segment
		const taper = new THREE.CylinderGeometry(0.78, 1, 1, 14, 1);
		const ball = new THREE.SphereGeometry(0.5, 20, 16);
		const paint = {};
		const material = (c) => paint[c] ??= new THREE.MeshStandardMaterial({ color: c, roughness: c === Hair || c === Beard ? 1 : c === Sole ? 0.6 : 0.78 });
		const make = (geometry, color) => {
			const mesh = new THREE.Mesh(geometry, material(color));
			mesh.castShadow = true;
			this.group.add(mesh);
			return mesh;
		};
		this.rod = (c) => make(rod, c);
		this.taper = (c) => make(taper, c);
		this.ball = (c) => make(ball, c);
		// the boxy tee: rings of a rounded box from the collar to the hem, rebuilt every frame so it can sway
		const rings = 5, around = Around;
		const shirt = new THREE.BufferGeometry();
		shirt.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((rings * around + 1) * 3), 3));
		const index = [];
		for (let r = 0; r + 1 < rings; r++)
			for (let a = 0; a < around; a++) {
				const i = r * around + a, j = r * around + (a + 1) % around;
				index.push(i, i + around, j, j, i + around, j + around);
			}
		// the collar is closed by a flat cap, so looking down at your own chest does not look down the inside of the tee
		for (let a = 0; a < around; a++) index.push(rings * around, (a + 1) % around, a);
		shirt.setIndex(index);
		// the outfit's three colors live on these materials, so a change in the settings shows at once
		this.cloth = {
			shirt: new THREE.MeshStandardMaterial({ color: Tee, roughness: 0.92, side: THREE.DoubleSide }),
			shorts: new THREE.MeshStandardMaterial({ color: Shorts, roughness: 0.85 }),
			shoes: new THREE.MeshStandardMaterial({ color: Shoe, roughness: 0.55 }),
		};
		const skin = material(Skin), sole = material(Sole);
		this.shirt = new THREE.Mesh(shirt, this.cloth.shirt);
		this.shirt.castShadow = true;
		this.shirt.frustumCulled = false;
		this.group.add(this.shirt);
		this.shorts = this.ball(Shorts);
		this.shorts.material = this.cloth.shorts;
		this.neck = this.rod(Skin);
		this.head = this.ball(Skin);
		this.hair = this.ball(Hair);
		this.beard = this.ball(Beard);
		this.ears = [this.ball(Skin), this.ball(Skin)];
		this.nose = this.ball(Skin);
		// each limb one soft tube from shoulder or hip to wrist or ankle, so elbows and knees bend instead of hinging between blocks
		this.limbs = [0, 1, 2, 3].map(l => {
			const arm = l >= 2;
			const root = this.ball(arm ? Tee : Shorts);
			root.material = arm ? this.cloth.shirt : this.cloth.shorts;
			return { root, limb: new Tube(this.group, skin, 22, 14), cover: new Tube(this.group, arm ? this.cloth.shirt : this.cloth.shorts, 8, 16, true), wrist: arm ? this.ball(Skin) : null,
				palm: arm ? this.ball(Skin) : null, fingers: arm ? Array.from({ length: 5 }, () => new Tube(this.group, skin, 7, 8)) : [],
				shoe: arm ? null : new Tube(this.group, this.cloth.shoes, 12, 14), sole: arm ? null : new Tube(this.group, sole, 12, 10) };
		});
		// in first person the head is swapped for a material that draws nothing, so the camera sits inside it but its shadow stays on the wall
		this.ghost = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
		this.headParts = [this.neck, this.head, this.hair, this.beard, this.nose, ...this.ears];
		this.headPaint = this.headParts.map(m => m.material);
		this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe640, wireframe: true, transparent: true, opacity: 0.8 }));
		this.group.add(this.marker);
		this.clock = 0;
		this.away = 0;
		this.drawn = 0;
		this.reset();
	}

	// the camera is behind the eyes: hide the head parts, or give them back
	setFirstPerson(on) {
		if (this.inside === on) return;
		this.inside = on;
		if (this.model) { this.model.firstPerson(on); return; }
		this.headParts.forEach((m, i) => { m.material = on ? this.ghost : this.headPaint[i]; });
		// the key light sits over the camera's shoulder, so your own shadow would cover everything you look at
		this.casting ??= new Map();
		this.group.traverse((m) => {
			if (!m.isMesh) return;
			if (!this.casting.has(m)) this.casting.set(m, m.castShadow);
			m.castShadow = on ? false : this.casting.get(m);
		});
	}

	// forget the eased body shape, for a fresh start on the wall
	reset() { this.turn = 0; this.hips = 18; this.chestDepth = 22; this.look = null; this.hem = new Vec3(); this.swing = new Vec3(); this.moving = null; this.last = null; }

	segment(mesh, a, b, radius) {
		const A = three(a), B = three(b);
		const along = B.clone().sub(A);
		const length = along.length();
		mesh.position.copy(A).add(B).multiplyScalar(0.5);
		if (length > 1e-6) mesh.quaternion.setFromUnitVectors(Y, along.multiplyScalar(1 / length));
		mesh.scale.set(radius / 100, Math.max(length, 1e-4), radius / 100);
	}

	// a sphere stretched to Size centimeters, its length along Along and its thickness along Out
	orient(mesh, center, along, out, size) {
		const x = three(along).normalize();
		const o = three(out);
		const z = o.sub(x.clone().multiplyScalar(o.dot(x))).normalize();
		const y = z.clone().cross(x);
		mesh.position.copy(three(center));
		mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
		mesh.scale.set(size.x / 100, size.y / 100, size.z / 100);
	}

	place(mesh, center, size) {
		mesh.position.copy(three(center));
		mesh.quaternion.identity();
		mesh.scale.setScalar(size / 100);
	}

	// the outfit colors, as css hex strings
	setOutfit({ shirt, shorts, shoes }) {
		this.outfit = { shirt, shorts, shoes };
		this.model?.tint(this.outfit);
		if (shirt) this.cloth.shirt.color.set(shirt);
		if (shorts) this.cloth.shorts.color.set(shorts);
		if (shoes) this.cloth.shoes.color.set(shoes);
	}

	// the hand's fingers shaped to the grip: Over is the way the fingers point, Out away from the wall, Thumb toward the thumb side
	shapeFingers(tubes, palm, over, out, thumb, grip) {
		let first = [0.9, 0.15], second = [0.6, -0.5], spread = 1;
		if (grip === 'jug' || grip === 'pinch') { first = [1, 0.1]; second = [-0.25, -1]; }
		else if (grip === 'crimp') { first = [0.45, 0.9]; second = [0.3, -1]; spread = 0.85; }
		else if (grip === 'sloper') { first = [1, -0.25]; second = [0.85, -0.5]; spread = 1.25; }
		else if (grip === 'smear') { first = [1, -0.05]; second = [1, -0.1]; spread = 1.2; }
		const lengths = [7.2, 8, 7.6, 6];
		const widths = [1.95, 2.05, 1.95, 1.7];
		const dir = (w) => over.mul(w[0]).add(out.mul(w[1])).norm();
		const finger = (tube, a, b, c, width) => {
			const path = bent(a, b, c, 0.9);
			tube.update(path, (t) => { const w = width * (1 - 0.25 * t) * (t > 0.92 ? Math.sqrt(Math.max(0.05, (1 - t) / 0.08)) : 1); return [w, w * 0.92]; }, out);
		};
		for (let f = 0; f < 4; f++) {
			// index nearest the thumb, out to the pinky
			const knuckle = palm.add(over.mul(3.6)).add(thumb.mul((2.7 - f * 1.8) * spread)).sub(out.mul(0.4));
			let one = first, two = second;
			// a pocket takes the two middle fingers; the others curl out of the way
			if (grip === 'pocket') { const used = f === 1 || f === 2; one = used ? [0.6, -0.8] : [0.4, 0.6]; two = used ? [0.5, -0.9] : [-0.8, -0.4]; }
			const middle = knuckle.add(dir(one).mul(lengths[f] * 0.55));
			finger(tubes[f], knuckle, middle, middle.add(dir(two).mul(lengths[f] * 0.45)), widths[f]);
		}
		// the thumb: wrapped over the index on a crimp, opposed across the hold on a pinch, alongside otherwise
		const root = palm.add(thumb.mul(2.8)).sub(over.mul(2.5));
		let one = over.mul(0.6).add(thumb.mul(0.7)), two = over.mul(0.8).sub(thumb.mul(0.2));
		if (grip === 'crimp') { one = over.mul(0.7).add(out.mul(0.6)); two = thumb.mul(-0.9).add(over.mul(0.3)); }
		else if (grip === 'pinch') { one = over.mul(0.4).add(thumb.mul(0.5)).sub(out.mul(0.7)); two = over.mul(0.6).sub(thumb.mul(0.3)).sub(out.mul(0.6)); }
		const middle = root.add(one.norm().mul(4.2));
		finger(tubes[4], root, middle, middle.add(two.norm().mul(3.2)), 2.4);
	}

	// the climbing pose, read off the sim
	climbPose(sim, selected, delta) {
		const face = sim.routes[sim.route];
		const at = (p, depth) => face.map(p, depth);
		const frame = face.at(sim.position.y);
		const ease = Math.min(1, delta * 5);
		// the reaching hand's hip turns into the wall and its shoulder leads, the way a twist or a backstep gains reach
		let mover = sim.reaching >= 2 ? sim.reaching : -1;
		for (let l = 2; l < 4 && mover < 0; l++) if (sim.latch[l] < 0 && sim.grips[l] >= 0) mover = l;
		this.turn += ((mover < 0 ? 0 : sideOf(mover)) - this.turn) * ease;
		const on = (l) => (sim.grips[l] >= 0 || sim.smeared[l]) && sim.arrived(l);
		const feet = [0, 1].filter(on);
		const footY = feet.length ? feet.reduce((a, l) => a + sim.tips[l].y, 0) / feet.length : sim.position.y - 1;
		// long legs keep the hips in close to the wall and a high step pushes them out; straight arms let the chest hang back
		const compress = clamp(1 - (sim.position.y - footY) / 0.75, 0, 1);
		const hangs = [2, 3].filter(on).filter(l => sim.grips[l] >= 0).map(l => sim.distance(l, sim.tips[l]) / (sim.body.lengths[l] * 2));
		const straight = hangs.length ? clamp((Math.max(...hangs) - 0.75) / 0.2, 0, 1) : 0;
		const steep = Math.max(0, face.steep(sim.position.y));
		// in first person the body hangs further off the wall, as it does in life, so looking down shows the legs past the chest
		this.hips += (16 + 22 * compress + 10 * steep * straight + 22 * this.away - this.hips) * ease;
		this.chestDepth += (20 + 10 * straight + 6 * steep + 18 * this.away - this.chestDepth) * ease;
		const roots = [0, 1, 2, 3].map(l => at(sim.joint(l), l < 2 ? this.hips - 10 * this.turn * sideOf(l) : this.chestDepth - 5 * this.turn * sideOf(l)));
		const pelvis = mid(roots[0], roots[1]), chest = mid(roots[2], roots[3]);
		const up = chest.sub(pelvis).norm();
		const head = chest.add(up.mul(24)).sub(frame.out.mul(3));
		// the eyes go to whatever is being reached for, or up the wall to the next hold
		let focus;
		if (selected >= 0) focus = sim.target;
		else if (mover >= 0) focus = sim.spot(mover);
		else {
			focus = mid(sim.tips[2], sim.tips[3]).add(new Vec2(0, 0.5));
		}
		const wanted = at(focus, 0).sub(head).norm().add(frame.out.mul(-0.7)).norm();
		this.look = this.look ? this.look.lerp(wanted, Math.min(1, delta * 4)).norm() : wanted;

		const limbs = [];
		let marker = null;
		for (let limb = 0; limb < 4; limb++) {
			const arm = limb >= 2;
			const side = sideOf(limb);
			const held = (sim.grips[limb] >= 0 || sim.smeared[limb]) && sim.arrived(limb);
			const tip = sim.tips[limb];
			const panel = face.at(tip.y);
			const root = roots[limb];
			let contact = at(tip, held ? 3 : Gap * 0.5);
			let part;
			if (arm) {
				let over = panel.up, grip = 'free', shake = 0;
				if (sim.grips[limb] >= 0) {
					const hold = sim.holds()[sim.grips[limb]];
					grip = held ? hold.kind : 'free';
					// fingers point over the lip, away from the way the hold is pulled; a pinch is gripped from below its side
					if (hold.kind !== 'pinch') over = panel.right.mul(-hold.pull.x).add(panel.up.mul(-hold.pull.y)).norm();
				} else if (sim.smeared[limb] && held) grip = 'smear';
				else {
					// a pumped hand off the wall dangles and shakes out
					if (limb !== selected && sim.pump[limb] > 0.05) {
						const flick = Math.sin(this.clock * 15 + limb * 2) * clamp(sim.pump[limb] * 2, 0, 1);
						contact = contact.add(panel.right.mul(flick * 5)).add(panel.out.mul(Math.abs(flick) * 3));
					}
					over = contact.sub(root).norm();
				}
				// a hand near its limit trembles
				shake += Math.min(1, Math.max(0, (sim.strain[limb] - 0.85) * 4)) * Math.sin(this.clock * 70 + limb) * 0.6;
				part = handOn(panel, contact, over, side, grip, shake);
			} else {
				// a climbing shoe: toe on the hold, heel out from the wall and a little low, the ankle above the heel
				const ankle = contact.add(panel.out.mul(14)).add(panel.up.mul(7));
				const heel = contact.add(panel.out.mul(19)).sub(panel.up.mul(1.5));
				part = { end: ankle, foot: { toe: contact, heel, up: panel.up, dorsum: panel.out } };
			}
			// elbows drop down and out, knees splay out and lead upward. a foot on the side the body is turning toward drops its knee
			const lean = arm ? [0.6, side * 0.5, -0.6] : [-0.25, side * (0.3 + 0.9 * this.away), 1];
			let pole = frame.out.mul(lean[0]).add(frame.right.mul(lean[1])).add(frame.up.mul(lean[2]));
			if (!arm && held) pole = pole.lerp(frame.up.mul(-1).add(frame.right.mul(-side * 0.7)).add(frame.out.mul(0.3)), clamp(this.turn * side, 0, 1) * 0.85);
			limbs.push({ ...part, pole });
			if (limb === selected) marker = contact;
		}
		// chalking up: one hand reaches behind to the bag on the small of the back and dips into it
		if (this.chalking) {
			const k = this.chalking, hand = k.limb;
			const mouth = pelvis.add(frame.out.mul(Bag.back)).add(up.mul(Bag.up));
			this.mouth = mouth;
			const wrist = mouth.add(up.mul(2.5 - 3.5 * k.dip));
			const over = up.mul(-1);
			const flat = roots[hand].sub(chest);
			const outward = flat.sub(up.mul(flat.dot(up))).norm();
			const target = { end: wrist, pole: frame.out.mul(0.6).add(outward.mul(0.8)).sub(up.mul(0.3)), hand: { palm: wrist.add(over.mul(5.5)), over, out: outward, thumb: frame.out.mul(-1), grip: 'free' } };
			limbs[hand] = blend(limbs[hand], target, k.reach);
		}
		const posed = solve({ roots, up, back: frame.out, head, look: this.look, limbs, marker });
		// elbows and knees stay out of the wall, so the arms and legs never sink into it
		posed.limbs.forEach((l, i) => { if (l.bend) l.bend = awayFromWall(face, l.bend, i < 2 ? 11 : 7.5); });
		// the wall panels around the hips, as plain planes, so the skeleton can keep its knees and elbows out of them (figure.js)
		posed.walls = (face.near ? face.near(pelvis) : face.panels).slice(0, 4).map(p => ({ origin: p.origin, out: p.out, up: p.up, start: p.start, length: p.length }));
		return posed;
	}

	// the tee as five rounded-box rings, the hem hanging off a spring: it drapes toward the floor, lags behind the hips, and rides up when the arms go overhead
	dressShirt(pose, pelvis, chest, up, back, delta) {
		const raise = [2, 3].reduce((a, l) => a + clamp(pose.limbs[l].end.sub(pose.roots[l]).dot(up) / 45, 0, 1), 0) / 2;
		if (this.last && delta > 0 && delta < 0.2) {
			const moving = pelvis.sub(this.last).mul(1 / delta);
			const shove = this.moving ? moving.sub(this.moving).mul(1 / delta) : new Vec3();
			this.moving = moving;
			const down = new Vec3(0, 0, -1);
			const drape = down.sub(up.mul(down.dot(up)));
			const target = drape.mul(9).add(up.mul(7 * raise));
			const len = shove.len();
			const push = len > 2500 ? shove.mul(2500 / len) : shove;
			this.swing = this.swing.add(target.sub(this.hem).mul(140 * delta)).sub(this.swing.mul(10 * delta)).sub(push.mul(0.8 * delta));
			this.hem = this.hem.add(this.swing.mul(delta));
			if (this.hem.len() > 15) this.hem = this.hem.norm().mul(15);
		} else { this.hem = new Vec3(); this.swing = new Vec3(); this.moving = null; }
		this.last = pelvis;
		const across = pose.roots[3].sub(pose.roots[2]).norm();
		const hips = pose.roots[1].sub(pose.roots[0]).norm();
		const broad = clamp(pose.roots[3].dist(pose.roots[2]) * 0.82, 40, 47);
		const rings = [
			[chest.add(up.mul(6)).add(back.mul(1)), across, 17, 13],
			[chest.add(up.mul(1)), across, broad + 6, 21],
			[chest.sub(up.mul(14)), across, broad + 3, 25],
			[pelvis.add(up.mul(15)).add(this.hem.mul(0.35)), across.add(hips).norm(), 45, 25],
			[pelvis.sub(up.mul(1)).add(this.hem), hips, 48, 26.5],
		];
		const positions = this.shirt.geometry.attributes.position;
		rings.forEach(([center, side, width, depth], r) => {
			const x = side.sub(up.mul(side.dot(up))).norm();
			const z = back.sub(up.mul(back.dot(up))).sub(x.mul(back.dot(x))).norm();
			for (let a = 0; a < Around; a++) {
				// a squarish ring: boxy like a heavy tee, rounded at the corners
				const t = a / Around * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
				const point = center.add(x.mul(Math.sign(c) * Math.abs(c) ** 0.55 * width / 2)).add(z.mul(Math.sign(s) * Math.abs(s) ** 0.55 * depth / 2));
				positions.setXYZ(r * Around + a, ...toThree(point));
			}
		});
		positions.setXYZ(rings.length * Around, ...toThree(rings[0][0]));
		positions.needsUpdate = true;
		this.shirt.geometry.computeVertexNormals();
	}

	// wear a skinned character (figure.js) instead of the tubes and boxes; null goes back to them
	wear(figure) {
		if (this.model) this.group.remove(this.model.root);
		this.model = figure;
		for (const child of this.group.children) if (child !== figure?.root && child !== this.marker) child.visible = !figure;
		if (figure) { this.group.add(figure.root); figure.tint(this.outfit ?? {}); }
		this.inside = undefined;
	}

	draw(pose) {
		if (this.model) {
			const dt = this.clock - this.drawn;
			this.drawn = this.clock;
			this.model.apply(pose, dt);
			this.marker.visible = !!pose.marker;
			if (pose.marker) this.marker.position.copy(three(pose.marker));
			return;
		}
		const delta = this.clock - this.drawn;
		this.drawn = this.clock;
		const [hipR, hipL] = pose.roots;
		const pelvis = mid(hipR, hipL), chest = mid(pose.roots[2], pose.roots[3]);
		const up = chest.sub(pelvis).norm();
		const back = pose.back;
		this.dressShirt(pose, pelvis, chest, up, back, delta);
		this.orient(this.shorts, pelvis.add(up.mul(2)), hipL.sub(hipR), back, new Vec3(41, 30, 27));
		const face = pose.look.sub(up.mul(pose.look.dot(up))).norm();
		const side = face.cross(up).norm();
		this.segment(this.neck, chest.add(up.mul(2)), pose.head.sub(up.mul(7)), 6.5);
		this.orient(this.head, pose.head, up, face.mul(-1), new Vec3(24, 19, 21));
		// a buzz cut: a close cap of hair over the top and back, the hairline well up the forehead
		this.orient(this.hair, pose.head.add(up.mul(3.2)).sub(face.mul(1.8)), up, face.mul(-1), new Vec3(23.2, 19.7, 20.4));
		this.orient(this.beard, pose.head.sub(up.mul(6)).add(face.mul(3.2)), up, face.mul(-1), new Vec3(11, 17.6, 15));
		this.ears.forEach((ear, i) => this.orient(ear, pose.head.add(side.mul(i ? 9.4 : -9.4)).sub(face.mul(1)), up, side, new Vec3(6, 4, 2.6)));
		this.place(this.nose, pose.head.add(face.mul(10)).sub(up.mul(1.5)), 3.6);
		this.marker.visible = !!pose.marker;
		if (pose.marker) this.marker.position.copy(three(pose.marker));
		pose.limbs.forEach((limb, index) => {
			const parts = this.limbs[index];
			const arm = index >= 2;
			const root = pose.roots[index];
			const joint = limb.joint ?? limb.end;
			const path = bent(root, limb.bend, joint, arm ? 6 : 8);
			const knee = path.knee;
			// muscle, not pipe: a deltoid or hip into a bicep or thigh, narrow at the elbow or knee, the forearm or calf, a slim wrist or ankle
			const radius = arm
				? (t) => t < knee ? lerp(6.4, 4.3, t / knee) + 0.7 * Math.sin(Math.PI * t / knee) : lerp(4.3, 2.8, (t - knee) / (1 - knee)) + 0.9 * Math.sin(Math.PI * Math.min(1, (t - knee) / (1 - knee) * 1.6))
				: (t) => t < knee ? lerp(9.4, 5.8, t / knee) + 0.8 * Math.sin(Math.PI * t / knee) : lerp(5.8, 3.9, (t - knee) / (1 - knee)) + 1.3 * Math.sin(Math.PI * Math.min(1, (t - knee) / (1 - knee) * 1.5));
			const side = limb.bend.sub(root).cross(joint.sub(limb.bend)).len() > 1 ? limb.bend.sub(root).cross(joint.sub(limb.bend)) : back;
			parts.limb.update(path, (t) => { const r = radius(t) * 2; return [r * (arm ? 1.08 : 1), r]; }, side);
			// a short boxy sleeve, or the shorts leg, over the top of the limb
			const reach = knee * (arm ? 0.5 : 0.46);
			// a roomy sleeve from the top of the shoulder, or a shorts leg from the waistband, ending in an open hem
			const hem = path(knee * (arm ? 0.62 : 0.55));
			const top = arm ? root.sub(up.mul(1)).add(chest.sub(root).mul(0.12)) : root.add(up.mul(9)).add(pelvis.sub(root).mul(0.35));
			const cuff = radius(knee * (arm ? 0.62 : 0.55)) * 2;
			parts.cover.update((t) => top.lerp(hem, t), (t) => { const r = arm ? lerp(15.5, cuff + 5.5, t) : lerp(26, cuff + 7.5, Math.sqrt(t)); return [r, r * (arm ? 1 : 0.95)]; }, side);
			this.place(parts.root, root, arm ? 13 : 16);
			if (arm) {
				const h = limb.hand;
				this.orient(parts.palm, h.palm, h.over, h.out, new Vec3(10.4, 9, 3.6));
				// the heel of the hand: a soft wedge from the wrist into the palm, so the hand grows out of the forearm
				this.orient(parts.wrist, limb.end.add(h.over.mul(2.6)), h.over, h.out, new Vec3(8.5, 7, 4.4));
				this.shapeFingers(parts.fingers, h.palm, h.over, h.out, h.thumb, h.grip);
			} else {
				// a downturned climbing shoe: rounded heel, wide at the ball of the foot, pointed toe; a black rubber sole and rand under it
				const f = limb.foot;
				const along = f.toe.sub(f.heel).norm();
				const lateral = f.up.cross(along).norm();
				const heel = f.heel.add(f.up.mul(5)).sub(along.mul(4.5));
				const toe = f.toe.add(f.up.mul(2)).add(along.mul(2.5));
				const arch = heel.lerp(toe, 0.55).add(f.up.mul(1.2));
				const shoe = bent(heel, arch, toe, 5);
				const width = (t) => t < 0.72 ? lerp(8.4, 10.8, t / 0.72) : 10.8 * Math.sqrt(Math.max(0.04, (1 - t) / 0.28));
				const height = (t) => (t < 0.55 ? lerp(12, 8.5, t / 0.55) : lerp(8.5, 4.5, (t - 0.55) / 0.45)) * (t > 0.9 ? Math.sqrt(Math.max(0.05, (1 - t) / 0.1)) : 1);
				parts.shoe.update(shoe, (t) => [width(t), height(t)], lateral);
				parts.sole.update((t) => shoe(t).sub(f.up.mul(height(t) * 0.42)), (t) => [width(t) + 0.8, 2.2], lateral);
			}
		});
	}
}

