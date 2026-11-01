// a chalk bag on a belt: a nylon strap around the waist, the bag hung from it at the small of the back, on top of the butt, with a drawstring collar and white chalk
// showing in its mouth. it swings a little with the body (a damped pendulum driven by the hips' acceleration and by gravity as the body tilts).
// the hand that chalks up goes to Bag: how far behind the middle of the hips and how far above them the mouth of the bag is, in centimeters (climber.js uses it too).

import * as THREE from 'three';

const V = THREE.Vector3, Q = THREE.Quaternion;
export const Bag = { back: 18.7, up: 10 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class ChalkBag {
	constructor() {
		// everything is in the frame of the hips: x to the left, y up, z to the front, in meters
		this.group = new THREE.Group();
		this.nylon = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.85, side: THREE.DoubleSide });
		this.fabric = new THREE.MeshStandardMaterial({ color: 0xe9b812, roughness: 0.92, side: THREE.DoubleSide });
		const metal = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.3, metalness: 0.9 });
		const waistY = 0.12;
		// the belt: a flat band around the waist
		const belt = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.04, 48, 1, true), this.nylon);
		belt.scale.set(0.175, 1, 0.125);
		belt.position.y = waistY;
		belt.castShadow = true;
		this.group.add(belt);
		const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.042, 0.012), metal);
		buckle.position.set(0, waistY, 0.127);
		this.group.add(buckle);
		// the bag hangs from a loop on the belt at the back
		this.pivot = new THREE.Group();
		this.pivot.position.set(0, waistY - 0.005, -0.127);
		this.group.add(this.pivot);
		const loop = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.008), this.nylon);
		loop.position.set(0, 0.005, 0.0);
		this.pivot.add(loop);
		// the bag: a bucket, wider at the foot and gathered at the mouth, open at the top
		const profile = [[0, -0.178], [0.03, -0.176], [0.052, -0.165], [0.066, -0.14], [0.073, -0.1], [0.074, -0.06], [0.07, -0.025], [0.062, -0.003], [0.058, 0]].map(([r, y]) => new THREE.Vector2(r, y));
		const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), this.fabric);
		body.position.set(0, 0, -0.06);
		body.castShadow = true;
		this.pivot.add(body);
		// the drawstring collar and its toggle
		const collar = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.0065, 8, 28), this.nylon);
		collar.rotation.x = Math.PI / 2;
		collar.position.set(0, -0.014, -0.06);
		this.pivot.add(collar);
		const toggle = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.022, 8), metal);
		toggle.position.set(0.045, -0.03, -0.1);
		this.pivot.add(toggle);
		// the chalk inside, a little below the rim
		this.powder = new THREE.Mesh(new THREE.CircleGeometry(0.053, 24), new THREE.MeshStandardMaterial({ color: 0xf1f0ec, roughness: 1 }));
		this.powder.rotation.x = -Math.PI / 2;
		this.powder.position.set(0, -0.026, -0.06);
		this.pivot.add(this.powder);
		this.angles = new V(0, 0, 0);
		this.rates = new V(0, 0, 0);
		this.last = null;
		this.speed = new V();
		this.mouthAt = new V();
	}

	tint(color) { if (color) this.fabric.color.set(color); }

	// follow the hips: Hips the point between the hip joints and Frame their rotation (x left, y up, z front), Delta the time since the last frame
	update(hips, frame, delta) {
		this.group.position.copy(hips);
		this.group.quaternion.copy(frame);
		if (delta > 0 && delta < 0.2) {
			const speed = this.last ? hips.clone().sub(this.last).multiplyScalar(1 / delta) : new V();
			const accel = speed.clone().sub(this.speed).multiplyScalar(1 / delta);
			this.speed.copy(speed);
			// where the bag would hang if it were still: along gravity as the hips see it, pushed back by being accelerated
			const inv = frame.clone().invert();
			const g = new V(0, -1, 0).applyQuaternion(inv);
			const a = accel.clone().applyQuaternion(inv);
			const hang = new V().copy(g).multiplyScalar(0.8).add(new V(0, -0.2, 0)).addScaledVector(a, -0.04);
			hang.y = Math.min(hang.y, -0.2);
			hang.normalize();
			// tilts about x (the bottom swings back) and about z (to the side)
			const target = new V(clamp(Math.asin(clamp(-hang.z, -1, 1)), -0.6, 0.6), 0, clamp(Math.asin(clamp(hang.x, -1, 1)), -0.6, 0.6));
			const w = 15, k = 0.28;
			for (const axis of ['x', 'z']) {
				const accelA = -w * w * (this.angles[axis] - target[axis]) - 2 * k * w * this.rates[axis];
				this.rates[axis] += accelA * delta;
				this.angles[axis] += this.rates[axis] * delta;
			}
		}
		this.last = hips.clone();
		this.pivot.rotation.set(this.angles.x, 0, this.angles.z);
		this.group.updateMatrixWorld(true);
	}

	// the middle of the bag's mouth in the world, for the hand to go to and the chalk to rise from
	mouth() { return this.pivot.localToWorld(this.mouthAt.set(0, -0.015, -0.06)); }
}
