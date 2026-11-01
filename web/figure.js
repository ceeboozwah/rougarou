// the climber as a skinned character (a Character Creator 4 body, assets/character/climber.glb, made by tools/convert_character.py).
// the game still works out a pose in unreal space (hip and shoulder points, elbow and knee bends, hand and foot frames, the head's look);
// apply() turns that pose into bone rotations: the spine and head from the torso frames, each arm and leg by two-bone IK to the pose's wrist or
// ankle with the elbow or knee on the pose's side, the hands and feet from their frames, and the fingers curled to the grip.
// everything here runs in three's meters and right-handed axes (toThree reflects unreal's left-handed ones).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toThree } from './gym.js';
import { jointFrame, clampRel, measure, reach as reach_, Editable, loadLimits, loadMix } from './limits.js';
import { ChalkBag } from './chalkbag.js';

const V = THREE.Vector3, Q = THREE.Quaternion;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const point = (v) => new V(...toThree(v));
const dir = (v) => point(v).normalize();
const rad = (d) => d * Math.PI / 180;
// the rig rests facing +z with +y up and its left on +x: a frame is (left, up, front)
const basis = (x, y, z) => new Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
// a frame from the way it faces and its up
function faceUp(front, up) {
	const z = front.clone().normalize();
	const y = up.clone().sub(z.clone().multiplyScalar(up.dot(z))).normalize();
	return basis(y.clone().cross(z), y, z);
}
// a frame from its left and up
function leftUp(left, up) {
	const x = left.clone().normalize();
	const y = up.clone().sub(x.clone().multiplyScalar(up.dot(x))).normalize();
	return basis(x, y, x.clone().cross(y));
}
const arc = (a, b) => new Q().setFromUnitVectors(a, b);
const about = (axis, angle) => new Q().setFromAxisAngle(axis, angle);
const spin = (v, q) => v.clone().applyQuaternion(q);
const inv = (q) => q.clone().invert();

// how far each finger's three joints close on each kind of hold, degrees (knuckle, middle, tip)
const Curl = {
	free: [18, 24, 14], jug: [22, 85, 65], crimp: [62, 98, -8], sloper: [28, 30, 22], pinch: [22, 68, 58], pocket: [40, 82, 66], smear: [4, 6, 4],
};
const Fingers = ['Index', 'Mid', 'Ring', 'Pinky'];

export class Figure {
	static async load(url, { limits = true } = {}) {
		const [gltf, set, mix] = await Promise.all([new GLTFLoader().loadAsync(url), limits ? loadLimits() : {}, limits ? loadMix() : {}]);
		const figure = new Figure(gltf);
		figure.limits = set;
		figure.setMix(mix);
		return figure;
	}

	constructor(gltf) {
		this.root = gltf.scene;
		this.root.updateMatrixWorld(true);
		this.bones = {};
		this.names = new Map();
		// the joint limits from limits.json (see limits.js), the frame of each joint they are measured in, and how often each was held to its limit
		this.limits = {};
		// how much of the turn from the pelvis to the chest (and from the chest to the face) each spine and neck joint takes; the form lab trains these
		this.posture = 1;
		this.mix = { waist: 0.35, spine01: 0.7, neck1: 0.35, neck2: 0.65 };
		this.frames = {};
		this.hits = {};
		this.misses = [0, 0, 0, 0];
		this.gaps = [new V(), new V(), new V(), new V()];
		// how far the whole body may shift (m) to keep the hands and feet on their holds when a joint limit would pull a limb off one
		this.follow = 0.4;
		this.psiNow = {};
		this.prevLocal = {};
		this.ease = false;
		this.maxTurn = 1;
		this.shiftNow = new V();
		this.shiftTarget = new V();
		this.stretchNow = 1;
		this.tick = 0;
		this.advance = true;
		this.smooth = false;
		this.dt = 0;
		// how far each joint has turned, over everything this character has done, by direction (see watch)
		this.seen = {};
		this.meshes = [];
		this.root.traverse((o) => {
			if (o.isBone) { this.bones[o.name.replace('CC_Base_', '')] = o; this.names.set(o, o.name.replace('CC_Base_', '')); }
			if (o.isMesh) {
				o.frustumCulled = false;
				o.castShadow = true;
				o.receiveShadow = true;
				this.meshes.push(o);
			}
		});
		// the rest pose: world rotation and position of each bone, and its local rotation
		this.rest = {};
		for (const [name, b] of Object.entries(this.bones)) {
			const p = new V(), q = new Q(), s = new V();
			b.matrixWorld.decompose(p, q, s);
			this.rest[name] = { p, q, local: b.quaternion.clone(), position: b.position.clone() };
		}
		const at = (n) => this.rest[n].p;
		this.length = (a, b) => at(a).distanceTo(at(b));
		this.dirOf = (a, b) => at(b).clone().sub(at(a)).normalize();
		this.materials = {};
		for (const m of this.meshes) for (const mat of [].concat(m.material)) this.materials[mat.name] = mat;
		this.eyeMeshes = this.meshes.filter(m => /Eye|Teeth/.test(m.name));
		this.first = false;
		this.checks = { hands: [0, 0] };
		// a chalk bag on a belt, and the hands that go white when they are chalked
		this.bag = new ChalkBag();
		this.root.add(this.bag.group);
		this.chalkUniforms = { uChalkR: { value: 0 }, uChalkL: { value: 0 } };
		this.chalkHands();
	}

	// note how far every limitable joint has turned this frame, in each of the four directions and the twist: the editor can start a joint's limits from this
	watch() {
		for (const name of Editable) {
			const bone = this.bones[name];
			if (!bone) continue;
			const frame = this.frames[name] ??= jointFrame(this, name);
			if (!frame) continue;
			const m = measure(inv(this.rest[name].local).multiply(bone.quaternion), frame);
			const s = this.seen[name] ??= { fwd: 0, back: 0, out: 0, inn: 0, twist: [0, 0] };
			const phi = m.phi * Math.PI / 180, c = Math.cos(phi), n = Math.sin(phi);
			if (m.theta > 0.5) {
				if (c > 0.38) s.fwd = Math.max(s.fwd, m.theta);
				if (c < -0.38) s.back = Math.max(s.back, m.theta);
				if (n > 0.38) s.out = Math.max(s.out, m.theta);
				if (n < -0.38) s.inn = Math.max(s.inn, m.theta);
			}
			s.twist[0] = Math.min(s.twist[0], m.twist);
			s.twist[1] = Math.max(s.twist[1], m.twist);
		}
	}

	// new limits from the pose restriction editor, taking effect at the next frame
	setMix(mix) { this.mix = { waist: 0.35, spine01: 0.7, neck1: 0.35, neck2: 0.65, ...(mix ?? {}) }; }
	setLimits(set) { this.limits = set ?? {}; this.frames = {}; this.hits = {}; }

	// the boxers take the shorts color from the outfit settings
	tint({ shorts, shoes }) {
		if (shorts && this.materials.Boxers) this.materials.Boxers.color.set(shorts);
		// there are no shoes on the model, so the shoe color is the chalk bag's
		if (shoes) this.bag.tint(shoes);
	}

	// how much chalk is on the right and left hand, 0 to 1: the hands go pale and dusty
	setChalk(right, left) { this.chalkUniforms.uChalkR.value = right; this.chalkUniforms.uChalkL.value = left; }

	// where the bag's mouth is, in three's meters
	bagMouth() { return this.bag.mouth(); }

	// a mask of how much of each skinned vertex belongs to the right and left hand and fingers, and the skin shaders that whiten it with the chalk
	chalkHands() {
		const uniforms = this.chalkUniforms;
		// the body is one mesh a material (head, body, arms, legs, nails): each gets the mask and the shader
		for (const mesh of this.meshes) {
			const mat = [].concat(mesh.material)[0];
			if (!mesh.skeleton || !mesh.geometry.attributes.skinIndex || !/^Std_(Skin|Nails)/.test(mat.name)) continue;
			const bones = mesh.skeleton.bones;
			const handBone = bones.map(b => { const n = b.name.replace('CC_Base_', ''); return /^[LR]_(Hand|Thumb\d|Index\d|Mid\d|Ring\d|Pinky\d)$/.test(n) ? n[0] : ''; });
			const index = mesh.geometry.attributes.skinIndex, weight = mesh.geometry.attributes.skinWeight;
			const right = new Float32Array(index.count), left = new Float32Array(index.count);
			for (let v = 0; v < index.count; v++)
				for (let k = 0; k < 4; k++) {
					const side = handBone[index.getComponent(v, k)], w = weight.getComponent(v, k);
					if (side === 'R') right[v] += w;
					else if (side === 'L') left[v] += w;
				}
			mesh.geometry.setAttribute('aChalkR', new THREE.BufferAttribute(right, 1));
			mesh.geometry.setAttribute('aChalkL', new THREE.BufferAttribute(left, 1));
			mat.onBeforeCompile = (shader) => {
				Object.assign(shader.uniforms, uniforms);
				shader.vertexShader = shader.vertexShader
					.replace('#include <common>', '#include <common>\nattribute float aChalkR;\nattribute float aChalkL;\nvarying float vChalkR;\nvarying float vChalkL;\nvarying vec2 vChalkUv;')
					.replace('#include <begin_vertex>', '#include <begin_vertex>\nvChalkR = aChalkR; vChalkL = aChalkL; vChalkUv = uv;');
				shader.fragmentShader = shader.fragmentShader
					.replace('#include <common>', '#include <common>\nuniform float uChalkR;\nuniform float uChalkL;\nvarying float vChalkR;\nvarying float vChalkL;\nvarying vec2 vChalkUv;')
					.replace('#include <map_fragment>', '#include <map_fragment>\n{ float n = fract(sin(dot(vChalkUv * 900.0, vec2(12.9898, 78.233))) * 43758.5453); float w = clamp(vChalkR * uChalkR + vChalkL * uChalkL, 0.0, 1.0) * 0.6 * (0.5 + 0.5 * n); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.93, 0.9), w); }');
			};
			mat.customProgramCacheKey = () => 'chalk-hands';
			mat.needsUpdate = true;
		}
	}

	// through the eyes: the head, lashes, eyes and teeth are not drawn (the camera sits just ahead of where the face was, so the open neck is behind it)
	firstPerson(on) {
		if (this.first === on) return;
		this.first = on;
		for (const n of ['Std_Skin_Head', 'Std_Eyelash']) if (this.materials[n]) this.materials[n].visible = !on;
		for (const m of this.eyeMeshes) m.visible = !on;
		for (const m of this.meshes) m.castShadow = !on;
	}

	// where the eyes are, in three's meters
	eye() {
		const l = this.bones.L_Eye, r = this.bones.R_Eye;
		l.updateWorldMatrix(true, false);
		r.updateWorldMatrix(true, false);
		return l.getWorldPosition(new V()).add(r.getWorldPosition(new V())).multiplyScalar(0.5);
	}

	worldQ(bone) {
		bone.updateWorldMatrix(true, false);
		const q = new Q();
		bone.matrixWorld.decompose(new V(), q, new V());
		return q;
	}

	worldP(bone) {
		bone.updateWorldMatrix(true, false);
		return new V().setFromMatrixPosition(bone.matrixWorld);
	}

	// put a bone's world rotation (and, if given, position) where wanted; its children follow
	// a local turn held to the joint's limits (limits.js); the turn itself if the bone has none or it is inside them
	limit(name, local) {
		const lim = this.limits[name];
		if (!lim) return local;
		const frame = this.frames[name] ??= jointFrame(this, name);
		if (!frame) return local;
		const rest = this.rest[name].local;
		const out = clampRel(inv(rest).multiply(local), frame, lim);
		if (!out.hit) return local;
		this.hits[name] = (this.hits[name] ?? 0) + 1;
		return rest.clone().multiply(out.q);
	}

	// returns the world rotation the bone ended up with, which is not the one asked for if a limit held it back
	put(bone, world, position) {
		const parent = bone.parent;
		parent.updateWorldMatrix(true, false);
		const pq = new Q();
		parent.matrixWorld.decompose(new V(), pq, new V());
		const name = this.names.get(bone);
		let local = this.limit(name, inv(pq).multiply(world));
		// in the last pass of a game frame no joint may turn faster than a person can: a snap (a twist wrapping round, a limit changing sides) glides instead
		if (this.ease) {
			const prev = this.prevLocal[name];
			if (prev) { const turn = prev.angleTo(local); if (turn > this.maxTurn) local = prev.clone().slerp(local, this.maxTurn / turn); }
			(this.prevLocal[name] ??= new Q()).copy(local);
		}
		bone.quaternion.copy(local);
		if (position) bone.position.copy(parent.worldToLocal(position.clone()));
		bone.updateMatrix();
		bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
		return pq.multiply(local);
	}

	// the rotation the parent has made since rest, which carries a child along if it does nothing of its own
	carried(bone) {
		const pq = new Q();
		bone.parent.updateWorldMatrix(true, false);
		bone.parent.matrixWorld.decompose(new V(), pq, new V());
		const name = Object.keys(this.bones).find(k => this.bones[k] === bone.parent);
		return name ? pq.multiply(inv(this.rest[name].q)) : pq;
	}

	// how far a point is in front of the wall panels under it, in meters (a big number where there is no wall)
	wallDepth(p) {
		let depth = 9;
		for (const w of this.walls ?? []) {
			const d = p.clone().sub(w.o), along = d.dot(w.u) + w.start;
			if (along < w.start - 0.15 || along > w.start + w.length + 0.15) continue;
			const here = d.dot(w.n);
			if (here > -0.6) depth = Math.min(depth, here);
		}
		return depth;
	}

	// one arm or leg: two-bone IK from the bone's own shoulder or hip to Target, then the end bone to World. Flex is the way the joint bends at rest (forward
	// for an elbow, back for a knee). the elbow or knee can sit anywhere on a circle around the line from the root to the target (the swivel): Pole says where it
	// would like to be, and when the joints have limits the swivel is searched for the angle that keeps the shoulder or hip, and the elbow or knee, inside them
	// (a hip does not twist 130 degrees to point a knee outward: it swings and the knee goes where the hip allows). if no swivel does, the limit holds the bone
	// and the limb misses by whatever is left, which is the most the body can do.
	limb(upperName, lowerName, endName, target, pole, flexRest, endQ) {
		const upper = this.bones[upperName], lower = this.bones[lowerName], end = this.bones[endName];
		const L1 = this.length(upperName, lowerName), L2 = this.length(lowerName, endName);
		const root = this.worldP(upper);
		const to = target.clone().sub(root);
		const reach = clamp(to.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
		const along = to.normalize();
		const x = (reach * reach + L1 * L1 - L2 * L2) / (2 * reach);
		const y = Math.sqrt(Math.max(0, L1 * L1 - x * x));
		let side = pole.clone().sub(along.clone().multiplyScalar(pole.dot(along)));
		if (side.lengthSq() < 1e-8) side = flexRest.clone().sub(along.clone().multiplyScalar(flexRest.dot(along)));
		side.normalize();
		const around = along.clone().cross(side);
		const wrist = root.clone().addScaledVector(along, reach);
		const rUp = this.rest[upperName], rLo = this.rest[lowerName], carriedUp = this.carried(upper);
		const d0 = spin(this.dirOf(upperName, lowerName), carriedUp);
		const hinge = this.dirOf(upperName, lowerName).cross(flexRest).normalize();
		const parentQ = new Q();
		upper.parent.updateWorldMatrix(true, false);
		upper.parent.matrixWorld.decompose(new V(), parentQ, new V());
		const limU = this.limits[upperName], limL = this.limits[lowerName];
		const clearance = upperName.includes('Thigh') ? 0.1 : 0.07;
		// the upper and lower bone for one swivel angle
		const attempt = (psi) => {
			const out = side.clone().multiplyScalar(Math.cos(psi)).addScaledVector(around, Math.sin(psi));
			const middle = root.clone().addScaledVector(along, x).addScaledVector(out, y);
			const t1 = middle.clone().sub(root).normalize();
			const t2 = wrist.clone().sub(middle).normalize();
			// the upper bone: the shortest turn from where its parent carries it, then rolled so the joint bends the way it does at rest
			let qU = arc(d0, t1).multiply(carriedUp).multiply(rUp.q);
			const hereHinge = spin(spin(hinge, inv(rUp.q)), qU);
			const need = t1.clone().cross(t2);
			const bend = Math.asin(clamp(need.length(), 0, 1));
			if (bend > 0.02) {
				const n = need.normalize();
				const h = hereHinge.clone().sub(t1.clone().multiplyScalar(hereHinge.dot(t1))).normalize();
				const phi = Math.atan2(t1.dot(h.clone().cross(n)), h.dot(n));
				qU = about(t1, phi * clamp((bend - 0.02) / 0.3, 0, 1)).multiply(qU);
			}
			const carriedLo = qU.clone().multiply(inv(rUp.q));
			const qL = arc(spin(this.dirOf(lowerName, endName), carriedLo), t2).multiply(carriedLo).multiply(rLo.q);
			return { qU, qL, middle, t2 };
		};
		// how far a swivel takes the shoulder or hip and the elbow or knee past (most of) their ranges, and how far it is from the pole
		const cost = (psi) => {
			const a = attempt(psi);
			let c = 0.6 * (psi / Math.PI) ** 2;
			// the elbow or knee, and the middle of the shin or forearm, must stay out of the wall
			if (this.walls?.length) {
				const ankle = a.middle.clone().addScaledVector(a.t2, L2 * 0.5);
				c += 900 * Math.max(0, clearance - this.wallDepth(a.middle)) ** 2 + 900 * Math.max(0, clearance * 0.6 - this.wallDepth(ankle)) ** 2;
			}
			for (const [name, lim, q, parent] of [[upperName, limU, a.qU, parentQ], [lowerName, limL, a.qL, a.qU]]) {
				if (!lim) continue;
				const frame = this.frames[name] ??= jointFrame(this, name);
				if (!frame) continue;
				const m = measure(inv(this.rest[name].local).multiply(inv(parent).multiply(q)), frame);
				const r = m.theta / Math.max(1, reach_(lim, m.phi * Math.PI / 180));
				const t = m.twist >= 0 ? m.twist / Math.max(1, lim.twist?.[1] ?? 180) : m.twist / Math.min(-1, lim.twist?.[0] ?? -180);
				c += 40 * Math.max(0, r - 0.92) ** 2 + 40 * Math.max(0, t - 0.92) ** 2 + 0.5 * Math.max(0, r - 0.7) ** 2 + 0.3 * Math.max(0, t - 0.7) ** 2;
			}
			return c;
		};
		// the swivel: kept from the last frame and only nudged (a local descent from where it was), so the knee or elbow does not jump between two good answers.
		// a search all the way round happens when the old one has gone bad, and its answer is taken only if it is clearly better. the move is rate limited
		let psi = 0;
		if (limU || limL || this.walls?.length) {
			const before = this.psiNow[upperName];
			if (!this.advance && before !== undefined) psi = before;
			else {
				let p = before ?? 0, best = cost(p);
				for (const h of [0.3, 0.12, 0.05, 0.02]) for (const q of [p - h, p + h]) { const c = cost(q); if (c < best - 1e-9) { best = c; p = q; } }
				if (before === undefined || best > 0.8 || (this.tick++ & 31) === 0) {
					let g = p, gc = best;
					for (let k = 0; k < 36; k++) { const q = (k / 36) * 2 * Math.PI - Math.PI, c = cost(q); if (c < gc - 1e-9) { gc = c; g = q; } }
					if (before === undefined || gc < best - 0.4) { p = g; best = gc; }
					for (let h = Math.PI / 36; h > 0.01; h *= 0.5) for (const q of [p - h, p + h]) { const c = cost(q); if (c < best - 1e-9) { best = c; p = q; } }
				}
				if (this.smooth && before !== undefined) {
					const gap = Math.atan2(Math.sin(p - before), Math.cos(p - before)), most = 6 * this.dt;
					psi = before + clamp(gap, -most, most);
				} else psi = p;
				this.psiNow[upperName] = psi;
			}
		}
		const chosen = attempt(psi);
		const middle = chosen.middle;
		const qU = this.put(upper, chosen.qU);
		// the elbow or knee is wherever the upper bone, held to its limits, has put it: the lower bone aims at the target from there
		lower.updateWorldMatrix(true, false);
		const jointNow = new V().setFromMatrixPosition(lower.matrixWorld);
		let t2 = chosen.t2;
		if (wrist.distanceToSquared(jointNow) > 1e-8) t2 = wrist.clone().sub(jointNow).normalize();
		// the lower bone: carried by the upper, then the shortest turn onto its direction
		const carriedLo = qU.clone().multiply(inv(rUp.q));
		const dLo = spin(this.dirOf(lowerName, endName), carriedLo);
		let qL = arc(dLo, t2).multiply(carriedLo).multiply(rLo.q);
		// the end bone shares its twist with the lower one, so the skin is not wrung out between them
		const axis = spin(this.dirOf(lowerName, endName), inv(rLo.q));
		const rel = inv(qL).multiply(endQ);
		const proj = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
		let twist = 2 * Math.atan2(proj, rel.w);
		if (twist > Math.PI) twist -= 2 * Math.PI;
		if (twist < -Math.PI) twist += 2 * Math.PI;
		qL = qL.multiply(about(axis, twist * 0.5));
		this.put(lower, qL);
		this.put(end, endQ);
		// how far from where the limb was aimed it ended up, in meters: nothing but the joint limits can make it miss
		end.updateWorldMatrix(true, false);
		const gap = wrist.clone().sub(this.worldP(end));
		return { middle, wrist, reach: reach / (L1 + L2), miss: gap.length(), gap, psi };
	}

	// the hands: the turn that takes the rest hand's (fingers, thumb side, back of hand) onto the pose's
	handFrame(side, name) {
		const hand = this.bones[`${side}_Hand`];
		const over0 = this.dirOf(`${side}_Hand`, `${side}_Mid1`);
		let thumb0 = this.rest[`${side}_Index1`].p.clone().sub(this.rest[`${side}_Pinky1`].p);
		thumb0.sub(over0.clone().multiplyScalar(thumb0.dot(over0))).normalize();
		const back0 = side === 'R' ? over0.clone().cross(thumb0) : thumb0.clone().cross(over0);
		return { hand, over0, thumb0, back0 };
	}

	// the pose is in unreal centimeters (see sim.js); Delta is the time since the last frame
	apply(pose, delta = 0) {
		this.applyPose(pose, delta);
		this.watch();
	}

	// the body posed on the sim's pose. when a limb is held short of its hold by a joint limit, the hips and shoulders move toward it (a person shifts their
	// weight, they do not leave a hand behind), a few passes, never further than this.follow
	applyPose(pose, delta = 0) {
		const base = this.limits;
		// in the game (Delta > 0) everything the solver chooses is eased from frame to frame; the lab (Delta 0) takes each pose exactly
		const smooth = delta > 0 && delta < 0.25, dt = Math.min(delta, 0.05);
		this.smooth = smooth;
		this.dt = dt;
		if (!smooth) { this.psiNow = {}; this.prevLocal = {}; this.shiftNow.set(0, 0, 0); this.stretchNow = 1; }
		this.maxTurn = Math.max(0.1, 0.25 * dt * 60);
		this.stretch = 1;
		this.advance = true;
		this.#pass(pose, delta, this.shiftNow);
		this.advance = false;
		if (!this.follow || !Object.keys(base).length) { this.shiftNow.multiplyScalar(0.8); this.prevLocal = {}; return; }
		let worst = this.#settle(pose, this.shiftNow.clone());
		let need = 1, target = this.shiftTarget.clone();
		// a pose the sim asks for that no body could hold (a foot above the hip within a hand's width of it): the joints are stretched past their ranges in steps,
		// only as far as it takes, rather than leave a foot hanging a meter off its hold. this.stretch says how far it went (1 is within anatomy)
		for (const k of [1.3, 1.7, 2.5, 4]) {
			if (worst <= 0.05) break;
			this.limits = this.stretched(k, base);
			need = k;
			worst = this.#settle(pose, target.clone());
			target = this.shiftTarget.clone();
		}
		this.limits = base;
		if (smooth) {
			this.shiftNow.lerp(target, 1 - Math.exp(-dt * 12));
			this.stretchNow += (need - this.stretchNow) * (1 - Math.exp(-dt * (need > this.stretchNow ? 14 : 3)));
		} else { this.shiftNow.copy(target); this.stretchNow = need; }
		this.stretch = this.stretchNow;
		if (this.stretchNow > 1.01) this.limits = this.stretched(this.stretchNow, base);
		this.ease = smooth;
		this.#pass(pose, 0, this.shiftNow);
		this.ease = false;
		this.limits = base;
	}

	// the ranges widened by Factor (the swing and the twist, up to a half turn)
	stretched(factor, from = this.limits) {
		const out = {};
		for (const [n, l] of Object.entries(from)) out[n] = { fwd: Math.min(180, l.fwd * factor), back: Math.min(180, l.back * factor), out: Math.min(180, l.out * factor), inn: Math.min(180, l.inn * factor), twist: [Math.max(-180, l.twist[0] * factor), Math.min(180, l.twist[1] * factor)] };
		return out;
	}

	// the body shifted toward whatever a limit holds short of its hold, a few passes. returns the worst miss left (m)
	#settle(pose, offset) {
		this.#pass(pose, 0, offset);
		for (let pass = 0; pass < 4 && Math.max(...this.misses) > 0.01; pass++) {
			const step = new V();
			this.gaps.forEach((g, i) => { if (this.misses[i] > 0.005) step.add(g); });
			offset.addScaledVector(step, 0.5);
			if (offset.length() > this.follow) offset.setLength(this.follow);
			this.#pass(pose, 0, offset);
		}
		this.shiftTarget = offset;
		return Math.max(...this.misses);
	}

	#pass(pose, delta, offset) {
		this.walls = (pose.walls ?? []).map(w => ({ o: point(w.origin), n: dir(w.out), u: dir(w.up), start: w.start, length: w.length }));
		const b = this.bones, rest = this.rest;
		const [hipR, hipL, shoR, shoL] = pose.roots.map(r => point(r).add(offset));
		const pelvis = hipR.clone().add(hipL).multiplyScalar(0.5), chest = shoR.clone().add(shoL).multiplyScalar(0.5);
		const up = chest.clone().sub(pelvis).normalize();
		const framePelvis = leftUp(hipL.clone().sub(hipR), up);
		const frameChest = leftUp(shoL.clone().sub(shoR), up);
		// a body does not hold its back straight: reaching up opens the chest (the thoracic spine extends) and reaching with one arm bends the trunk away from it
		if (this.posture) {
			const lift = [2, 3].map(l => clamp(up.dot(point(pose.limbs[l].end).sub(l === 2 ? shoR : shoL)) / 0.5, 0, 1));
			const extension = 16 * Math.min(1, (lift[0] + lift[1]) * 0.55), lateral = 12 * (lift[0] - lift[1]);
			frameChest.multiply(new Q().setFromEuler(new THREE.Euler(-extension * this.posture * Math.PI / 180, 0, -lateral * this.posture * Math.PI / 180)));
		}
		const look = dir(pose.look);
		const frameHead = faceUp(look, up);

		// the pelvis: its joints land on the pose's hips
		const thighMid = rest.L_Thigh.p.clone().add(rest.R_Thigh.p).multiplyScalar(0.5);
		const hipAt = pelvis.clone().add(spin(rest.Hip.p.clone().sub(thighMid), framePelvis));
		this.put(b.Hip, framePelvis.clone().multiply(rest.Hip.q), hipAt);
		this.bag.update(pelvis, framePelvis, delta);
		// the spine turns from the pelvis frame to the chest frame, and the neck and head on to where the face looks
		const mix = (a, c, t) => a.clone().slerp(c, t);
		this.put(b.Waist, mix(framePelvis, frameChest, this.mix.waist).multiply(rest.Waist.q));
		this.put(b.Spine01, mix(framePelvis, frameChest, this.mix.spine01).multiply(rest.Spine01.q));
		this.put(b.Spine02, frameChest.clone().multiply(rest.Spine02.q));
		this.put(b.NeckTwist01, mix(frameChest, frameHead, this.mix.neck1).multiply(rest.NeckTwist01.q));
		this.put(b.NeckTwist02, mix(frameChest, frameHead, this.mix.neck2).multiply(rest.NeckTwist02.q));
		this.put(b.Head, frameHead.clone().multiply(rest.Head.q));

		for (let l = 0; l < 4; l++) {
			const limb = pose.limbs[l], arm = l >= 2, side = l % 2 === 0 ? 'R' : 'L';
			const end = point(limb.end), bend = limb.bend ? point(limb.bend) : null;
			const flex = new V(0, 0, arm ? 1 : -1);
			const roots = arm ? [shoR, shoL][l - 2] : [hipR, hipL][l];
			const mid = roots.clone().add(end).multiplyScalar(0.5);
			const pole = bend ? bend.clone().sub(mid) : dir(limb.pole);
			if (arm) {
				const h = limb.hand;
				const over = dir(h.over), thumb0 = dir(h.thumb);
				const thumb = thumb0.sub(over.clone().multiplyScalar(thumb0.dot(over))).normalize();
				const back = side === 'R' ? over.clone().cross(thumb) : thumb.clone().cross(over);
				const hf = this.handFrame(side, 'hand');
				// right-handed either way: (fingers, thumb side, back) on a right hand, (thumb side, fingers, back) on a left
				const frame = (o, t, k) => side === 'R' ? basis(o, t, k) : basis(t, o, k);
				const to = frame(over, thumb, back), from = frame(hf.over0, hf.thumb0, hf.back0);
				const endQ = to.multiply(inv(from)).multiply(rest[`${side}_Hand`].q);
				{ const r = this.limb(`${side}_Upperarm`, `${side}_Forearm`, `${side}_Hand`, end, pole, flex, endQ); this.misses[l] = r.miss; this.gaps[l] = r.gap; }
				this.curl(side, hf, h.grip);
				// a check that the pose's back of hand and the one this hand's chirality gives agree
				if (h.out && dir(h.out).dot(back) < 0) this.checks.hands[l - 2]++;
			} else {
				const f = limb.foot;
				const toe = point(f.toe), heel = point(f.heel);
				const along = toe.clone().sub(heel).normalize();
				let back = f.dorsum ? dir(f.dorsum) : dir(f.up);
				back.sub(along.clone().multiplyScalar(back.dot(along))).normalize();
				const left = back.clone().cross(along);
				// the rest foot's frame: along the sole, up from it, and across
				const along0 = this.dirOf(`${side}_Foot`, `${side}_ToeBase`);
				const flat = along0.clone().sub(new V(0, along0.y, 0)).normalize();
				const back0 = new V(0, 1, 0);
				const left0 = back0.clone().cross(flat);
				const turn = basis(left, back, along).multiply(inv(basis(left0, back0, flat)));
				const endQ = turn.clone().multiply(rest[`${side}_Foot`].q);
				// the ankle sits where the toe on the hold puts it
				const tip = rest[`${side}_ToeBase`].p.clone().addScaledVector(along0, 0.05);
				const ankle = toe.clone().sub(spin(tip.sub(rest[`${side}_Foot`].p), turn));
				{ const r = this.limb(`${side}_Thigh`, `${side}_Calf`, `${side}_Foot`, ankle, pole, flex, endQ); this.misses[l] = r.miss; this.gaps[l] = r.gap; }
			}
		}
	}

	// the fingers close on the hold
	curl(side, hf, grip) {
		const angles = Curl[grip] ?? Curl.free;
		const sign = side === 'R' ? 1 : -1;
		for (const name of Fingers) for (let k = 1; k <= 3; k++) {
			const key = `${side}_${name}${k}`, bone = this.bones[key], r = this.rest[key];
			if (!bone) continue;
			const axis = spin(hf.thumb0, inv(r.q));
			bone.quaternion.copy(this.limit(key, r.local.clone().multiply(about(axis, rad(angles[k - 1]) * sign))));
			bone.updateMatrix();
		}
	}
}
