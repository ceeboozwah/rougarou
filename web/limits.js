// joint limits for the character's bones: how far each joint may swing and twist from its rest pose.
// the numbers are set in the pose restriction editor (poseeditor.js), kept in limits.json, and enforced on the skeleton in the game (figure.js).
//
// each joint gets a frame from the rest pose: T runs along the bone toward its child, F is the axis across the body that a bone folds about (so a
// positive turn about it swings the bone toward the front: an elbow bending, a hip lifting the knee), and S the axis along the body's front that swings
// the bone away from the middle of the body (the arm out, the leg out). left and right bones share their numbers: the sign of S and of twist is flipped
// on the left so the same limits mean the same thing on both sides.

import * as THREE from 'three';

const V = THREE.Vector3, Q = THREE.Quaternion;
const DEG = 180 / Math.PI;

// the bones that can be limited, in the order the editor lists them, with the bone they point toward (the end of a chain points along its parent)
export const Groups = [
	['body', ['Pelvis', 'Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'NeckTwist02', 'Head']],
	['right arm', ['R_Clavicle', 'R_Upperarm', 'R_Forearm', 'R_Hand']],
	['left arm', ['L_Clavicle', 'L_Upperarm', 'L_Forearm', 'L_Hand']],
	['right leg', ['R_Thigh', 'R_Calf', 'R_Foot', 'R_ToeBase']],
	['left leg', ['L_Thigh', 'L_Calf', 'L_Foot', 'L_ToeBase']],
	['right hand', ['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].flatMap(f => [1, 2, 3].map(k => `R_${f}${k}`))],
	['left hand', ['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].flatMap(f => [1, 2, 3].map(k => `L_${f}${k}`))],
];
export const Editable = Groups.flatMap(([, names]) => names);

const Points = {
	Pelvis: 'Waist', Waist: 'Spine01', Spine01: 'Spine02', Spine02: 'NeckTwist01', NeckTwist01: 'NeckTwist02', NeckTwist02: 'Head', Head: null,
};
for (const s of ['L', 'R']) {
	Points[`${s}_Clavicle`] = `${s}_Upperarm`; Points[`${s}_Upperarm`] = `${s}_Forearm`; Points[`${s}_Forearm`] = `${s}_Hand`; Points[`${s}_Hand`] = `${s}_Mid1`;
	Points[`${s}_Thigh`] = `${s}_Calf`; Points[`${s}_Calf`] = `${s}_Foot`; Points[`${s}_Foot`] = `${s}_ToeBase`; Points[`${s}_ToeBase`] = null;
	for (const f of ['Thumb', 'Index', 'Mid', 'Ring', 'Pinky']) for (const k of [1, 2]) Points[`${s}_${f}${k}`] = `${s}_${f}${k + 1}`;
}

const spin = (v, q) => v.clone().applyQuaternion(q);
const inv = (q) => q.clone().invert();

// the frame of a bone, in the bone's own rest coordinates. Figure supplies rest (world rotation and position per bone) and the bones
export function jointFrame(figure, name) {
	const rest = figure.rest[name];
	if (!rest) return null;
	const to = Points[name];
	let T;
	if (to && figure.rest[to]) T = figure.rest[to].p.clone().sub(rest.p);
	else {
		// the end of a chain points on along the bone before it
		const parent = figure.bones[name].parent;
		const key = Object.keys(figure.bones).find(k => figure.bones[k] === parent);
		T = key ? rest.p.clone().sub(figure.rest[key].p) : new V(0, -1, 0);
	}
	if (T.lengthSq() < 1e-10) T = new V(0, -1, 0);
	T.normalize();
	// the flex axis is across the way the bone points and the way the body faces (+z at rest); a bone that points forward or back uses up instead
	let ref = new V(0, 0, 1);
	if (Math.abs(T.dot(ref)) > 0.9) ref = new V(0, 1, 0);
	const F = new V().crossVectors(T, ref).normalize();
	const S = new V().crossVectors(T, F).normalize();
	const side = name.startsWith('L_') ? -1 : 1;
	const to_local = (v) => spin(v, inv(rest.q));
	return { T: to_local(T), F: to_local(F), S: to_local(S.multiplyScalar(side)), side, name };
}

// how a joint is limited: a cone for the swing and a range for the twist, all in degrees from rest.
//   fwd, back, out, inn: how far the bone may swing away from its rest direction toward the front (the way an elbow folds, a hip lifts the knee),
//   the back, away from the middle of the body, and toward it. a swing in between is held to a smooth oval through the four.
//   twist: [min, max], the turn about the bone itself.
// a hinge (an elbow, a knee) is just a joint with a big fwd or back and small others.
const arc = (a, b) => new Q().setFromUnitVectors(a, b);
const bearing = (frame) => ({ D: new V().crossVectors(frame.F, frame.T).normalize(), E: new V().crossVectors(frame.S, frame.T).normalize() });

// where a turn from rest points the bone (an angle away from rest and the direction around it, 0 toward the front and 90 away from the body), and the twist
export function measure(rel, frame) {
	const q = rel.clone().normalize();
	const { D, E } = bearing(frame);
	const T2 = frame.T.clone().applyQuaternion(q);
	const theta = Math.acos(Math.min(1, Math.max(-1, T2.dot(frame.T))));
	const phi = Math.atan2(T2.dot(E), T2.dot(D));
	// what is left once the swing has been taken off is a turn about the bone
	const rest = arc(frame.T, T2).invert().multiply(q);
	let twist = 2 * Math.atan2(rest.x * frame.T.x + rest.y * frame.T.y + rest.z * frame.T.z, rest.w);
	if (twist > Math.PI) twist -= 2 * Math.PI;
	if (twist < -Math.PI) twist += 2 * Math.PI;
	return { theta: theta * DEG, phi: phi * DEG, twist: twist * DEG * frame.side, T2 };
}

// the most the bone may swing in the direction Phi around it (radians), from the four limits
export function reach(lim, phi) {
	const c = Math.cos(phi), s = Math.sin(phi);
	const a = Math.max(0.5, (c >= 0 ? lim.fwd : lim.back) ?? 180), b = Math.max(0.5, (s >= 0 ? lim.out : lim.inn) ?? 180);
	return Math.min(180, 1 / Math.sqrt((c / a) ** 2 + (s / b) ** 2));
}

// hold a turn from rest inside the limits. Returns { q, hit } (q is the same turn if it was inside)
export function clampRel(rel, frame, lim) {
	const m = measure(rel, frame);
	const { D, E } = bearing(frame);
	const phi = m.phi / DEG;
	const most = reach(lim, phi);
	const lo = lim.twist?.[0] ?? -360, hi = lim.twist?.[1] ?? 360;
	const twist = Math.min(hi, Math.max(lo, m.twist));
	if (m.theta <= most + 1e-6 && twist === m.twist) return { q: rel, hit: false, values: m };
	const theta = Math.min(m.theta, most) / DEG;
	const T2 = frame.T.clone().multiplyScalar(Math.cos(theta)).addScaledVector(D, Math.sin(theta) * Math.cos(phi)).addScaledVector(E, Math.sin(theta) * Math.sin(phi)).normalize();
	return { q: arc(frame.T, T2).multiply(new Q().setFromAxisAngle(frame.T, twist / frame.side / DEG)), hit: true, values: m };
}

// plausible human limits to start from, for each kind of joint (a left and a right bone have the same numbers); the fingers and toes are left free
const Human = {
	Waist: { fwd: 40, back: 25, out: 25, inn: 25, twist: [-30, 30] },
	Spine01: { fwd: 30, back: 20, out: 20, inn: 20, twist: [-25, 25] },
	Spine02: { fwd: 25, back: 15, out: 15, inn: 15, twist: [-25, 25] },
	NeckTwist01: { fwd: 45, back: 35, out: 30, inn: 30, twist: [-45, 45] },
	NeckTwist02: { fwd: 30, back: 25, out: 25, inn: 25, twist: [-45, 45] },
	Head: { fwd: 40, back: 40, out: 35, inn: 35, twist: [-50, 50] },
	Clavicle: { fwd: 25, back: 25, out: 30, inn: 15, twist: [-20, 20] },
	Upperarm: { fwd: 178, back: 70, out: 175, inn: 60, twist: [-90, 95] },
	Forearm: { fwd: 155, back: 8, out: 8, inn: 8, twist: [-85, 85] },
	Hand: { fwd: 90, back: 90, out: 40, inn: 40, twist: [-50, 50] },
	Thigh: { fwd: 130, back: 35, out: 95, inn: 50, twist: [-70, 70] },
	Calf: { fwd: 8, back: 155, out: 8, inn: 8, twist: [-30, 30] },
	Foot: { fwd: 35, back: 55, out: 35, inn: 35, twist: [-30, 30] },
};
export function humanDefaults() {
	const out = {};
	for (const name of Editable) {
		const base = name.replace(/^[LR]_/, '');
		if (Human[base]) out[name] = JSON.parse(JSON.stringify(Human[base]));
	}
	return out;
}

// the saved limits
export async function loadLimits(url = './limits.json') {
	try {
		const r = await fetch(url, { cache: 'no-store' });
		if (!r.ok) return {};
		const d = await r.json();
		return d?.limits ?? {};
	} catch { return {}; }
}
