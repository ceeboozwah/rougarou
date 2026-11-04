// the surface of a climbing hold: a polyurethane resin with a fine sandy grain, from the indoor hold PBR set (assets/holds, repacked by hand from
// Indoor_Climbing_Hold_PBR_Textures.zip: the albedo is made neutral grey with the pack's ambient occlusion baked in so the hold's own color can be laid
// over it, hold_nr.webp holds the tangent normal in R and G and the roughness in B). the holds have no uv coordinates, so the texture is projected from
// three sides on the hold's own position (triplanar), 20 cm to a tile and mirrored at the edges so no seam shows, and the normal map is blended with the
// whiteout method. every hold of every color shares one shader program: the color is the material's own.

import * as THREE from 'three';

const TILE = 0.2;
const uniforms = { uHoldAlb: { value: null }, uHoldNr: { value: null }, uHoldOn: { value: 0 } };
let loading = null;

// load the maps once; the holds drawn before they arrive turn textured when they do (the uniforms are shared)
export function loadHoldTextures(base = './assets/holds/') {
	loading ??= (async () => {
		const loader = new THREE.TextureLoader();
		const get = async (file, srgb) => {
			const t = await loader.loadAsync(base + file);
			t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
			t.anisotropy = 8;
			t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
			return t;
		};
		try {
			[uniforms.uHoldAlb.value, uniforms.uHoldNr.value] = await Promise.all([get('hold_albedo.jpg', true), get('hold_nr.webp', false)]);
			uniforms.uHoldOn.value = 1;
		} catch { uniforms.uHoldOn.value = 0; }
	})();
	return loading;
}

// a hold's material in the color (r, g, b in 0..1) and roughness
export function holdMaterial(color, roughness = 0.55) {
	// polyurethane resin: a grainy satin body under a thin lacquer-like layer that picks up the room's lights as soft streaks
	const material = new THREE.MeshPhysicalMaterial({ roughness, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.42, ior: 1.5, specularIntensity: 0.9 });
	material.color.setRGB(...color);
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute vec4 aHole;\nattribute vec3 aAxis;\nvarying vec3 vHoldP;\nvarying vec3 vHoldN;\nvarying vec4 vHole;\nvarying vec3 vAxis;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvHoldP = position;\nvHoldN = normal;\nvHole = aHole;\nvAxis = aAxis;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>
uniform sampler2D uHoldAlb;
uniform sampler2D uHoldNr;
uniform float uHoldOn;
varying vec3 vHoldP;
varying vec3 vHoldN;
varying vec4 vHole;
varying vec3 vAxis;
vec3 holdW;
vec2 holdUv[3];
void holdSetup() {
	vec3 w = pow(abs(normalize(vHoldN)), vec3(4.0));
	holdW = w / (w.x + w.y + w.z);
	holdUv[0] = vHoldP.zy / ${TILE.toFixed(3)};
	holdUv[1] = vHoldP.xz / ${TILE.toFixed(3)} + 0.37;
	holdUv[2] = vHoldP.xy / ${TILE.toFixed(3)} + 0.71;
}`)
			.replace('#include <map_fragment>', `#include <map_fragment>
// the bolt hole: the resin is left open in a circle round the axis, where the countersunk hole built in gym.js shows through
if (vHole.w > 0.0) {
	vec3 hd = vHoldP - vHole.xyz;
	float along = dot(hd, vAxis);
	if (length(hd - vAxis * along) < vHole.w && abs(along) < 0.03) discard;
}
holdSetup();
float holdGrey = texture2D(uHoldAlb, holdUv[0]).r * holdW.x + texture2D(uHoldAlb, holdUv[1]).r * holdW.y + texture2D(uHoldAlb, holdUv[2]).r * holdW.z;
diffuseColor.rgb *= mix(1.0, holdGrey * 1.5, uHoldOn);`)
			.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
	float r = texture2D(uHoldNr, holdUv[0]).b * holdW.x + texture2D(uHoldNr, holdUv[1]).b * holdW.y + texture2D(uHoldNr, holdUv[2]).b * holdW.z;
	roughnessFactor = mix(roughnessFactor, clamp(r * 1.25, 0.35, 1.0), uHoldOn);
}`)
			.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
	vec3 n = normalize(vHoldN);
	vec3 tx = vec3(texture2D(uHoldNr, holdUv[0]).rg * 2.0 - 1.0, 1.0);
	vec3 ty = vec3(texture2D(uHoldNr, holdUv[1]).rg * 2.0 - 1.0, 1.0);
	vec3 tz = vec3(texture2D(uHoldNr, holdUv[2]).rg * 2.0 - 1.0, 1.0);
	float s = 0.9;
	tx.xy *= s; ty.xy *= s; tz.xy *= s;
	// whiteout blend: the detail's tilt is added to the surface normal's other two components, per projection
	tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
	ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
	tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
	vec3 nObj = normalize(tx.zyx * holdW.x + ty.xzy * holdW.y + tz.xyz * holdW.z);
	vec3 nView = normalize((viewMatrix * vec4(nObj, 0.0)).xyz);
	normal = normalize(mix(normal, nView, uHoldOn));
}`);
	};
	material.customProgramCacheKey = () => 'hold-resin';
	return material;
}

// the steel of a screw: a bright, slightly worn metal that picks up the room's lights through the environment map
export function screwMaterial() {
	return new THREE.MeshStandardMaterial({ color: 0xc4c8cd, metalness: 1, roughness: 0.34 });
}

// a triangle soup's extra per-vertex data for the hold shader: the bolt hole's center, cut radius and axis (see Sink in gym.js)
export function holeAttributes(geometry, sink) {
	// a hold with no bolt hole still needs the attributes (an absent one reads as (0, 0, 0, 1) and would cut a hole a meter wide)
	const data = new Float32Array(sink.hole ?? new Array(sink.positions.length / 3 * 7).fill(0));
	const a = new Float32Array(data.length / 7 * 4), b = new Float32Array(data.length / 7 * 3);
	for (let i = 0; i < data.length / 7; i++) { a.set(data.subarray(i * 7, i * 7 + 4), i * 4); b.set(data.subarray(i * 7 + 4, i * 7 + 7), i * 3); }
	geometry.setAttribute('aHole', new THREE.BufferAttribute(a, 4));
	geometry.setAttribute('aAxis', new THREE.BufferAttribute(b, 3));
}
