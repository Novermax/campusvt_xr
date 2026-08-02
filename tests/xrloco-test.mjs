/**
 * Prova deterministica della disambiguazione fra teleport e pannello.
 * L'idea da verificare: nessuna modalita' da scegliere — decide la direzione.
 */
import * as THREE from '../core/libs/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const scene = new THREE.Object3D();
const rig = new THREE.Object3D();
scene.add(rig);

const mkSource = (i) => {
    const controller = new THREE.Object3D();
    rig.add(controller);
    return { index: i, controller, inputSource: {}, near: null, hand: i ? 'right' : 'left' };
};
const sources = [mkSource(0)];
const s = sources[0];

// Il pannello: un quad davanti alla testa, a 60 cm, leggermente in basso.
const button = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.045));
button.name = 'XRUI_ok';
button.userData.xrUiAction = 'ok';
button.position.set(0, 1.42, -0.6);
scene.add(button);

const premuti = [];
globalThis.window = {
    THREE,
    Scene3D: { scene },
    XRUI: {
        targets: () => [button],
        activate: (m) => { premuti.push(m.userData.xrUiAction); return true; },
    },
};

new Function(readFileSync(`${ROOT}xr/XRLocomotion.js`, 'utf8'))();
const L = window.XRLocomotion;
L.init({ rig, isPresenting: true }, { sources });

let fails = 0;
const check = (label, cond, extra = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/** Punta la mano da `from` verso `to`, come farebbe il braccio. */
const punta = (from, to) => {
    s.controller.position.copy(from);
    s.controller.lookAt(to);
    s.controller.rotateY(Math.PI);          // il raggio esce lungo -Z
    scene.updateMatrixWorld(true);
    L.update(sources);
};
const raggio = () => L.rays[0].ray;
const mano = new THREE.Vector3(0, 1.4, 0);

// ── 1. Verso il pannello: e' interfaccia, non destinazione ─────────────
punta(mano, new THREE.Vector3(0, 1.42, -0.6));
check('puntando il pannello il raggio diventa giallo',
    raggio().material.color.getHex() === 0xffd21e,
    '#' + raggio().material.color.getHex().toString(16));
check('e non propone alcuna destinazione', !L.marker.visible);
check('il raggio si ferma sul pulsante', Math.abs(raggio().scale.z - 0.6) < 0.05,
    raggio().scale.z.toFixed(2));

// Appena il raggio arriva sul comando NON deve essere premibile: e' cosi' che
// un pinch fatto per teleportarsi si portava via uno step di passaggio.
s.controller.dispatchEvent({ type: 'selectstart' });
check('un pinch di passaggio non preme nulla', premuti.length === 0, premuti.join(','));
check('e il raggio lo dice, restando pallido', L.rays[0].ray.material.opacity < 0.5,
    L.rays[0].ray.material.opacity.toFixed(2));

// Fermi un attimo sullo stesso comando: ora si puo'.
s._uiDwellSince -= 400;
L.update(sources);
check('tenendolo fermo il raggio si accende', L.rays[0].ray.material.opacity > 0.9,
    L.rays[0].ray.material.opacity.toFixed(2));
s.controller.dispatchEvent({ type: 'selectstart' });
check('e allora il pinch preme', premuti.join(',') === 'ok', premuti.join(','));
check('senza teleportare', rig.position.length() === 0);

// ── 2. Verso il pavimento: e' destinazione, non interfaccia ────────────
punta(mano, new THREE.Vector3(0, 0, -2));
check('puntando a terra il raggio torna verde',
    raggio().material.color.getHex() === 0x3ddc84,
    '#' + raggio().material.color.getHex().toString(16));
check('e la destinazione compare', L.marker.visible);

s.controller.dispatchEvent({ type: 'selectstart' });
check('il pinch teleporta', Math.abs(rig.position.z + 2) < 0.2, rig.position.z.toFixed(2));
check('senza premere nulla del pannello', premuti.join(',') === 'ok', premuti.join(','));

// ── 3. Mano gia' impegnata a premere: niente raggio, niente teleport ───
rig.position.set(0, 0, 0);
s.near = button;
punta(mano, new THREE.Vector3(0, 0, -2));
check('una mano che sta premendo non mira', !raggio().visible);
s.controller.dispatchEvent({ type: 'selectstart' });
check('e non teleporta nemmeno col pinch', rig.position.length() === 0);
s.near = null;

// ── 4. Senza pannello, tutto come prima ───────────────────────────────
window.XRUI.targets = () => null;
punta(mano, new THREE.Vector3(0, 1.42, -0.6));
check('senza pannello puntare avanti non fa nulla di speciale',
    raggio().material.color.getHex() === 0x9fb4c7,
    '#' + raggio().material.color.getHex().toString(16));

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
