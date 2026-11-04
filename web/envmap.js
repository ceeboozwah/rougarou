// what the gym looks like from the middle of it, for reflections: a dark room with rows of bright ceiling strips, a warm window high on one wall, the pale
// plywood and the dark mat. it is drawn once, filtered by the PMREM generator, and every standard material (the resin holds above all, the skin, the mats)
// takes its specular light and some of its ambient light from it, so a hold shows the long strip lights as soft white streaks the way a glossy resin does.

import * as THREE from 'three';

export function gymEnvironment(renderer) {
	const room = new THREE.Scene();
	const hall = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 40), new THREE.MeshBasicMaterial({ color: 0x2b2824, side: THREE.BackSide }));
	hall.position.y = 6;
	room.add(hall);
	// the floor mat and the pale plywood wall in front of a viewer on the floor
	const mat = new THREE.Mesh(new THREE.PlaneGeometry(30, 40), new THREE.MeshBasicMaterial({ color: 0x14141a }));
	mat.rotation.x = -Math.PI / 2;
	mat.position.y = 0.01;
	room.add(mat);
	const ply = new THREE.Mesh(new THREE.PlaneGeometry(26, 9), new THREE.MeshBasicMaterial({ color: 0x8a7556 }));
	ply.position.set(0, 4.6, -19.9);
	room.add(ply);
	// ceiling strips: long, bright, in two rows down the hall
	const strip = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.96, 0.9).multiplyScalar(16) });
	for (const x of [-6, 6]) for (let z = -14; z <= 14; z += 7) {
		const s = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 4.5), strip);
		s.rotation.x = Math.PI / 2;
		s.position.set(x, 11.9, z);
		room.add(s);
	}
	// a window of warm daylight high on the side wall
	const window = new THREE.Mesh(new THREE.PlaneGeometry(10, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.85, 0.65).multiplyScalar(5) }));
	window.rotation.y = -Math.PI / 2;
	window.position.set(14.9, 8, 4);
	room.add(window);
	const pmrem = new THREE.PMREMGenerator(renderer);
	const target = pmrem.fromScene(room, 0.03);
	pmrem.dispose();
	room.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
	return target.texture;
}
