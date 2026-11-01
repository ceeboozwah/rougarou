// node tools/wall_check.mjs [chunks]: grow the endless wall in node and say how every chunk went (the same numbers every time)
import { Wall, makeChunk, SPAN } from '../web/wallgen.js';
const n = Number(process.argv[2] ?? 12);
import { writeFileSync } from 'node:fs';
const wall = new Wall();
const attempts = [];
const t0 = Date.now();
let failed = 0, digest = 0;
const rows = [];
for (let k = 0; k < n; k++) {
	const t = Date.now();
	const c = await makeChunk(k, wall);
	if (!c.sent) failed++;
	attempts.push(c.attempt);
	for (const h of c.holds) for (const v of [h.point.x, h.point.y, h.pull.x, h.pull.y]) digest = (Math.imul(digest, 31) + Math.round(v * 1000)) | 0;
	const leans = [0, 1, 2, 3].map(i => Math.round(wall.angleOf(4 * k + i)));
	rows.push(`chunk ${String(k).padStart(3)} (${String(k * SPAN).padStart(4)} m) holds ${String(c.holds.length).padStart(2)} attempts ${c.attempt.join(',').padEnd(11)} moves ${String(c.moves).padStart(2)} ${c.sent ? 'ok ' : 'FAILED'} lean ${leans.join(' ')} ${Date.now() - t} ms`);
}
console.log(rows.join('\n'));
console.log(`digest ${digest >>> 0} (the same on every run and every machine's engine)`);
console.log(`${n} chunks, ${failed} failed, ${Date.now() - t0} ms, wall drift ${Math.round(wall.driftAt(4 * n))} cm`);

// node tools/wall_check.mjs 300 --write keeps the attempt that worked for each chunk, so the game does not have to search for it (it checks each one anyway)
if (process.argv.includes('--write') && !failed) { writeFileSync(new URL('../web/wall-hints.json', import.meta.url), JSON.stringify({ chunks: n, digest: digest >>> 0, attempts }) + '\n'); console.log('wrote web/wall-hints.json'); }
process.exit(failed ? 1 : 0);
