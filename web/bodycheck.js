// the skeleton as the judge of a move: before a hand or foot is put on a hold (by the player, by Tuck's rehearsals, or by the route setter), the move is played
// out on a copy of the sim until the limb has arrived, the body that would show is posed on a private skeleton under the anatomical ranges, and the move is
// refused if a joint cannot get the limb there (it would be left more than 4 cm off its hold) or a knee, elbow, thigh, trunk or head would be in the wall or a hold.
// the sim itself stays a plain 2D model, and the wall's own generator (which runs in node, with no skeleton) does not use this.
// (wallgen.js has a Gate it could be given, but chunk after chunk of the wall cannot be drawn under it in a reasonable time, so it is left empty.)

import * as THREE from 'three';
import { Figure } from './figure.js';
import { Climber } from './climber.js';
import { humanDefaults } from './limits.js';

const Names = ['right foot', 'left foot', 'right hand', 'left hand'];

export class BodyCheck {
	constructor() {
		this.figure = null;
		this.climber = new Climber(new THREE.Scene());
		this.cache = new Map();
		this.stats = { asked: 0, refused: 0, cached: 0, ms: 0 };
		this.miss = 0.04;
		this.clip = 0.02;
		this.on = true;
		// a bound function so it can be handed to a Sim as its gate
		this.gate = (sim, limb, hold) => this.judge(sim, limb, hold);
	}

	async load(url = './assets/character/climber.glb') {
		this.figure = await Figure.load(url, { limits: false });
		this.figure.limits = humanDefaults();
		this.figure.openSearch = true;
	}

	// null when the move can be made, or why not
	judge(sim, limb, hold) {
		if (!this.figure || !this.on) return null;
		// the endless wall was drawn and checked without a skeleton: a quarter of the foot moves its solver relies on need more hip than a person has, so on it the
		// joints still obey their ranges but the move is not refused (the gym's nine problems all still send with the gate on)
		if (sim.routes[sim.route].endless) return null;
		const key = `${sim.route}|${sim.grips.join(',')}|${sim.smeared.map(Number).join('')}|${limb}:${hold}|${Math.round(sim.position.x * 25)},${Math.round(sim.position.y * 25)}`;
		if (this.cache.has(key)) { this.stats.cached++; return this.cache.get(key); }
		const t0 = performance.now();
		this.stats.asked++;
		const c = sim.clone();
		c.gate = null;
		let why = null;
		if (c.grab(limb, hold)) {
			for (let f = 0; f < 100 && !c.fallen; f++) c.step(1 / 60);
			if (!c.fallen) {
				this.climber.climbPose(c, -1, 1);
				const pose = this.climber.climbPose(c, -1, 1);
				const fig = this.figure;
				fig.applyPose(pose, 0);
				const clip = fig.clipNow();
				if (this.log) this.log.push({ limb, miss: fig.misses[limb], clip: clip.worst, worstMiss: Math.max(...fig.misses), open: fig.openNow.toArray(), by: { ...fig.clipBy } });
				if (fig.misses[limb] > this.miss) why = 'your joints will not let you get there';
				else if (clip.worst > this.clip) why = 'your body would hit the wall or a hold';
			}
		}
		if (why) this.stats.refused++;
		this.stats.ms += performance.now() - t0;
		if (this.cache.size > 4000) this.cache.clear();
		this.cache.set(key, why);
		return why;
	}
}
