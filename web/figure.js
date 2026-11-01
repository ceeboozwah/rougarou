// the climber as a skinned character (a Character Creator 4 body, assets/character/climber.glb, made by tools/convert_character.py).
// the game still works out a pose in unreal space (hip and shoulder points, elbow and knee bends, hand and foot frames, the head's look);
// apply() turns that pose into bone rotations: the spine and head from the torso frames, each arm and leg by two-bone IK to the pose's wrist or
// ankle with the elbow or knee on the pose's side, the hands and feet from their frames, and the fingers curled to the grip.
// everything here runs in three's meters and right-handed axes (toThree reflects unreal's left-handed ones).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toThree } from './gym.js';

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
	static async load(url) {
		const gltf = await new GLTFLoader().loadAsync(url);
		return new Figure(gltf);
	}

	constructor(gltf) {
		this.root = gltf.scene;
		this.root.updateMatrixWorld(true);
		this.bones = {};
		this.meshes = [];
		this.root.traverse((o) => {
			if (o.isBone) this.bones[o.name.replace('CC_Base_', '')] = o;
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
	}

	// the boxers take the shorts color from the outfit settings
	tint({ shorts }) { if (shorts && this.materials.Boxers) this.materials.Boxers.color.set(shorts); }

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
	put(bone, world, position) {
		const parent = bone.parent;
		parent.updateWorldMatrix(true, false);
		const pq = new Q();
		parent.matrixWorld.decompose(new V(), pq, new V());
		bone.quaternion.copy(pq.invert().multiply(world));
		if (position) bone.position.copy(parent.worldToLocal(position.clone()));
		bone.updateMatrix();
		bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
	}

	// the rotation the parent has made since rest, which carries a child along if it does nothing of its own
	carried(bone) {
		const pq = new Q();
		bone.parent.updateWorldMatrix(true, false);
		bone.parent.matrixWorld.decompose(new V(), pq, new V());
		const name = Object.keys(this.bones).find(k => this.bones[k] === bone.parent);
		return name ? pq.multiply(inv(this.rest[name].q)) : pq;
	}

	// one arm or leg: two-bone IK from the bone's own shoulder or hip to Target, the middle joint on Pole's side, then the end bone to World.
	// Flex is the way the joint bends at rest (forward for an elbow, back for a knee)
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
		const middle = root.clone().addScaledVector(along, x).addScaledVector(side, y);
		const wrist = root.clone().addScaledVector(along, reach);
		const t1 = middle.clone().sub(root).normalize(), t2 = wrist.clone().sub(middle).normalize();
		// the upper bone: the shortest turn from where its parent carries it, then rolled so the joint bends the way it does at rest
		const rUp = this.rest[upperName], carriedUp = this.carried(upper);
		const d0 = spin(this.dirOf(upperName, lowerName), carriedUp);
		let qU = arc(d0, t1).multiply(carriedUp).multiply(rUp.q);
		const hinge = this.dirOf(upperName, lowerName).cross(flexRest).normalize();
		const hereHinge = spin(spin(hinge, inv(rUp.q)), qU);
		const need = t1.clone().cross(t2);
		const bend = Math.asin(clamp(need.length(), 0, 1));
		if (bend > 0.02) {
			const n = need.normalize();
			const h = hereHinge.clone().sub(t1.clone().multiplyScalar(hereHinge.dot(t1))).normalize();
			const phi = Math.atan2(t1.dot(h.clone().cross(n)), h.dot(n));
			qU = about(t1, phi * clamp((bend - 0.02) / 0.3, 0, 1)).multiply(qU);
		}
		this.put(upper, qU);
		// the lower bone: carried by the upper, then the shortest turn onto its direction
		const rLo = this.rest[lowerName];
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
		return { middle, wrist, reach: reach / (L1 + L2) };
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
	apply(pose) {
		const b = this.bones, rest = this.rest;
		const [hipR, hipL, shoR, shoL] = pose.roots.map(point);
		const pelvis = hipR.clone().add(hipL).multiplyScalar(0.5), chest = shoR.clone().add(shoL).multiplyScalar(0.5);
		const up = chest.clone().sub(pelvis).normalize();
		const framePelvis = leftUp(hipL.clone().sub(hipR), up);
		const frameChest = leftUp(shoL.clone().sub(shoR), up);
		const look = dir(pose.look);
		const frameHead = faceUp(look, up);

		// the pelvis: its joints land on the pose's hips
		const thighMid = rest.L_Thigh.p.clone().add(rest.R_Thigh.p).multiplyScalar(0.5);
		const hipAt = pelvis.clone().add(spin(rest.Hip.p.clone().sub(thighMid), framePelvis));
		this.put(b.Hip, framePelvis.clone().multiply(rest.Hip.q), hipAt);
		// the spine turns from the pelvis frame to the chest frame, and the neck and head on to where the face looks
		const mix = (a, c, t) => a.clone().slerp(c, t);
		this.put(b.Waist, mix(framePelvis, frameChest, 0.35).multiply(rest.Waist.q));
		this.put(b.Spine01, mix(framePelvis, frameChest, 0.7).multiply(rest.Spine01.q));
		this.put(b.Spine02, frameChest.clone().multiply(rest.Spine02.q));
		this.put(b.NeckTwist01, mix(frameChest, frameHead, 0.35).multiply(rest.NeckTwist01.q));
		this.put(b.NeckTwist02, mix(frameChest, frameHead, 0.65).multiply(rest.NeckTwist02.q));
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
				this.limb(`${side}_Upperarm`, `${side}_Forearm`, `${side}_Hand`, end, pole, flex, endQ);
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
				this.limb(`${side}_Thigh`, `${side}_Calf`, `${side}_Foot`, ankle, pole, flex, endQ);
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
			bone.quaternion.copy(r.local).multiply(about(axis, rad(angles[k - 1]) * sign));
			bone.updateMatrix();
		}
	}
}
