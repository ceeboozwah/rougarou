// the rougarou rock lounge: a steel warehouse lined with gym walls built from flat angled plywood-and-black panels,
// a massive faceted arch boulder with a cave through it, black mats, led strips and a lounge loft.
// a port of unreal/Source/Rougarou/GymActor.cpp and HoldShapes.h: keep them in step.
// layout math runs in unreal space (centimeters, x into the room, y across, z up); meshes come out in three.js meters.

import { Panel, Route, Vec2, Vec3 } from './sim.js';

// unreal's FRandomStream, so holds land where the unreal build puts them
export class Dice {
	constructor(seed) { this.seed = seed >>> 0; this.bits = new DataView(new ArrayBuffer(4)); }
	frand() {
		this.seed = (Math.imul(this.seed, 196314165) + 907633515) >>> 0;
		this.bits.setUint32(0, (0x3f800000 | (this.seed >>> 9)) >>> 0);
		return this.bits.getFloat32(0) - 1;
	}
	range(a, b) { return a + (b - a) * this.frand(); }
	int(a, b) { const n = b - a + 1; return a + (n > 0 ? Math.min(Math.trunc(this.frand() * n), n - 1) : 0); }
}

const V = (x, y, z) => new Vec3(x, y, z);
const lerp2 = (a, b, t) => new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// unreal centimeters to three.js meters; unreal is left-handed, so one axis flips
export const toThree = (v) => [-v.y / 100, v.z / 100, v.x / 100];

// a run of wall built like a real gym section: a height profile of flat angled panels extruded along the wall
const Back = V(1, 0, 0), Left = V(0, 1, 0), Right = V(0, -1, 0);
export const Sections = [
	{ problem: 'slab dance', grade: 'V2', moves: 'csjcps', top: 4.3, base: V(-60, -1500, 0), along: V(0, 1, 0), into: Back, width: 600, profile: [[0, 0], [-45, 200], [-110, 480]] },
	{ problem: 'steep street', grade: 'V4', moves: 'jcjpjo', top: 4.6, base: V(-60, -900, 0), along: V(0, 1, 0), into: Back, width: 600, profile: [[0, 0], [30, 120], [200, 380], [250, 480]] },
	{ problem: 'kicker', grade: 'V3', moves: 'cjspcj', top: 4.4, base: V(-60, -300, 0), along: V(0, 1, 0), into: Back, width: 600, profile: [[0, 0], [0, 170], [110, 430], [120, 480]] },
	{ problem: 'the roof', grade: 'V5', moves: 'jjpj', top: 3.5, base: V(-60, 300, 0), along: V(0, 1, 0), into: Back, width: 600, profile: [[0, 0], [40, 140], [230, 300], [380, 380]] },
	{ problem: 'wave', grade: 'V3', moves: 'jcsjpc', top: 4.6, base: V(-60, 900, 0), along: V(0, 1, 0), into: Back, width: 600, profile: [[0, 0], [90, 170], [40, 320], [130, 480]] },
	{ problem: null, base: V(-60, -1500, 0), along: V(1, 0, 0), into: Left, width: 510, profile: [[0, 0], [0, 260], [-40, 480]] },
	{ problem: 'lean', grade: 'V2', moves: 'jcjoj', top: 4.4, base: V(450, -1500, 0), along: V(1, 0, 0), into: Left, width: 500, profile: [[0, 0], [60, 150], [180, 480]] },
	{ problem: 'pour', grade: 'V1', moves: 'jpjcjj', top: 4.2, base: V(-60, 1500, 0), along: V(1, 0, 0), into: Right, width: 560, profile: [[0, 0], [50, 160], [200, 480]] },
	{ problem: null, base: V(500, 1500, 0), along: V(1, 0, 0), into: Right, width: 550, profile: [[0, 0], [-30, 250], [-70, 480]] },
].map(s => ({ ...s, profile: s.profile.map(([a, b]) => new Vec2(a, b)) }));

// the arch boulder: a faceted cross-section extruded along the room, a thick outer skin around a cave tunnel
export const ArchStart = 900, ArchLength = 1100, ArchCenter = 250;
export const ArchOuter = [[-560, 0], [-470, 230], [-260, 470], [180, 500], [430, 330], [560, 0]].map(([a, b]) => new Vec2(a, b));
export const ArchInner = [[-300, 0], [-270, 170], [-120, 280], [110, 290], [250, 190], [300, 0]].map(([a, b]) => new Vec2(a, b));

function archSection(u, inner) {
	const points = inner ? ArchInner : ArchOuter;
	const last = points.length - 1;
	const along = clamp(u, 0, 1) * last;
	const seg = clamp(Math.floor(along), 0, last - 1);
	return lerp2(points[seg], points[seg + 1], along - seg);
}
const archSurface = (u, v, inner) => { const p = archSection(u, inner); return V(ArchStart + ArchLength * v, ArchCenter + p.x, p.y); };
const legPanel = (u, v) => v > 0.35 && v < 0.65 && u < 0.4 + 0.001;
const cavePanel = (u, v) => v > 0.35 && v < 0.65 && u > 0.6 - 0.001;

// a stack of problem panels up a polyline of wall corners, bottom to top, facing Room
function stack(corners, across, room) {
	const out = [];
	let start = 0;
	for (let i = 0; i + 1 < corners.length; i++) {
		const p = new Panel();
		p.start = start;
		p.length = corners[i].dist(corners[i + 1]) / 100;
		p.origin = corners[i];
		p.up = corners[i + 1].sub(corners[i]).norm();
		p.right = across;
		p.out = p.right.cross(p.up);
		if (p.out.dot(room) < 0) { p.right = across.mul(-1); p.out = p.right.cross(p.up); }
		out.push(p);
		start += p.length;
	}
	return out;
}

// a problem's holds: two start jugs for the feet, two for the hands, foot chips, its moves alternating sides, a finish jug
function ladder(moves, top, seed) {
	const dice = new Dice(seed);
	const pull = new Vec2(0, -1);
	const H = (x, y, kind, p = pull) => ({ point: new Vec2(x, y), kind, pull: p });
	const holds = [H(-0.25, 0.45, 'jug'), H(0.25, 0.45, 'jug'), H(-0.35, 1.7, 'jug'), H(0.35, 1.7, 'jug'),
		H(0.05, 0.95, 'crimp'), H(-0.4, 1.2, 'crimp'), H(0.4, 1.3, 'crimp')];
	const count = moves.length;
	for (let i = 0; i < count; i++) {
		const y = 2.05 + (top - 0.33 - 2.05) * (count > 1 ? i / (count - 1) : 0);
		const x = (i % 2 === 0 ? -1 : 1) * dice.range(0.2, 0.42);
		const letter = moves[i];
		const kind = { c: 'crimp', s: 'sloper', p: 'pinch', o: 'pocket' }[letter] ?? 'jug';
		// pinches are squeezed toward the middle of the body
		holds.push(H(x, y, kind, letter === 'p' ? new Vec2(x < 0 ? 1 : -1, 0) : pull));
	}
	holds.push(H(0, top, 'jug'));
	return holds;
}

export function problems() {
	const out = [];
	let seed = 7;
	for (const s of Sections) {
		if (!s.problem) continue;
		const corners = s.profile.map(p => s.base.add(s.along.mul(s.width / 2)).add(s.into.mul(p.x)).add(V(0, 0, p.y)));
		const route = new Route(s.problem);
		route.panels = stack(corners, s.along, s.into);
		route.holds = ladder(s.moves, s.top, seed++);
		route.grade = s.grade;
		out.push(route);
	}
	const middle = ArchStart + ArchLength / 2;
	const corner = (p) => V(middle, ArchCenter + p.x, p.y);
	const leg = new Route('arch leg');
	leg.panels = stack([corner(ArchOuter[0]), corner(ArchOuter[1]), corner(ArchOuter[2])], V(1, 0, 0), V(0, -1, 0));
	leg.holds = ladder('jcjsjc', 4.9, seed++);
	leg.grade = 'V1';
	out.push(leg);
	const cave = new Route('arch cave');
	cave.panels = stack([corner(ArchInner[5]), corner(ArchInner[4]), corner(ArchInner[3])], V(1, 0, 0), V(0, -1, 0));
	cave.holds = ladder('jjjj', 2.95, seed++);
	cave.grade = 'V2';
	cave.stand = 200;
	cave.aside = 420;
	out.push(cave);
	return out;
}

export const Tapes = [[0.95, 0.62, 0.02], [0.02, 0.25, 0.8], [0.05, 0.45, 0.15], [0.8, 0.05, 0.05], [0.45, 0.12, 0.75],
	[0.95, 0.35, 0.02], [0.9, 0.3, 0.55], [0.02, 0.55, 0.6], [0.85, 0.85, 0.82], [0.35, 0.75, 0.1]];
export const tape = (i) => Tapes[i % Tapes.length];
export const Overview = V(2450, 1100, 600);
export const Focus = V(1300, 100, 170);

// ---------------------------------------------------------------- meshes

// triangles with flat normals, wound so three.js draws the side Facing points to
export class Sink {
	constructor() { this.positions = []; this.normals = []; }
	add(a, b, c, facing) {
		// unreal's lit normal of a winding is (c - a) x (b - a); mirrored into three.js the same winding faces the mirrored normal
		let n = c.sub(a).cross(b.sub(a)).norm();
		if (n.dot(facing) < 0) { const t = b; b = c; c = t; n = n.mul(-1); }
		for (const p of [a, b, c]) this.positions.push(...toThree(p));
		const m = toThree(n.mul(100));
		for (let i = 0; i < 3; i++) this.normals.push(...m);
	}
	// a triangle shaded smoothly from its corners' normals, for the rounded resin of a hold
	smooth(a, b, c, na, nb, nc, facing) {
		const n = c.sub(a).cross(b.sub(a));
		if (n.dot(facing) < 0) { [b, c] = [c, b]; [nb, nc] = [nc, nb]; }
		for (const p of [a, b, c]) this.positions.push(...toThree(p));
		for (const m of [na, nb, nc]) this.normals.push(...toThree(m.mul(100)));
	}
}

const Templates = [
	{ name: 'bucket', kind: 'jug', scale: V(0.8, 1, 0.7), noise: 0.08, shape: 'lip' },
	{ name: 'horn', kind: 'jug', scale: V(0.9, 0.6, 0.6), noise: 0.06, shape: 'horn' },
	{ name: 'star', kind: 'jug', scale: V(1.1, 1.1, 0.55), noise: 0.05, shape: 'star' },
	{ name: 'handle', kind: 'jug', scale: V(0.6, 1.2, 0.6), noise: 0.07, shape: 'lip' },
	{ name: 'edge', kind: 'crimp', scale: V(0.28, 1.2, 0.2), noise: 0.04, shape: 'blob' },
	{ name: 'smile', kind: 'crimp', scale: V(0.3, 1, 0.22), noise: 0.04, shape: 'smile' },
	{ name: 'chip', kind: 'crimp', scale: V(0.4, 0.5, 0.16), noise: 0.08, shape: 'blob' },
	{ name: 'rail', kind: 'crimp', scale: V(0.22, 1.9, 0.22), noise: 0.03, shape: 'blob' },
	{ name: 'dome', kind: 'sloper', scale: V(1.25, 1.25, 0.42), noise: 0.05, shape: 'blob' },
	{ name: 'pebble', kind: 'sloper', scale: V(0.85, 1.5, 0.38), noise: 0.1, shape: 'blob' },
	{ name: 'fin', kind: 'pinch', scale: V(1.1, 0.3, 0.55), noise: 0.05, shape: 'blob' },
	{ name: 'tufa', kind: 'pinch', scale: V(1.6, 0.38, 0.5), noise: 0.09, shape: 'horn' },
	{ name: 'pocket', kind: 'pocket', scale: V(0.9, 0.9, 0.45), noise: 0.06, shape: 'pocket' },
	{ name: 'knob', kind: 'pinch', scale: V(0.5, 0.5, 0.45), noise: 0.08, shape: 'blob' },
	{ name: 'pyramid', kind: 'volume', scale: V(1, 1, 0.6), noise: 0, shape: 'pyramid' },
	{ name: 'wedge', kind: 'volume', scale: V(1.3, 0.9, 0.5), noise: 0, shape: 'wedge' },
];

function pickTemplate(kind, seed) {
	const matches = [];
	Templates.forEach((t, i) => { if (t.kind === kind) matches.push(i); });
	return matches.length ? matches[Math.abs(seed) % matches.length] : 0;
}

const holdSize = (kind) => ({ jug: 22, crimp: 18, sloper: 28, pinch: 20, pocket: 18, volume: 55 }[kind] ?? 16);

// a subdivided icosahedron: 80 faces for the gym's scattered holds, 320 for the problems' own, smooth-shaded either way
const icosphere = (levels) => {
	const t = (1 + Math.sqrt(5)) / 2;
	const points = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(p => V(...p).norm());
	const base = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
		[3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
	const middles = new Map();
	const middle = (a, b) => {
		const key = Math.min(a, b) * 1000 + Math.max(a, b);
		if (middles.has(key)) return middles.get(key);
		points.push(points[a].add(points[b]).mul(0.5).norm());
		middles.set(key, points.length - 1);
		return points.length - 1;
	};
	let faces = base;
	for (let level = 0; level < levels; level++) {
		const next = [];
		for (const [x, y, z] of faces) {
			const ab = middle(x, y), bc = middle(y, z), ca = middle(z, x);
			next.push([x, ab, ca], [y, bc, ab], [z, ca, bc], [ab, bc, ca]);
		}
		faces = next;
	}
	return { points, faces };
};
const Icos = [icosphere(1), icosphere(2)];

// hold space onto a surface: z along the face normal, x toward Up as far as the face allows
function holdFrame(spot, normal, up) {
	const out = normal.norm();
	let top = up.sub(out.mul(up.dot(out))).norm();
	if (top.nearZero()) top = V(1, 0, 0).sub(out.mul(out.x)).norm();
	const side = out.cross(top);
	return {
		point: (l) => spot.add(top.mul(l.x)).add(side.mul(l.y)).add(out.mul(l.z)),
		vector: (l) => top.mul(l.x).add(side.mul(l.y)).add(out.mul(l.z)),
	};
}

// bake one hold into the sinks. Size is the nominal size in centimeters
function buildHold(index, size, where, seed, body, dark, fine = false) {
	const Ico = Icos[fine ? 1 : 0];
	const hold = Templates[index];
	const scale = hold.scale.mul(size / 2);
	const dice = new Dice(seed);
	const place = (l) => where.point(V(l.x * 1, l.y, l.z));
	const out = where.vector(V(0, 0, 1));
	if (hold.shape === 'pyramid' || hold.shape === 'wedge') {
		const apex = place(V(0, 0, scale.z * 2));
		let base = [];
		if (hold.shape === 'pyramid')
			for (let c = 0; c < 3; c++) {
				const turn = 2 * Math.PI * c / 3 + dice.range(-0.2, 0.2);
				base.push(place(V(Math.cos(turn) * scale.x * 2, Math.sin(turn) * scale.y * 2, 0)));
			}
		else base = [place(V(-scale.x * 2, -scale.y * 2, 0)), place(V(scale.x * 2, -scale.y * 2, 0)), place(V(scale.x * 2, scale.y * 2, 0)), place(V(-scale.x * 2, scale.y * 2, 0))];
		const center = place(V(0, 0, scale.z * 0.5));
		if (hold.shape === 'pyramid')
			for (let c = 0; c < 3; c++) body.add(base[c], base[(c + 1) % 3], apex, base[c].add(base[(c + 1) % 3]).add(apex).mul(1 / 3).sub(center));
		else {
			const low = place(V(-scale.x * 2, 0, scale.z * 0.6)), high = place(V(scale.x * 2, 0, scale.z * 2));
			const y = where.vector(V(0, 1, 0)), x = where.vector(V(1, 0, 0));
			body.add(base[0], base[1], high, out.sub(y));
			body.add(base[0], high, low, out.sub(y));
			body.add(base[3], base[2], high, out.add(y));
			body.add(base[3], high, low, out.add(y));
			body.add(base[1], base[2], high, x);
			body.add(base[0], base[3], low, x.mul(-1));
		}
		return;
	}
	const points = Ico.points.map((p) => {
		// the front half of a sphere, flattened against the wall, sculpted, then roughed up
		let l = V(p.x, p.y, Math.max(p.z, 0));
		const theta = Math.atan2(l.y, l.x);
		switch (hold.shape) {
			case 'lip': l.z += 0.45 * Math.max(l.x, 0) * l.z; l.x -= 0.2 * l.z * l.z; break;
			case 'horn': l.z *= 1 + 0.6 * Math.max(l.x, 0); l.x *= 1 + 0.25 * Math.max(l.x, 0); break;
			case 'smile': l.x += 0.35 * l.y * l.y; break;
			case 'star': { const k = 1 + 0.3 * Math.cos(3 * theta); l = V(l.x * k, l.y * k, l.z); break; }
			case 'pocket': l.z *= 1 - 0.5 * Math.exp(-(l.x * l.x + l.y * l.y) * 6); break;
		}
		l = l.add(V(dice.range(-1, 1), dice.range(-1, 1), dice.range(0, 1)).mul(hold.noise));
		return place(V(l.x * scale.x, l.y * scale.y, l.z * scale.z));
	});
	const center = place(V(0, 0, scale.z * 0.3));
	const kept = Ico.faces.filter(([a, b, c]) => !(Ico.points[a].z < 0 && Ico.points[b].z < 0 && Ico.points[c].z < 0));
	// corner normals averaged from the faces around them, each face turned to point away from the hold's middle
	const normals = points.map(() => V(0, 0, 0));
	for (const [a, b, c] of kept) {
		let n = points[c].sub(points[a]).cross(points[b].sub(points[a]));
		if (n.dot(points[a].add(points[b]).add(points[c]).mul(1 / 3).sub(center)) < 0) n = n.mul(-1);
		for (const i of [a, b, c]) normals[i] = normals[i].add(n);
	}
	for (const [a, b, c] of kept) {
		const mid = points[a].add(points[b]).add(points[c]).mul(1 / 3);
		body.smooth(points[a], points[b], points[c], normals[a].norm(), normals[b].norm(), normals[c].norm(), mid.sub(center));
	}
	// the bolt: a dark washer sunk in the top of the hold
	const top = place(V(0, 0, scale.z * (1 + hold.noise * 0.5) + 0.2));
	for (let s = 0; s < 8; s++) {
		const a0 = 2 * Math.PI * s / 8, a1 = 2 * Math.PI * (s + 1) / 8;
		dark.add(top, place(V(Math.cos(a0) * 1.3, Math.sin(a0) * 1.3, scale.z * (1 + hold.noise * 0.5) + 0.2)), place(V(Math.cos(a1) * 1.3, Math.sin(a1) * 1.3, scale.z * (1 + hold.noise * 0.5) + 0.2)), out);
	}
	if (hold.shape === 'pocket') {
		const bottom = place(V(0, 0, scale.z * 0.2));
		for (let s = 0; s < 8; s++) {
			const a0 = 2 * Math.PI * s / 8, a1 = 2 * Math.PI * (s + 1) / 8;
			const p0 = place(V(Math.cos(a0) * scale.x * 0.38, Math.sin(a0) * scale.y * 0.38, scale.z * 0.62));
			const p1 = place(V(Math.cos(a1) * scale.x * 0.38, Math.sin(a1) * scale.y * 0.38, scale.z * 0.62));
			dark.add(p0, p1, bottom, out);
		}
	}
}

// builds every mesh of the gym as flat-shaded triangle soups and box lists; the page turns them into three.js meshes
export function buildGym(routes) {
	const dice = new Dice(1991);
	const boards = [new Sink(), new Sink()];
	const palette = [];
	const paint = [];
	const shadow = new Sink();
	const blocks = [];
	const lights = [];
	const swatch = (color) => {
		const key = color.join(',');
		let i = palette.findIndex(c => c.join(',') === key);
		if (i < 0) { palette.push(color); paint.push(new Sink()); i = palette.length - 1; }
		return i;
	};
	const block = (center, size, color, shadows = true) => blocks.push({ center, size, color, shadows });
	// the t-nut grid: a bolt hole every 20 centimeters across every climbable face, on a lattice shared by coplanar facets
	const holes = [];
	const drill = (a, b, c, normal) => {
		let u = V(0, 0, 1).cross(normal);
		if (u.len() < 0.2) u = V(1, 0, 0).cross(normal);
		u = u.norm();
		const v = normal.cross(u).norm();
		const st = [a, b, c].map(p => [p.dot(u), p.dot(v)]);
		const lift = normal.mul(a.dot(normal) + 0.25);
		const area = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
		const whole = area(...st);
		if (Math.abs(whole) < 1) return;
		const lo = [Math.min(...st.map(x => x[0])), Math.min(...st.map(x => x[1]))], hi = [Math.max(...st.map(x => x[0])), Math.max(...st.map(x => x[1]))];
		for (let x = Math.ceil(lo[0] / 20) * 20; x < hi[0]; x += 20)
			for (let y = Math.ceil(lo[1] / 20) * 20; y < hi[1]; y += 20) {
				const p = [x, y];
				const w0 = area(st[1], st[2], p) / whole, w1 = area(st[2], st[0], p) / whole, w2 = 1 - w0 - w1;
				if (w0 < 0.02 || w1 < 0.02 || w2 < 0.02) continue;
				holes.push({ at: lift.add(u.mul(x)).add(v.mul(y)), normal });
			}
	};

	// where every scattered hold sits and how big it is, so a setter can keep new holds off them
	const placed = [];
	const decor = [[0.75, 0.03, 0.03], [0.95, 0.62, 0.02], [0.02, 0.18, 0.75], [0.04, 0.36, 0.14], [0.32, 0.1, 0.55], [0.22, 0.24, 0.27], [0.9, 0.3, 0.03], [0.75, 0.75, 0.72]];
	const sprinkle = (a, b, c, normal, crowd) => {
		const count = Math.floor(crowd + dice.frand());
		for (let i = 0; i < count; i++) {
			let s = dice.frand(), t = dice.frand();
			if (s + t > 1) { s = 1 - s; t = 1 - t; }
			let index = dice.int(0, Templates.length - 1);
			if (Templates[index].kind === 'volume') index = 0;
			// most holds face up the wall, some are turned for sidepulls and underclings
			const angle = dice.frand() < 0.7 ? dice.range(-35, 35) : dice.range(0, 360);
			const up = rotateAround(V(0, 0, 1), normal, angle);
			const size = holdSize(Templates[index].kind) * (dice.frand() < 0.07 ? dice.range(1.6, 2.3) : dice.range(0.8, 1.2));
			const color = swatch(decor[dice.int(0, decor.length - 1)]);
			const at = a.add(b.sub(a).mul(s)).add(c.sub(a).mul(t));
			placed.push({ at, size });
			buildHold(index, size, holdFrame(at, normal, up), dice.int(0, 1 << 20), paint[color], shadow);
		}
		if (dice.frand() < 0.035 * crowd) {
			const black = dice.frand() < 0.6;
			const up = rotateAround(V(0, 0, 1), normal, dice.range(0, 360));
			const color = swatch(black ? [0.02, 0.02, 0.025] : [0.2, 0.21, 0.23]);
			// the dice are rolled in the same order as before so the gym looks the same
			const template = pickTemplate('volume', dice.int(0, 9)), big = dice.range(45, 75);
			placed.push({ at: a.add(b).add(c).mul(1 / 3), size: big });
			buildHold(template, big, holdFrame(a.add(b).add(c).mul(1 / 3), normal, up), dice.int(0, 1 << 20), paint[color], shadow);
		}
	};

	const facets = (surface, columns, rows, bump, darkness, crowd, flat, show) => {
		// a grid over the surface split into triangles, each plywood or black: the faceted panel look
		const points = [];
		for (let row = 0; row <= rows; row++)
			for (let col = 0; col <= columns; col++) {
				const u = col / columns, v = row / rows;
				const p = surface(u, v);
				const across = surface(Math.min(u + 0.01, 1), v).sub(surface(Math.max(u - 0.01, 0), v));
				const up = surface(u, Math.min(v + 0.01, 1)).sub(surface(u, Math.max(v - 0.01, 0)));
				const edge = col === 0 || col === columns || row === 0 || row === rows || flat(u, v);
				points.push(p.add(across.cross(up).norm().mul(edge ? 0 : dice.range(-bump, bump))));
			}
		const at = (c, r) => points[r * (columns + 1) + c];
		for (let row = 0; row < rows; row++)
			for (let col = 0; col < columns; col++) {
				const A = at(col, row), B = at(col + 1, row), C = at(col + 1, row + 1), D = at(col, row + 1);
				const flip = (row + col) % 2 === 0;
				const clear = flat((col + 0.5) / columns, (row + 0.5) / rows);
				for (const tri of [[A, B, flip ? C : D], [flip ? A : B, C, D]]) {
					const normal = tri[1].sub(tri[0]).cross(tri[2].sub(tri[0])).norm();
					const board = boards[dice.frand() < darkness ? 1 : 0];
					board.add(tri[0], tri[1], tri[2], normal);
					board.add(tri[0], tri[1], tri[2], normal.mul(-1));
					const middle = tri[0].add(tri[1]).add(tri[2]).mul(1 / 3);
					for (const side of [normal, normal.mul(-1)]) {
						if (!show(middle, side)) continue;
						drill(tri[0], tri[1], tri[2], side);
						if (!clear) sprinkle(tri[0], tri[1], tri[2], side, crowd);
					}
				}
			}
	};

	// ---- shell: mats, slab, the steel building, led strips
	const steel = [0.04, 0.04, 0.045];
	for (let x = 100; x < 2450; x += 200)
		for (let y = -1450; y < 1500; y += 100) block(V(x, y, 14), V(196, 97, 28), [0.03, 0.03, 0.035]);
	// a row of narrow pads tight against the back wall, so nobody lands on bare concrete
	for (let y = -1450; y < 1500; y += 100) block(V(-29, y, 14), V(58, 97, 28), [0.03, 0.03, 0.035]);
	block(V(1150, 0, -5), V(2950, 3400, 10), [0.25, 0.25, 0.25], false);
	const siding = [0.6, 0.6, 0.58];
	block(V(-300, 0, 450), V(20, 3500, 900), siding, false);
	block(V(1150, -1650, 450), V(2900, 20, 900), siding, false);
	block(V(1150, 1650, 450), V(2900, 20, 900), siding, false);
	block(V(2560, 0, 450), V(20, 3300, 900), siding, false);
	block(V(1150, 0, 915), V(2950, 3400, 20), [0.72, 0.66, 0.55], false);
	for (let x = -200; x <= 2400; x += 520) block(V(x, 0, 870), V(30, 3300, 60), steel, false);
	for (let y = -1200; y <= 1200; y += 600) block(V(1150, y, 896), V(2900, 14, 14), steel, false);
	for (let x = 300; x <= 2100; x += 600)
		for (let y = -900; y <= 900; y += 600) block(V(x, y, 852), V(240, 14, 5), [1, 1, 1], false);

	// ---- walls: each section faceted along its fold lines, then returns closing every gap
	for (const s of Sections) {
		const folds = s.profile.length - 1;
		const rowsPer = [];
		let total = 0;
		for (let f = 0; f < folds; f++) { rowsPer.push(Math.max(1, Math.round(s.profile[f].dist(s.profile[f + 1]) / 120))); total += rowsPer[f]; }
		const height = (row) => {
			for (let f = 0; f < folds; f++) {
				if (row <= rowsPer[f] || f === folds - 1) return lerp2(s.profile[f], s.profile[f + 1], clamp(row / rowsPer[f], 0, 1));
				row -= rowsPer[f];
			}
			return s.profile[folds];
		};
		const surface = (u, v) => { const p = height(v * total); return s.base.add(s.along.mul(s.width * u)).add(s.into.mul(p.x)).add(V(0, 0, p.y)); };
		const taped = !!s.problem;
		facets(surface, Math.max(3, Math.round(s.width / 130)), total, 16, 0.35, 1.6,
			(u) => taped && Math.abs(u - 0.5) * s.width < 95, (_, n) => n.dot(s.into) > 0.1);
	}
	const resample = (profile, t) => {
		let length = 0;
		for (let i = 0; i + 1 < profile.length; i++) length += profile[i].dist(profile[i + 1]);
		let goal = t * length;
		for (let i = 0; i + 1 < profile.length; i++) {
			const piece = profile[i].dist(profile[i + 1]);
			if (goal <= piece || i + 2 === profile.length) return lerp2(profile[i], profile[i + 1], clamp(goal / Math.max(piece, 1), 0, 1));
			goal -= piece;
		}
		return profile[profile.length - 1];
	};
	const ret = (base, into, one, two, along) => {
		const steps = 16;
		const place = (profile, t) => { const p = resample(profile, t); return base.add(into.mul(p.x)).add(V(0, 0, p.y)); };
		for (let i = 0; i < steps; i++) {
			const t0 = i / steps, t1 = (i + 1) / steps;
			const A = place(one, t0), B = place(one, t1), C = place(two, t1), D = place(two, t0);
			for (const side of [along, along.mul(-1)]) { boards[0].add(A, B, C, side); boards[0].add(A, C, D, side); }
		}
	};
	const same = (a, b) => a.dist(b) < 1e-3;
	Sections.forEach((s, i) => {
		const plain = [new Vec2(0, 0), new Vec2(0, s.profile[s.profile.length - 1].y)];
		const prev = Sections[i - 1], next = Sections[i + 1];
		const first = !prev || !same(prev.along, s.along) || !same(prev.into, s.into);
		const last = !next || !same(next.along, s.along) || !same(next.into, s.into);
		if (first) ret(s.base, s.into, s.profile, plain, s.along);
		ret(s.base.add(s.along.mul(s.width)), s.into, s.profile, last ? plain : next.profile, s.along);
	});

	// ---- the arch: thick faceted outer skin, a cave tunnel through it, faceted end faces between the two
	const columns = 15, rows = 10;
	const centerOf = (p) => V(p.x, ArchCenter, 150);
	facets((u, v) => archSurface(u, v, false), columns, rows, 30, 0.4, 1.3, legPanel, (p, n) => n.dot(p.sub(centerOf(p))) > 0);
	facets((u, v) => archSurface(u, v, true), columns, rows, 22, 0.45, 1.6, cavePanel, (p, n) => n.dot(p.sub(centerOf(p))) < 0);
	for (const v of [0, 1]) {
		const x = ArchStart + ArchLength * v;
		const face = V(v === 0 ? -1 : 1, 0, 0);
		facets((u, t) => { const p = lerp2(archSection(u, true), archSection(u, false), t); return V(x, ArchCenter + p.x, p.y); },
			columns, 3, 18, 0.4, 1.4, () => false, (_, n) => n.dot(face) > 0.1);
	}
	for (const v of [0.25, 0.75]) lights.push({ at: V(ArchStart + ArchLength * v, ArchCenter, 150), color: [1, 1, 1], intensity: 6, range: 9 });

	// ---- the lounge loft and the garage door
	const wood = [0.62, 0.42, 0.24], darkWood = [0.11, 0.09, 0.07];
	block(V(1600, 1515, 170), V(1000, 12, 340), wood);
	block(V(1300, 1507, 105), V(95, 6, 210), [0.85, 0.85, 0.84]);
	block(V(1600, 1515, 560), V(1000, 12, 420), darkWood);
	block(V(1600, 1340, 345), V(1000, 360, 30), steel);
	block(V(1600, 1340, 700), V(1000, 360, 14), wood, false);
	for (let x = 1350; x <= 1850; x += 250) { block(V(x, 1506, 560), V(165, 5, 98), [0.01, 0.01, 0.01]); block(V(x, 1502, 560), V(150, 4, 85), [0.08, 0.4, 0.12]); }
	for (let x = 1100; x <= 2100; x += 50) block(V(x, 1162, 405), V(4, 4, 90), steel);
	block(V(1600, 1162, 452), V(1000, 6, 6), steel);
	block(V(1600, 1162, 400), V(1000, 4, 4), steel);
	block(V(1100, 1162, 165), V(25, 25, 330), steel);
	block(V(2100, 1162, 165), V(25, 25, 330), steel);
	for (const x of [1180, 2020]) { block(V(x, 1450, 385), V(40, 40, 50), darkWood); block(V(x, 1450, 455), V(60, 60, 80), [0.05, 0.25, 0.06]); }
	for (let x = 1450; x <= 1950; x += 125) block(V(x, 1400, 55), V(60, 60, 50), [0.5, 0.38, 0.26]);
	lights.push({ at: V(1600, 1340, 680), color: [1, 0.75, 0.45], intensity: 4, range: 8 });
	block(V(1350, -1545, 230), V(700, 8, 460), [0.78, 0.86, 0.92], false);
	for (let z = 0; z <= 460; z += 76) block(V(1350, -1538, z), V(700, 6, 6), [0.8, 0.8, 0.8], false);
	for (let x = 1000; x <= 1700; x += 100) block(V(x, -1538, 230), V(6, 6, 460), [0.8, 0.8, 0.8], false);
	lights.push({ at: V(1350, -1350, 260), color: [0.8, 0.9, 1], intensity: 4, range: 12 });

	return { boards, palette, paint, shadow, blocks, lights, holes, decorHolds: placed };
}

// one problem's holds in its tape color, turned so each lip faces away from the way it is pulled. built apart from the gym
// so the route editor can rebuild a problem after moving its holds. a hold's Seed keeps its shape when holds are added or removed
export function routeHolds(problem, index) {
	const body = new Sink(), dark = new Sink();
	problem.holds.forEach((spot, h) => {
		// a hold the setter has taken off the wall and is carrying is not on it
		if (spot.carried) return;
		const face = problem.at(spot.point.y);
		const up = face.right.mul(-spot.pull.x).add(face.up.mul(-spot.pull.y));
		const seed = spot.seed ?? h;
		buildHold(pickTemplate(spot.kind, index * 31 + seed), holdSize(spot.kind), holdFrame(problem.map(spot.point), face.out, up), index * 977 + seed, body, dark, true);
	});
	return { body, dark, color: tape(index) };
}

// unreal's RotateAngleAxis: Vector turned Degrees about Axis
function rotateAround(v, axis, degrees) {
	const a = axis.norm();
	const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
	return v.mul(c).add(a.cross(v).mul(s)).add(a.mul(a.dot(v) * (1 - c)));
}
