// chalk: the prints a chalked hand leaves on a hold, and the little job of chalking up (a hand reaches back to the bag, dips in, comes back).
//
// a print is a soft white quad lying on the hold's top, over the lip where the fingers curl, in the shape of a hand: a palm smudge and four finger streaks, grainy
// like powder, one of four variants drawn on a canvas. the more chalk on the hand, the stronger the print; a second grab of the same hold adds to the last print
// rather than laying a new one. every print is one instance of one mesh.

import * as THREE from 'three';
import { Vec3 } from './sim.js';
import { toThree, holdInfo } from './gym.js';

const three = (v) => new THREE.Vector3(...toThree(v));
const dirOf = (v) => three(v).normalize();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => t * t * (3 - 2 * t);

// four hand prints on one canvas (2 x 2): a palm and four fingers, speckled with grain
function atlas() {
	const paper = document.createElement('canvas');
	paper.width = paper.height = 512;
	const g = paper.getContext('2d');
	let seed = 7;
	const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
	const blob = (x, y, rx, ry, a, tilt = 0) => {
		g.save();
		g.translate(x, y);
		g.rotate(tilt);
		g.scale(rx, ry);
		const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
		grad.addColorStop(0, `rgba(255,255,255,${a})`);
		grad.addColorStop(0.55, `rgba(255,255,255,${a * 0.7})`);
		grad.addColorStop(1, 'rgba(255,255,255,0)');
		g.fillStyle = grad;
		g.beginPath();
		g.arc(0, 0, 1, 0, Math.PI * 2);
		g.fill();
		g.restore();
	};
	for (let v = 0; v < 4; v++) {
		const ox = (v % 2) * 256, oy = Math.floor(v / 2) * 256;
		g.save();
		g.beginPath();
		g.rect(ox, oy, 256, 256);
		g.clip();
		g.translate(ox, oy);
		// the palm, low, a little lopsided
		blob(128 + (r() - 0.5) * 14, 188 + (r() - 0.5) * 10, 56 + r() * 8, 46 + r() * 8, 0.55 + r() * 0.2, (r() - 0.5) * 0.3);
		// four fingers up from it, each a little different, and the thumb's smear to the side
		for (let f = 0; f < 4; f++) {
			const x = 78 + f * 33 + (r() - 0.5) * 8, len = 62 + r() * 24 - (f === 0 || f === 3 ? 14 : 0), y = 112 - len * 0.35;
			blob(x, y, 15 + r() * 4, len * 0.55, 0.55 + r() * 0.25, (r() - 0.5) * 0.18);
			// the tip, pressed harder
			blob(x, y - len * 0.42, 13, 11 + r() * 3, 0.5 + r() * 0.2);
		}
		blob(46 + r() * 6, 176, 22, 14, 0.35 + r() * 0.2, -0.9);
		// powder: speckle in and around, and some dark flecks taken out
		for (let i = 0; i < 260; i++) blob(40 + r() * 176, 30 + r() * 200, 1 + r() * 2.4, 1 + r() * 2.4, 0.18 + r() * 0.5);
		g.globalCompositeOperation = 'destination-out';
		for (let i = 0; i < 180; i++) {
			const x = 40 + r() * 176, y = 30 + r() * 200;
			const grad = g.createRadialGradient(x, y, 0, x, y, 1 + r() * 3.4);
			grad.addColorStop(0, `rgba(0,0,0,${0.25 + r() * 0.5})`);
			grad.addColorStop(1, 'rgba(0,0,0,0)');
			g.fillStyle = grad;
			g.fillRect(x - 5, y - 5, 10, 10);
		}
		g.restore();
	}
	const map = new THREE.CanvasTexture(paper);
	map.colorSpace = THREE.SRGBColorSpace;
	map.anisotropy = 4;
	return map;
}

export class Prints {
	constructor(scene, max = 1500) {
		this.max = max;
		this.marks = [];
		this.next = 0;
		this.byHold = new Map();
		const geometry = new THREE.PlaneGeometry(1, 1);
		this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
		this.cell = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
		geometry.setAttribute('aA', this.alpha);
		geometry.setAttribute('aCell', this.cell);
		const material = new THREE.MeshStandardMaterial({ map: atlas(), transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, alphaTest: 0.01 });
		material.onBeforeCompile = (shader) => {
			shader.vertexShader = shader.vertexShader
				.replace('#include <common>', '#include <common>\nattribute float aA;\nattribute vec2 aCell;\nvarying float vA;')
				.replace('#include <uv_vertex>', '#include <uv_vertex>\nvA = aA;\nvMapUv = vMapUv * 0.5 + aCell;');
			shader.fragmentShader = shader.fragmentShader
				.replace('#include <common>', '#include <common>\nvarying float vA;')
				.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vA;');
		};
		this.mesh = new THREE.InstancedMesh(geometry, material, max);
		this.mesh.count = 0;
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 4;
		scene.add(this.mesh);
		this.matrix = new THREE.Matrix4();
	}

	// a chalked Hand (side -1 right, 1 left) takes hold of hold Number of Route, with Chalk (0 to 1) on it. Index is the number the problem's holds were built with
	add(route, index, number, side, chalk) {
		const spot = route.holds[number];
		if (!spot || chalk < 0.04) return false;
		const info = holdInfo(route, spot, index, number);
		const key = `${route.name}:${number}:${side}`;
		const here = this.byHold.get(key) ?? [];
		const strength = clamp(0.35 + chalk * 0.6, 0.25, 0.92);
		// a hand that lands where its last print is darkens that print, and turns it a little
		const near = here.map(i => this.marks[i]).find(Boolean);
		if (near && Math.random() < 0.7) {
			near.a = clamp(near.a + strength * 0.4, 0, 0.92);
			near.rot += (Math.random() - 0.5) * 0.22;
			this.write(near.slot);
			return true;
		}
		const slot = this.next;
		this.next = (this.next + 1) % this.max;
		if (this.marks[slot]) this.forget(slot);
		// the fingers lie over the lip a little ahead of the middle of the hold; across it, the hand is about as wide as the hold lets it be
		const length = clamp(info.scale.x * 2 * 1.7, 9, 18), width = clamp(info.scale.y * 2 * 0.95, 7.5, 11.5);
		const mark = { slot, key, side, info, length, width, a: strength, rot: (Math.random() - 0.5) * 0.5, variant: Math.floor(Math.random() * 4), lift: info.scale.z * (info.shape === 'horn' ? 1.3 : info.shape === 'lip' ? 1.2 : 1.12) + 0.5, ahead: info.scale.x * 0.12 };
		this.marks[slot] = mark;
		here.push(slot);
		this.byHold.set(key, here);
		this.mesh.count = Math.max(this.mesh.count, slot + 1);
		this.write(slot);
		return true;
	}

	forget(slot) {
		const mark = this.marks[slot];
		const list = this.byHold.get(mark.key);
		if (list) { const at = list.indexOf(slot); if (at >= 0) list.splice(at, 1); }
		this.marks[slot] = null;
	}

	// put one print's matrix and look into the instance buffers
	write(slot) {
		const m = this.marks[slot];
		const { info } = m;
		const c = Math.cos(m.rot), s = Math.sin(m.rot);
		// the print turned about the hold's normal by a little
		const top = info.top.mul(c).add(info.side.mul(s)), side = info.side.mul(c).sub(info.top.mul(s));
		const at = info.at.add(info.top.mul(m.ahead)).add(info.out.mul(m.lift));
		const flip = m.side === -1 ? 1 : -1;
		const x = dirOf(side).multiplyScalar(m.width / 100 * flip), y = dirOf(top).multiplyScalar(m.length / 100), z = dirOf(info.out);
		this.matrix.makeBasis(x, y, z).setPosition(three(at));
		this.mesh.setMatrixAt(slot, this.matrix);
		this.alpha.setX(slot, m.a);
		this.cell.setXY(slot, (m.variant % 2) * 0.5, Math.floor(m.variant / 2) * 0.5);
		this.mesh.instanceMatrix.needsUpdate = true;
		this.alpha.needsUpdate = true;
		this.cell.needsUpdate = true;
	}

	clear() { this.marks.length = 0; this.byHold.clear(); this.next = 0; this.mesh.count = 0; this.mesh.instanceMatrix.needsUpdate = true; }
}

// one go at chalking up: the hand reaches back to the bag, dips into it, and comes back. Update(delta) returns the dust to puff this frame
const REACH = 0.55, DIP = 0.9, BACK = 0.55;
export const CHALK_TIME = REACH + DIP + BACK;

export class ChalkUp {
	constructor(limb, hold) {
		this.limb = limb;
		this.hold = hold;
		this.t = 0;
		this.stirred = 0;
		this.entered = false;
		this.left = false;
	}

	get done() { return this.t >= CHALK_TIME; }
	// how far back the hand is (0 where it was, 1 at the bag) and how deep in the bag it is
	get state() {
		const t = this.t;
		const reach = t < REACH ? ease(t / REACH) : t < REACH + DIP ? 1 : 1 - ease((t - REACH - DIP) / BACK);
		const dip = t > REACH * 0.8 && t < REACH + DIP ? Math.sin(Math.PI * clamp((t - REACH * 0.8) / (DIP + REACH * 0.2), 0, 1)) : 0;
		return { limb: this.limb, reach: clamp(reach, 0, 1), dip };
	}

	update(delta) {
		this.t += delta;
		const dust = [];
		if (!this.entered && this.t >= REACH) { this.entered = true; dust.push(1); }
		if (this.t >= REACH && this.t < REACH + DIP && this.t - this.stirred > 0.17) { this.stirred = this.t; dust.push(0.5); }
		if (!this.left && this.t >= REACH + DIP) { this.left = true; dust.push(1.4); }
		return dust;
	}

	// how chalked the hand is by now (it takes the chalk as it goes into the bag)
	get chalked() { return this.t > REACH + DIP * 0.45; }
}
