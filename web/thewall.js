// "The Wall": a door in the gym's east wall, a room behind it, and one wall with no top. every hold on it comes from wallgen.js, a function of the
// chunk number alone and checked climbable by the solver, so it is the same wall for everyone. this file draws it (panels and holds, a few
// chunks at a time around the climber, the rest dropped) and grows it ahead of whoever is climbing, and holds the door and its sign.

import * as THREE from 'three';
import { Vec3 } from './sim.js';
import { Sink, routeHolds, toThree, Door, Room } from './gym.js';
import { Wall, makeChunk, band, bandY, Colors, CHUNK, PANEL, SPAN } from './wallgen.js';

const V = (x, y, z) => new Vec3(x, y, z);
const three = (v) => new THREE.Vector3(...toThree(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const Key = 'rougarou-wall';


// one triangle soup as a mesh
function soup(sink, color, roughness) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(sink.positions, 3));
	geometry.setAttribute('normal', new THREE.Float32BufferAttribute(sink.normals, 3));
	const material = new THREE.MeshStandardMaterial({ roughness, metalness: 0 });
	material.color.setRGB(...color);
	const mesh = new THREE.Mesh(geometry, material);
	mesh.castShadow = mesh.receiveShadow = true;
	return mesh;
}

const mix = (a, b, c) => { let h = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(c | 0, 83492791); h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); return ((h ^ h >>> 15) >>> 0) / 4294967296; };

export class TheWall {
	constructor() {
		this.route = new Wall();
		this.route.grow(CHUNK * 3);
		// the band at the foot is there from the start, so the problem can be pulled onto before anything has been generated
		this.route.holds = band(bandY(0)).map(h => ({ ...h }));
		this.route.holds.forEach((h, i) => { h.seed = i; h.chunk = 0; });
		this.route.ownsHolds = [{ k: 0, from: 0, to: this.route.holds.length }];
		this.ready = -1;
		this.group = new THREE.Group();
		this.built = new Map();
		this.busy = false;
		this.hints = [];
		this.best = this.load();
		this.height = 0;
		this.tick = 0;
		fetch('./wall-hints.json').then(r => r.ok ? r.json() : null).then(d => { if (d?.attempts) this.hints = d.attempts; }).catch(() => {});
	}

	load() { try { return Number(JSON.parse(localStorage.getItem(Key) || '{}').best) || 0; } catch { return 0; } }
	record(meters) {
		this.height = meters;
		if (meters > this.best + 0.01) {
			this.best = meters;
			try { localStorage.setItem(Key, JSON.stringify({ best: this.best })); } catch { /* this session only */ }
		}
	}

	// how high up the wall a hip height is, in meters above the mats
	heightOf(point) { return Math.max(0, this.route.map(point, 0).z / 100 - 0.28); }

	// keep the wall built three chunks above Y (meters up the wall) and the meshes only where the climber is
	async ensure(y) {
		const goal = Math.floor(y / SPAN) + 3;
		if (this.busy || this.ready >= goal) return;
		this.busy = true;
		try {
			while (this.ready < goal) {
				const k = this.ready + 1;
				const made = await makeChunk(k, this.route, this.hints[k]);
				// chunk 0's band is already on the wall: only what is new is added
				const fresh = k === 0 ? made.holds.slice(this.route.holds.length) : made.holds;
				const from = this.route.holds.length;
				for (const h of fresh) { h.seed = this.route.holds.length; h.chunk = k; this.route.holds.push(h); }
				if (k === 0) this.route.ownsHolds[0].to = this.route.holds.length;
				else this.route.ownsHolds.push({ k, from, to: this.route.holds.length });
				this.ready = k;
				this.built.get(k)?.dispose();
				this.built.delete(k);
			}
		} finally { this.busy = false; }
	}

	// the meshes of chunk K, from the data
	build(k, fine = true) {
		const route = this.route;
		route.grow(CHUNK * (k + 2));
		const group = new THREE.Group();
		const ply = new Sink(), dark = new Sink();
		for (let i = CHUNK * k; i < CHUNK * (k + 1); i++) {
			const p = route.panels[i];
			const columns = 10, rows = 4, width = 6.4;
			const at = (u, v) => p.origin.add(p.right.mul((u - 0.5) * width * 100)).add(p.up.mul(v * PANEL * 100));
			for (let c = 0; c < columns; c++) for (let r = 0; r < rows; r++) {
				const a = at(c / columns, r / rows), b = at((c + 1) / columns, r / rows), cc = at((c + 1) / columns, (r + 1) / rows), d = at(c / columns, (r + 1) / rows);
				const first = mix(i, c, r * 2) < 0.58 ? ply : dark, second = mix(i, c, r * 2 + 1) < 0.58 ? ply : dark;
				first.add(a, b, cc, p.out);
				second.add(a, cc, d, p.out);
			}
		}
		for (const [sink, color, rough] of [[ply, [0.84, 0.68, 0.47], 0.82], [dark, [0.055, 0.055, 0.06], 0.9]]) if (sink.positions.length) group.add(soup(sink, color, rough));
		// the holds this chunk owns, drawn in the chunk's tape color
		const own = route.ownsHolds.find(o => o.k === k);
		if (own) {
			// one mesh per line: each line's holds are their own color
			const all = route.holds.slice(own.from, own.to);
			const dark = new Sink();
			for (const line of [-1, 0, 1, 2, 3, 4]) {
				const view = Object.create(route);
				view.holds = all.filter(h => (h.line ?? -1) === line);
				if (!view.holds.length) continue;
				const built = routeHolds(view, k, fine);
				group.add(soup(built.body, Colors[line], 0.5));
				dark.positions.push(...built.dark.positions);
				dark.normals.push(...built.dark.normals);
			}
			group.add(soup(dark, [0.01, 0.01, 0.01], 0.8));
		}
		group.traverse(o => { if (o.isMesh) { o.frustumCulled = true; } });
		group.fine = fine;
		group.dispose = () => { group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); this.group.remove(group); };
		this.group.add(group);
		return group;
	}

	// show the chunks around a height and drop the rest
	show(y) {
		const k = Math.floor(y / SPAN);
		// the holds are well rounded only near the climber (there are some two hundred a chunk): the rest are cheaper
		for (let c = Math.max(0, k - 2); c <= Math.min(this.ready, k + 4); c++) {
			const fine = Math.abs(c - k) <= 1, have = this.built.get(c);
			if (have && have.fine !== fine) { have.dispose(); this.built.delete(c); }
			if (!this.built.has(c)) this.built.set(c, this.build(c, fine));
		}
		for (const [c, g] of this.built) if (c < k - 3 || c > k + 5) { g.dispose(); this.built.delete(c); }
	}

	// each frame: Y is how high the climber's hips are on the wall (meters up the surface)
	update(y, now = false) {
		this.ensure(y);
		if (now || this.tick++ % 20 === 0) this.show(y);
	}
}

// ---------------------------------------------------------------- the door and its sign
export class DoorWay {
	constructor(scene, world) {
		this.world = world;
		this.open = 0;
		this.want = false;
		this.group = new THREE.Group();
		scene.add(this.group);
		const steel = new THREE.MeshStandardMaterial({ color: 0x34383d, roughness: 0.5, metalness: 0.6 });
		const w = Door.width / 100, h = Door.height / 100;
		// the frame: two jambs and a lintel, a little proud of the wall
		for (const [x, y, z, sx, sy, sz] of [[0, -w / 2 - 0.05, h / 2, 0.3, 0.1, h], [0, w / 2 + 0.05, h / 2, 0.3, 0.1, h], [0, 0, h + 0.05, 0.3, w + 0.2, 0.1]]) {
			const m = new THREE.Mesh(new THREE.BoxGeometry(sy, sz, sx), steel);
			// three's axes: x across (unreal -y), y up, z into the room (unreal x)
			m.position.set(-y, z, Door.x / 100 + x);
			this.group.add(m);
		}
		// the leaf swings on its hinge at one side of the gap, into the room
		this.hinge = new THREE.Group();
		this.hinge.position.set(-(w / 2), 0, Door.x / 100);
		const leaf = new THREE.Mesh(new THREE.BoxGeometry(w - 0.02, h - 0.03, 0.06), new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.55, metalness: 0.5 }));
		leaf.position.set(w / 2, h / 2, 0);
		leaf.castShadow = true;
		this.hinge.add(leaf);
		const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.28, 0.05), new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.3, metalness: 0.9 }));
		handle.position.set(w - 0.12, h * 0.48, -0.05);
		this.hinge.add(handle);
		const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.3, 0.1), new THREE.MeshBasicMaterial({ color: 0xf6d3bd }));
		stripe.position.set(w / 2, h * 0.8, -0.032);
		stripe.rotation.y = Math.PI;
		this.hinge.add(stripe);
		this.group.add(this.hinge);
		// the sign over it, facing the gym
		const paper = document.createElement('canvas');
		paper.width = 1024;
		paper.height = 256;
		const g = paper.getContext('2d');
		g.fillStyle = '#15151a';
		g.beginPath();
		g.roundRect(0, 0, 1024, 256, 44);
		g.fill();
		g.lineWidth = 10;
		g.strokeStyle = '#f6d3bd';
		g.beginPath();
		g.roundRect(14, 14, 996, 228, 34);
		g.stroke();
		g.fillStyle = '#f6d3bd';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.font = '900 150px ui-rounded, system-ui, sans-serif';
		g.fillText('THE WALL', 512, 120);
		g.fillStyle = 'rgba(243, 239, 230, 0.7)';
		g.font = '700 38px ui-rounded, system-ui, sans-serif';
		g.fillText('how high can you go?', 512, 214);
		const map = new THREE.CanvasTexture(paper);
		map.colorSpace = THREE.SRGBColorSpace;
		const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }));
		sign.position.set(0, h + 0.55, Door.x / 100 - 0.2);
		sign.rotation.y = Math.PI;
		this.group.add(sign);
		// a small light so the sign and the door read from across the gym
		const glow = new THREE.PointLight(0xf6d3bd, 5, 9, 1.4);
		glow.position.set(0, h + 0.4, Door.x / 100 - 1.1);
		this.group.add(glow);
		// and one inside, so the room is not black the moment the door opens
		this.inside = new THREE.PointLight(0xdfe8ff, 9, 22, 1.2);
		this.inside.position.set(0, 3, (Room.x0 + 400) / 100);
		this.group.add(this.inside);
	}

	// how near a point is to the door, on either side (unreal centimeters)
	near(p) { return Math.abs(p.x - Door.x) < 170 && Math.abs(p.y - Door.y) < 150; }
	toggle() { this.want = !this.want; }
	update(delta) {
		this.open = clamp(this.open + (this.want ? delta : -delta) / 0.9, 0, 1);
		const t = this.open * this.open * (3 - 2 * this.open);
		// it opens into the room, away from the gym
		this.hinge.rotation.y = -t * 1.75;
		this.world.doorOpen = this.open > 0.55;
	}
}
