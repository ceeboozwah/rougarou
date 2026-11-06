// draws the endless wall again, this time with the skeleton judging every move (bodycheck.js), and keeps the result: the angle of every panel and the holds of
// every chunk, as data (web/wall-baked.json, written through the dev server). the game then builds the first chunks from that, with no solving, and every move on
// them is one a body can make within its joint ranges and out of the wall. it is slow (the solver asks the skeleton about thousands of moves a chunk), so it is a
// dev job: __rawah.bake(chunks) in the console, or the lab's button. chunks past the baked ones are still drawn on the spot, as before, without the gate.

import { Wall, makeChunk, CHUNK } from './wallgen.js';
import { Gate } from './wallgen.js';

export async function bakeWall(bodyCheck, { chunks = 6, progress, save = true } = {}) {
	const wall = new Wall();
	const out = [];
	const t0 = performance.now();
	bodyCheck.wall = true;
	bodyCheck.cache.clear();
	Gate.fn = bodyCheck.gate;
	try {
		for (let k = 0; k < chunks; k++) {
			const t = performance.now();
			const c = await makeChunk(k, wall);
			out.push(c.holds.map(h => ({ x: +h.point.x.toFixed(4), y: +h.point.y.toFixed(4), kind: h.kind, px: +h.pull.x.toFixed(4), py: +h.pull.y.toFixed(4), line: h.line ?? -1 })));
			progress?.({ chunk: k, sent: c.sent, attempts: c.attempt, seconds: (performance.now() - t) / 1000, total: (performance.now() - t0) / 1000, refused: bodyCheck.stats.refused, asked: bodyCheck.stats.asked });
			if (!c.sent) break;
			if (save) await post(wall, out);
		}
	} finally {
		Gate.fn = null;
		bodyCheck.wall = false;
	}
	return { chunks: out.length, lean: wall.lean.slice(0, CHUNK * (out.length + 1)), seconds: (performance.now() - t0) / 1000 };
}

// the angles of the panels up to and including the last baked chunk's own four (what the next chunk's first panel leans from)
async function post(wall, holds) {
	const lean = wall.lean.slice(0, CHUNK * (holds.length + 1));
	const r = await fetch('/dev/wall', { method: 'POST', body: JSON.stringify({ lean, holds }) });
	if (!r.ok) throw new Error(`the dev server did not take the wall (${r.status})`);
}
