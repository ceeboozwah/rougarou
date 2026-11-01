// poses taken off the wall itself: the rehearsal solver (the same lookahead the AI climber uses) climbs the endless wall from the floor, and after every move the
// body the climber would show is read off the sim (climber.js climbPose) and kept as plain data. these are the real stances of real moves on the real holds
// (reaches, high steps, drop knees, stems, the lean of a roof), which the form lab then replays on the skeleton under joint limits.

import * as THREE from 'three';
import { Climber } from './climber.js';
import { solve } from './grader.js';
import { Vec3 } from './sim.js';
import { SPAN } from './wallgen.js';

const plain = (o) => JSON.parse(JSON.stringify(o));
const isVec = (o) => o && typeof o === 'object' && Object.keys(o).length === 3 && ['x', 'y', 'z'].every(k => typeof o[k] === 'number');
export function revive(o) {
	if (Array.isArray(o)) return o.map(revive);
	if (isVec(o)) return new Vec3(o.x, o.y, o.z);
	if (o && typeof o === 'object') { const out = {}; for (const k of Object.keys(o)) out[k] = revive(o[k]); return out; }
	return o;
}

// climb the first Chunks chunks (10 m each) of the wall and return the poses, with the height each was taken at. Progress(done, total) is told how far it is
export async function collectWall(wall, { chunks = 4, progress } = {}) {
	while (wall.ready < chunks + 1) { await wall.ensure((wall.ready + 1) * SPAN); await new Promise(r => setTimeout(r, 0)); }
	const climber = new Climber(new THREE.Scene());
	const poses = [];
	const top = chunks * SPAN;
	const result = await solve(wall.route, {
		maxMoves: 60 * chunks,
		finish: (sim) => sim.position.y > top,
		observe: (sim) => {
			climber.climbPose(sim, -1, 1);
			const pose = climber.climbPose(sim, -1, 1);
			poses.push({ y: +sim.position.y.toFixed(2), pose: plain(pose) });
			progress?.(Math.min(1, sim.position.y / top));
		},
	});
	return { poses, reached: result.sim?.position.y ?? 0, sent: result.sent };
}
