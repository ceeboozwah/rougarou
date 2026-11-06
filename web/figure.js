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
		// nothing of the body may be in the wall or a hold (applyPose pushes the whole body out until it is not, up to maxPush meters)
		this.noClip = true;
		this.searchSteps = null;
		this.overruled = 0;
		this.maxPush = 0.5;
		this.pushNow = new V();
		this.limbPush = [new V(), new V(), new V(), new V()];
		this.endAt = [new V(), new V(), new V(), new V()];
		this.balls = [];
		this.openNow = new V();
		this.openSearch = true;
		this.openMax = { x: 0.45, y: 0.6, z: 0.35 };
		this.strict = true;
		this.weights = { miss: 1, clip: 6, strain: 0.4, open: 3 };
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
	setMix(mix) {
		this.mix = { waist: 0.35, spine01: 0.7, neck1: 0.35, neck2: 0.65, ...(mix ?? {}) };
		// the form lab also trains how much the solver minds turning the pelvis (wopen, of 12) and joints near the end of their range (wstrain, of 2)
		this.weights = { ...this.weights, open: (mix?.wopen ?? 0.25) * 12, strain: (mix?.wstrain ?? 0.2) * 2 };
	}
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

	// the wall panel nearest in front of a point: its depth in meters (9 where there is no wall) and the way it faces
	wallAt(p) {
		// the wall is a run of flat panels, each a strip: a point's depth is its distance in front of the panel it is nearest, measured to the strip itself and not to
		// the plane it lies in (a plane carried on past the edge of its panel cuts through open air at a convex corner, and at those a knee was found "in the wall")
		let depth = 9, n = null, best = Infinity;
		for (const w of this.walls ?? []) {
			const d = p.clone().sub(w.o), along = d.dot(w.u) + w.start;
			const s = clamp(along, w.start, w.start + w.length);
			const q = d.clone().addScaledVector(w.u, -(s - w.start));
			const here = q.dot(w.n);
			if (here < -0.6) continue;
			const dist = s === along ? Math.abs(here) : q.length();
			if (dist < best) { best = dist; depth = s === along ? here : dist; n = w.n; }
		}
		return { depth, n };
	}

	// how far a point is in front of the wall panels under it, in meters (a big number where there is no wall)
	wallDepth(p) { return this.wallAt(p).depth; }

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
				const roll = phi * clamp((bend - 0.02) / 0.3, 0, 1);
				qU = about(t1, roll).multiply(qU);
			}
			const carriedLo = qU.clone().multiply(inv(rUp.q));
			const qL = arc(spin(this.dirOf(lowerName, endName), carriedLo), t2).multiply(carriedLo).multiply(rLo.q);
			return { qU, qL, middle, t2 };
		};
		// how far a swivel takes the shoulder or hip and the elbow or knee past (most of) their ranges, and how far it is from the pole
		const cost = (psi) => {
			const a = attempt(psi);
			let c = 0.6 * (psi / Math.PI) ** 2;
			// where the elbow or knee really ends up once the shoulder or hip is held to its range (not where it was asked to be), how far the lower bone then
			// misses its aim, and whether the knee, the middle of the shin or forearm and the thigh are in the wall or a hold
			if (this.walls?.length || this.balls?.length) {
				let qc = a.qU;
				const frameU = this.frames[upperName] ??= jointFrame(this, upperName);
				if (limU && frameU) {
					const cl = clampRel(inv(this.rest[upperName].local).multiply(inv(parentQ).multiply(a.qU)), frameU, limU);
					if (cl.hit) qc = parentQ.clone().multiply(this.rest[upperName].local).multiply(cl.q);
				}
				const knee = root.clone().addScaledVector(spin(this.dirOf(upperName, lowerName), qc.clone().multiply(inv(rUp.q))), L1);
				const shin = knee.clone().lerp(wrist, 0.5);
				c += 0.6 * (Math.abs(wrist.distanceTo(knee) - L2) * 100) ** 2;
				const thigh = root.clone().lerp(knee, 0.5);
				const r1 = clearance * 0.5, r2 = clearance * 0.6;
				for (const [p, rad, want] of [[knee, clearance * 0.8, clearance], [shin, r2, r2], [thigh, r1, r1]]) {
					c += 900 * Math.max(0, want - this.wallDepth(p)) ** 2;
					for (const hold of this.balls) c += 900 * Math.max(0, 0.01 - this.domeClear(p, hold, rad)) ** 2;
				}
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
		if (!smooth) { this.psiNow = {}; this.prevLocal = {}; this.shiftNow.set(0, 0, 0); this.openNow.set(0, 0, 0); this.pushNow.set(0, 0, 0); this.limbPush.forEach(v => v.set(0, 0, 0)); this.stretchNow = 1; }
		this.maxTurn = Math.max(0.1, 0.25 * dt * 60);
		this.stretch = 1;
		this.advance = true;
		this.#pass(pose, delta, this.shiftNow, this.openNow);
		this.advance = false;
		if (!this.follow || !Object.keys(base).length) { this.shiftNow.multiplyScalar(0.8); this.openNow.multiplyScalar(0.8); this.prevLocal = {}; return; }
		// opening the hips: the pelvis can tip (x), turn (y) and roll (z) a little under the spine, which swings the knees out of the wall, takes a high foot
		// off the edge of the hip's range and lets a reach go further. a local search from last frame's angles for the least cost (misses, anything of the body in the
		// wall or a hold, joints near their ends, and a little for the effort of the angle itself), moved toward at a limited speed so the hips do not jerk
		if (this.openSearch) {
			let cur = this.openNow.clone(), best = this.#score(pose, this.shiftNow, cur);
			// in the game it walks a little each frame from where it was; the lab has one go at a pose, so it looks further
			const steps = this.searchSteps ?? (smooth ? [0.2, 0.08] : [0.3, 0.3, 0.15, 0.15, 0.07, 0.03]);
			for (const step of steps) for (const axis of ['x', 'y', 'z']) for (const sign of [1, -1]) {
				const c = cur.clone();
				c[axis] = clamp(c[axis] + sign * step, -this.openMax[axis], this.openMax[axis]);
				if (c[axis] === cur[axis]) continue;
				const s = this.#score(pose, this.shiftNow, c);
				if (s < best - 1e-6) { best = s; cur = c; }
			}
			if (smooth) {
				const most = 2.5 * dt;
				for (const axis of ['x', 'y', 'z']) this.openNow[axis] += clamp(cur[axis] - this.openNow[axis], -most, most);
			} else this.openNow.copy(cur);
		}
		this.#settle(pose, this.shiftNow.clone(), this.openNow);
		let target = this.shiftTarget.clone();
		// strict: no joint goes past its range. (a pose that cannot be held within them leaves a limb short of its hold; the old way stretched the ranges)
		let need = 1;
		if (!this.strict) {
			let worst = Math.max(...this.misses);
			for (const k of [1.3, 1.7, 2.5, 4]) {
				if (worst <= 0.05) break;
				this.limits = this.stretched(k, base);
				need = k;
				worst = this.#settle(pose, target.clone(), this.openNow);
				target = this.shiftTarget.clone();
			}
			this.limits = base;
		}
		if (smooth) {
			this.shiftNow.lerp(target, 1 - Math.exp(-dt * 12));
			this.stretchNow += (need - this.stretchNow) * (1 - Math.exp(-dt * (need > this.stretchNow ? 14 : 3)));
		} else { this.shiftNow.copy(target); this.stretchNow = need; }
		this.stretch = this.stretchNow;
		if (this.stretchNow > 1.01) this.limits = this.stretched(this.stretchNow, base);
		// the last pass, and then the rule that comes before everything else: no part of the body is in the wall or a hold. whatever is, the whole body is moved
		// out along the way that part is being pushed (the wall's normal, the hold's gradient) by the depth plus a millimeter, and posed again, until nothing is
		// (at most this.maxPush). a limb that is then too far from its hold is simply short of it: clipping goes before holds, and the ranges stay as they are.
		// the push lets go slowly in the game, so the body does not twitch in and out
		const snap = Object.fromEntries(Object.entries(this.prevLocal).map(([k, q]) => [k, q.clone()]));
		let easing = smooth;
		const pass = (extra) => {
			this.prevLocal = Object.fromEntries(Object.entries(snap).map(([k, q]) => [k, q.clone()]));
			this.ease = easing;
			this.#pass(pose, 0, this.shiftNow.clone().add(extra), this.openNow);
			this.ease = false;
		};
		const push = this.pushNow.clone().multiplyScalar(smooth ? Math.exp(-dt * 5) : 0);
		for (const v of this.limbPush) v.multiplyScalar(smooth ? Math.exp(-dt * 6) : 0);
		pass(push);
		if (this.noClip) {
			for (let i = 0; i < 8; i++) {
				const c = this.clipNow();
				if (c.worst <= 0 || !c.dir) break;
				// the limit on how fast a joint may turn (which only smooths the motion) gives way after the first few tries: nothing in the wall comes first
				if (i >= 2) easing = false;
				push.addScaledVector(c.dir, c.worst * (1 + i * 0.25) + 0.004);
				if (push.length() > this.maxPush) push.setLength(this.maxPush);
				pass(push);
			}
			this.#depenetrate();
			// and if a limb is still caught (a foot target that no joint can reach without it): the whole body goes further out, as far as it takes, the hands and feet
			// staying where the sim put them. nothing in the wall is not negotiable
			for (let i = 0; i < 12; i++) {
				const c = this.clipNow();
				if (c.worst <= 0 || !c.dir) break;
				push.addScaledVector(c.dir, c.worst * 1.5 + 0.01);
				if (push.length() > 1.5) push.setLength(1.5);
				pass(push);
				this.#depenetrate();
			}
		}
		// the next frame's turn-rate limit starts from where the joints really are now, whichever pass got them there
		if (smooth) for (const name of Object.keys(this.prevLocal)) this.prevLocal[name] = this.bones[name].quaternion.clone();
		this.pushNow.copy(push);
		this.limits = base;
	}

	// the body is never shifted into the wall: the hips stay at least 10 cm and the shoulders 13 cm clear of it
	#keepOut(pose, offset) {
		if (!this.walls?.length) return;
		for (const [i, j, least] of [[0, 1, 0.1], [2, 3, 0.13]]) {
			const mid = point(pose.roots[i]).add(point(pose.roots[j])).multiplyScalar(0.5).add(offset);
			const depth = this.wallDepth(mid);
			if (depth < least) {
				const w = this.walls.find(w => { const along = mid.clone().sub(w.o).dot(w.u) + w.start; return along >= w.start - 0.15 && along <= w.start + w.length + 0.15; });
				if (w) offset.addScaledVector(w.n, least - depth);
			}
		}
	}

	// what a pose on the skeleton costs: limbs off their holds, the body in the wall or a hold, joints near the end of their range, the pelvis turned for nothing
	#score(pose, offset, open) {
		this.#pass(pose, 0, offset, open);
		const w = this.weights;
		let miss = 0;
		for (const m of this.misses) miss += (m * 100) ** 2;
		const clip = this.clipNow();
		return w.miss * miss + w.clip * clip.sum * 1e4 + w.strain * this.strainNow() + w.open * (open.x * open.x + open.y * open.y + open.z * open.z) * 100;
	}

	// how far a point of the body (a capsule of Radius round it) is clear of a hold, a half-ellipsoid standing on the wall: positive outside, negative inside
	domeClear(p, h, radius) {
		const d = p.clone().sub(h.c), along = d.dot(h.n);
		if (along < -radius) return 9;
		const lateral = d.addScaledVector(h.n, -along).length();
		const q = (lateral / (h.r + radius)) ** 2 + (Math.max(along, 0) / (h.h + radius)) ** 2;
		return q >= 1 ? 9 : (Math.sqrt(q) - 1) * Math.min(h.h + radius, h.r + radius);
	}

	// how far the body is in the wall or in a hold: the legs, arms, pelvis, trunk and head as capsules and balls sampled along their length (the hands and feet
	// are where the sim put them, on a hold, and no push of the body can move them, so they are not tested; a hold a limb is on or at is skipped for it). returns the sum of squared depths (m2), the deepest (m) and the way out of it
	clipNow() {
		const P = (n) => { const e = this.bones[n].matrixWorld.elements; return new V(e[12], e[13], e[14]); };
		let sum = 0, worst = 0, dir = null, limb = -1, bone = null, at = null;
		this.clipBy = {};
		let tag = '', owner = -1, proximal = null, here = null;
		const note = (kind, depth, d) => {
			sum += depth * depth;
			this.clipBy[`${tag}:${kind}`] = Math.max(this.clipBy[`${tag}:${kind}`] ?? 0, -depth);
			if (-depth > worst) { worst = -depth; dir = d; limb = owner; bone = proximal; at = here; }
		};
		const test = (p, radius, skip, margin = 0.01) => {
			here = p;
			// within a hand's width of where a limb's own end is held (on a panel, or at a corner between two) is where it is meant to be touching
			const w = this.wallAt(p);
			let depth = w.depth - radius - margin;
			if (depth < 0 && w.n && !(skip && skip.distanceTo(p) < 0.12)) note('wall', depth, w.n);
			for (const h of this.balls) {
				if (skip && skip.distanceTo(h.c) < h.r + 0.12) continue;
				depth = this.domeClear(p, h, radius);
				if (depth < 0) {
					// out along the dome's own gradient: sideways from its middle and up from the wall
					const d = p.clone().sub(h.c), along = d.dot(h.n);
					const lateral = d.clone().addScaledVector(h.n, -along);
					const g = lateral.multiplyScalar(1 / (h.r + radius) ** 2).addScaledVector(h.n, Math.max(along, 0) / (h.h + radius) ** 2);
					note('hold', depth, g.lengthSq() > 1e-12 ? g.normalize() : h.n.clone());
				}
			}
		};
		const along = (a, b, radius, skip) => { for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) test(a.clone().lerp(b, t), radius, skip); };
		for (const [l, side] of [[0, 'R'], [1, 'L'], [2, 'R'], [3, 'L']]) {
			const skip = this.endAt[l];
			owner = l;
			if (l < 2) { tag = `${side}thigh`; proximal = `${side}_Thigh`; along(P(`${side}_Thigh`), P(`${side}_Calf`), 0.08, skip); tag = `${side}shin`; proximal = `${side}_Calf`; along(P(`${side}_Calf`), P(`${side}_Foot`), 0.05, skip); }
			else { tag = `${side}arm`; proximal = `${side}_Upperarm`; along(P(`${side}_Upperarm`), P(`${side}_Forearm`), 0.045, skip); tag = `${side}forearm`; proximal = `${side}_Forearm`; along(P(`${side}_Forearm`), P(`${side}_Hand`), 0.04, skip); }
		}
		owner = -1;
		proximal = null;
		tag = 'pelvis';
		test(P('Hip'), 0.12, null);
		tag = 'torso';
		along(P('Hip'), P('Head'), 0.13, null);
		tag = 'head';
		test(P('Head'), 0.1, null);
		return { sum, worst, dir, limb, bone, at };
	}

	// the last resort, and a certain one: whatever part of a limb is in the wall or a hold is turned out of it about its own joint (the shin about the knee, then the
	// thigh about the hip; the forearm about the elbow, then the arm about the shoulder), each turn held to the joint's range unless the range itself is what holds the limb in the wall. the limb leaves its hold by exactly as
	// much as it takes. returns whether anything was left in
	#depenetrate() {
		for (let i = 0; i < 90; i++) {
			const c = this.clipNow();
			if (c.worst <= 0) return false;
			if (!c.bone || !c.dir) return true;
			let moved = false;
			const chain = c.bone.endsWith('_Calf') ? [c.bone, c.bone.replace('Calf', 'Thigh')] : c.bone.endsWith('_Forearm') ? [c.bone, c.bone.replace('Forearm', 'Upperarm')] : [c.bone];
			// each joint of the limb in turn, first within its range; one that does not take the part out of the wall by a real step is put back and the next tried, and
			// if none does the first goes past its range after all
			for (const overrule of [false, true]) {
				for (const name of chain) {
					if (moved) break;
					const bone = this.bones[name];
					bone.updateWorldMatrix(true, false);
					const joint = new V().setFromMatrixPosition(bone.matrixWorld);
					const r = c.at.clone().sub(joint), len = r.length();
					if (len < 0.03) continue;
					let axis = new V().crossVectors(r, c.dir), straight = false;
					// a limb pointing straight into the wall (or straight out of a hold) has no one way round: turn it about any axis across the way out
					if (axis.lengthSq() < 1e-6) { axis = new V().crossVectors(c.dir, Math.abs(c.dir.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0)); straight = true; }
					const angle = straight ? 0.3 : Math.min(0.25, (c.worst + 0.003) / len * 1.3);
					const before = bone.quaternion.clone();
					const worldQ = this.worldQ(bone), parentQ = this.worldQ(bone.parent);
					const wanted = inv(parentQ).multiply(new Q().setFromAxisAngle(axis.normalize(), angle).multiply(worldQ));
					bone.quaternion.copy(overrule ? wanted : this.limit(name, wanted));
					bone.updateMatrix();
					bone.updateMatrixWorld(true);
					const after = this.clipNow();
					if (after.worst < c.worst * 0.97 - 1e-5 || (after.worst <= c.worst && after.sum < c.sum * 0.9)) { moved = true; if (overrule) this.overruled++; }
					else { bone.quaternion.copy(before); bone.updateMatrix(); bone.updateMatrixWorld(true); }
				}
				if (moved) break;
			}
			if (!moved) return true;
		}
		return this.clipNow().worst > 0;
	}

	// joints near the end of their range, from the bones as they stand: (the share of the range past 80%) squared, and the twist the same
	strainNow() {
		let s = 0;
		for (const [name, lim] of Object.entries(this.limits)) {
			const bone = this.bones[name];
			if (!bone) continue;
			const frame = this.frames[name] ??= jointFrame(this, name);
			if (!frame) continue;
			const m = measure(inv(this.rest[name].local).multiply(bone.quaternion), frame);
			const r = m.theta / Math.max(1, reach_(lim, m.phi * Math.PI / 180));
			const t = m.twist >= 0 ? m.twist / Math.max(1, lim.twist?.[1] ?? 180) : m.twist / Math.min(-1, lim.twist?.[0] ?? -180);
			if (r > 0.8) s += ((r - 0.8) / 0.2) ** 2;
			if (t > 0.8) s += ((t - 0.8) / 0.2) ** 2;
		}
		return s;
	}

	// the ranges widened by Factor (the swing and the twist, up to a half turn)
	stretched(factor, from = this.limits) {
		const out = {};
		for (const [n, l] of Object.entries(from)) out[n] = { fwd: Math.min(180, l.fwd * factor), back: Math.min(180, l.back * factor), out: Math.min(180, l.out * factor), inn: Math.min(180, l.inn * factor), twist: [Math.max(-180, l.twist[0] * factor), Math.min(180, l.twist[1] * factor)] };
		return out;
	}

	// the body shifted toward whatever a limit holds short of its hold, a few passes. returns the worst miss left (m)
	#settle(pose, offset, open) {
		this.#pass(pose, 0, offset, open);
		for (let pass = 0; pass < 4 && Math.max(...this.misses) > 0.01; pass++) {
			const step = new V();
			this.gaps.forEach((g, i) => { if (this.misses[i] > 0.005) step.add(g); });
			offset.addScaledVector(step, 0.5);
			if (offset.length() > this.follow) offset.setLength(this.follow);
			this.#keepOut(pose, offset);
			this.#pass(pose, 0, offset, open);
		}
		this.shiftTarget = offset;
		return Math.max(...this.misses);
	}

	#pass(pose, delta, offset, open) {
		this.balls = (pose.holds ?? []).filter(h => h.n && h.h).map(h => ({ c: point(h.c), n: dir(h.n), r: h.r / 100, h: h.h / 100 }));
		this.walls = (pose.walls ?? []).map(w => ({ o: point(w.origin), n: dir(w.out), u: dir(w.up), start: w.start, length: w.length }));
		const b = this.bones, rest = this.rest;
		const [hipR, hipL, shoR, shoL] = pose.roots.map(r => point(r).add(offset));
		const pelvis = hipR.clone().add(hipL).multiplyScalar(0.5), chest = shoR.clone().add(shoL).multiplyScalar(0.5);
		const up = chest.clone().sub(pelvis).normalize();
		const framePelvis = leftUp(hipL.clone().sub(hipR), up);
		if (open.lengthSq() > 1e-8) framePelvis.multiply(new Q().setFromEuler(new THREE.Euler(open.x, open.y, open.z)));
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
			// a limb that cannot get to its hold without a part of it in the wall is held off the hold instead (limbPush), never through the wall
			const end = point(limb.end), bend = limb.bend ? point(limb.bend) : null;
			this.endAt[l] = end;
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
