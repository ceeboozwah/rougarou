// the menu (title screen and pause), settings, the tick list of sends, and toasts.
// settings and progress are kept in this browser's local storage, best effort.

const $ = (id) => document.getElementById(id);
const read = (key, fallback) => { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: this session only */ } };
export const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const hex = (c) => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
const gradeOf = (route) => parseInt(String(route.grade).replace(/\D/g, ''), 10) || 0;

export const Defaults = { shirt: '#e6dfcc', shorts: '#3f4a2c', shoes: '#e9b812', volume: 0.8, muted: false, look: 1, zoom: 1, quality: 'auto', gauges: true };
const Swatches = {
	shirt: ['#e6dfcc', '#f4f1ea', '#1d1d20', '#c8553d', '#2f5d8a', '#6b8f71', '#e8b4b8'],
	shorts: ['#3f4a2c', '#1d1d20', '#2b3a55', '#7a5c3e', '#8a8f96', '#a33b2b'],
	shoes: ['#e9b812', '#d93a2b', '#2a7de1', '#27b36b', '#f07c1a', '#1d1d20'],
};

export class UI {
	// Hooks: play(), resume(), go(index, pull), edit(index), apply(settings), clips(el)
	constructor(routes, hooks) {
		this.routes = routes;
		this.hooks = hooks;
		this.settings = read('rougarou-settings', Defaults);
		this.stats = read('rougarou-stats', {});
		this.tab = 'problems';
		this.open = true;
		document.body.classList.add('menu-open');
		this.started = false;
		$('tabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) this.show(t); });
		$('play').onclick = () => this.close();
		$('menu').addEventListener('pointerdown', (e) => { if (e.target === $('menu') && this.started) this.close(); });
		this.how();
		this.render();
	}

	save() { write('rougarou-settings', this.settings); write('rougarou-stats', this.stats); }

	// ------------------------------------------------------------ progress
	record(route) { return this.stats[route.name] ??= { attempts: 0, sends: 0, best: 0, flashed: false }; }
	attempt(route) { this.record(route).attempts++; this.save(); }
	// a send: returns what was special about it
	send(route, time) {
		const r = this.record(route);
		const flash = r.sends === 0 && r.attempts <= 1;
		const first = r.sends === 0;
		const best = !r.best || time < r.best;
		r.sends++;
		if (best) r.best = time;
		if (flash) r.flashed = true;
		this.save();
		return { flash, first, best: best && !first };
	}
	points() {
		let total = 0, sent = 0;
		for (const route of this.routes) {
			const r = this.stats[route.name];
			if (!r?.sends) continue;
			sent++;
			total += 100 * (gradeOf(route) + 1) + (r.flashed ? 50 : 0);
		}
		return { total, sent };
	}

	toast(text, kind = '') {
		const el = document.createElement('div');
		el.className = `toast card ${kind}`;
		el.textContent = text;
		$('toasts').append(el);
		setTimeout(() => el.remove(), 2700);
	}

	// ------------------------------------------------------------ the menu
	show(tab) {
		this.tab = tab;
		for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
		for (const s of document.querySelectorAll('[data-pane]')) s.hidden = s.dataset.pane !== tab;
		if (tab === 'clips') this.hooks.clips($('clips'));
		this.render();
	}

	toggle() { if (this.open) this.close(); else this.openMenu(); }
	openMenu(tab) {
		this.open = true;
		document.body.classList.add('menu-open');
		$('menu').classList.remove('hidden');
		if (tab) this.show(tab); else this.render();
		this.hooks.pause?.();
	}
	close() {
		if (!this.open) return;
		this.open = false;
		document.body.classList.remove('menu-open');
		$('menu').classList.add('hidden');
		if (!this.started) { this.started = true; this.hooks.play(); } else this.hooks.resume?.();
	}

	render() {
		const { total, sent } = this.points();
		$('score').innerHTML = `<b>${total} pts</b>${sent}/${this.routes.length} problems sent`;
		$('play').textContent = this.started ? 'back to the gym' : 'walk into the gym';
		$('menuNote').textContent = this.started ? '' : 'tip: walk up to a problem and grab its two start holds to pull on.';
		if (this.tab === 'problems') this.problems();
		if (this.tab === 'settings') this.form();
	}

	problems() {
		$('problems').innerHTML = this.routes.map((route, i) => {
			const r = this.stats[route.name];
			const line = r?.sends ? `sent ${r.sends}x · best ${clock(r.best)}${r.flashed ? ' · flashed' : ''}` : r?.attempts ? `${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'}, not sent yet` : 'not tried yet';
			return `<article class="problem ${r?.sends ? 'sent' : ''}" style="--tape:${hex(route.tape)}">
				<div class="head"><b>${route.name}</b>${route.edited ? '<span class="chip">your set</span>' : ''}<span class="grade">${route.grade}</span></div>
				<small>${line}</small>
				<div class="go"><button class="primary" data-pull="${i}">climb it</button><button data-walk="${i}">walk there</button><button class="ghost" data-edit="${i}">set it</button></div>
			</article>`;
		}).join('');
		for (const b of $('problems').querySelectorAll('button')) {
			b.onclick = () => {
				const i = Number(b.dataset.pull ?? b.dataset.walk ?? b.dataset.edit);
				this.started = true;
				this.open = false;
				document.body.classList.remove('menu-open');
				$('menu').classList.add('hidden');
				if (b.dataset.edit !== undefined) this.hooks.edit(i);
				else this.hooks.go(i, b.dataset.pull !== undefined);
			};
		}
	}

	form() {
		const s = this.settings;
		const touch = matchMedia('(pointer: coarse)').matches;
		const swatch = (part) => `<div class="swatches">${Swatches[part].map(c => `<button data-part="${part}" data-c="${c}" style="--c:${c}" class="${c === s[part] ? 'on' : ''}" aria-label="${c}"></button>`).join('')}
			<input type="color" data-part="${part}" value="${s[part]}" aria-label="custom ${part} color"></div>`;
		const toggle = (key, options) => `<span class="toggle">${options.map(([v, label]) => `<button data-key="${key}" data-v="${v}" class="${String(s[key]) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</span>`;
		$('settings').innerHTML = `
			<div><h3>outfit</h3><div class="outfit"><span>shirt</span>${swatch('shirt')}<span>shorts</span>${swatch('shorts')}<span>shoes</span>${swatch('shoes')}</div></div>
			<div><h3>sound</h3><div class="field"><label>volume</label><input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-range="volume">${toggle('muted', [[false, 'on'], [true, 'off']])}</div></div>
			<div><h3>camera</h3><div class="field"><label>look speed</label><input type="range" min="0.3" max="2.5" step="0.1" value="${s.look}" data-range="look"></div>
				<div class="field"><label>distance</label><input type="range" min="0.45" max="2" step="0.05" value="${s.zoom}" data-range="zoom"><small>closer · further${touch ? '' : ' (or the mouse wheel)'}</small></div></div>
			<div><h3>display</h3>
				<div class="field"><label>graphics</label>${toggle('quality', [['auto', 'auto'], ['high', 'high'], ['low', 'fast']])}</div>
				<div class="field"><label>pump and weight</label>${toggle('gauges', [[true, 'show'], [false, 'hide']])}</div></div>
			<div><h3>progress</h3><div class="field"><button class="ghost danger" id="wipe">reset my tick list</button></div></div>`;
		const el = $('settings');
		const apply = () => { this.save(); this.hooks.apply(this.settings); };
		for (const b of el.querySelectorAll('.swatches button')) b.onclick = () => { s[b.dataset.part] = b.dataset.c; apply(); this.form(); };
		for (const i of el.querySelectorAll('input[type=color]')) i.oninput = () => { s[i.dataset.part] = i.value; apply(); };
		for (const i of el.querySelectorAll('input[type=range]')) i.oninput = () => { s[i.dataset.range] = Number(i.value); apply(); };
		for (const b of el.querySelectorAll('.toggle button')) b.onclick = () => {
			const v = b.dataset.v;
			s[b.dataset.key] = v === 'true' ? true : v === 'false' ? false : v;
			apply();
			this.form();
		};
		const wipe = $('wipe');
		wipe.onclick = () => {
			if (!wipe.dataset.armed) { wipe.dataset.armed = '1'; wipe.textContent = 'really clear every send?'; return; }
			this.stats = {};
			this.save();
			this.render();
		};
	}

	how() {
		const touch = matchMedia('(pointer: coarse)').matches;
		$('how').innerHTML = touch ? `
			<div><h3>walking</h3><p>left thumb walks, right thumb looks around.</p><p>each problem has a tag with its grade. walk up and tap its two glowing start holds to pull on.</p></div>
			<div><h3>climbing</h3><p>drag a hand or foot onto a hold. drag empty wall to shift your hips.</p><p>keep your weight on your feet: arms pump out fast, legs don't.</p></div>
			<div><h3>the wall</h3><p>bare wall is friction only. a palm or a smear can be pressed, never pulled.</p><p>flag a free leg across to stop your body swinging open.</p></div>
			<div><h3>sending</h3><p>match both hands on the top hold and hold it. flash it first try for bonus points.</p><p>the red dot records a clip.</p></div>` : `
			<div><h3>walking</h3><p><span class="key">w</span><span class="key">a</span><span class="key">s</span><span class="key">d</span> walk, <span class="key">shift</span> jog. click to look around with the mouse, <span class="key">esc</span> to get the cursor back.</p><p>walk up to a problem and click its two glowing start holds, or press <span class="key">e</span>.</p></div>
			<div><h3>climbing</h3><p>click a hand or foot, move the mouse, click to place it. <span class="key">wasd</span> or drag empty wall shifts your hips.</p><p><span class="key">esc</span> puts a limb back, <span class="key">x</span> lets it hang, <span class="key">j</span> jumps down, <span class="key">r</span> retries.</p><p><span class="key">v</span> climbs in first person: look at a hold (it glows), then press <span class="key">r</span> or <span class="key">l</span> for the side and <span class="key">a</span> for the arm or <span class="key">l</span> for the leg. in first person the arrow keys latch a hip shift (press again to release, space centers) and retry is the button.</p></div>
			<div><h3>the wall</h3><p>bare wall is friction only. a palm or a smear can be pressed, never pulled, and only sticks while something presses you into the wall.</p><p>flag a free leg across to stop a barn door. keep your weight on your feet.</p></div>
			<div><h3>sending and sharing</h3><p>match both hands on the top hold and hold it. flash it first try for bonus points.</p><p><span class="key">\`</span> or the red dot records a clip. <span class="key">m</span> opens this menu.</p></div>`;
	}
}
