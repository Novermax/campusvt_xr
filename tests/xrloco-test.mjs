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

// La testa: sta nel rig, e da dove sta dipende dove si atterra.
const testa = new THREE.PerspectiveCamera();
testa.position.set(0, 1.6, 0);
rig.add(testa);

const premuti = [];
globalThis.window = {
    THREE,
    Scene3D: { scene, camera: testa },
    XRUI: {
        targets: () => [button],
        activate: (m) => { premuti.push(m.userData.xrUiAction); return true; },
    },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.document = {
    getElementById: () => null,
    addEventListener() {},
    readyState: 'complete',
};

// L'XRSession vero, non uno stub: e' lui a sapere che a spostarsi e' la testa,
// e le prove qui sotto servono proprio a verificare quello.
new Function(readFileSync(`${ROOT}xr/XRSession.js`, 'utf8'))();
const XS = window.XRSession;
XS.rig = rig;
XS.isPresenting = true;
XS._calibrated = true;              // l'altezza non c'entra: qui si guarda la pianta
XS._sampleHead();

new Function(readFileSync(`${ROOT}xr/XRLocomotion.js`, 'utf8'))();
const L = window.XRLocomotion;
L.init(XS, { sources });

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

// ── 5. Chi non sta al centro della propria stanza ─────────────────────
//
// Il rig e' il pavimento sotto i piedi, ma l'utente non ci sta in mezzo:
// sta dove si trova FISICAMENTE rispetto all'origine del reference space.
// Spostando il rig sul punto mirato, ci finiva l'origine — e la persona
// restava scostata di altrettanto. Il marcatore era nel punto giusto e si
// atterrava di fianco (riscontrato sul Quest il 2026-08-03).

testa.position.set(0.9, 1.6, -0.6);          // un passo a destra e uno avanti
rig.position.set(0, 0, 0);
rig.rotation.y = 0;
scene.updateMatrixWorld(true);
XS._sampleHead();

const testaInMondo = () => {
    rig.updateMatrixWorld(true);
    return testa.getWorldPosition(new THREE.Vector3());
};

const meta = new THREE.Vector3(1.5, 0, -3);
L.teleportTo(meta);
let h = testaInMondo();
check('teleport: ci arriva la TESTA, non l origine del rig',
    Math.abs(h.x - meta.x) < 1e-6 && Math.abs(h.z - meta.z) < 1e-6,
    `(${h.x.toFixed(2)}, ${h.z.toFixed(2)})`);
check('e infatti il rig e scostato apposta',
    Math.hypot(rig.position.x - meta.x, rig.position.z - meta.z) > 0.5,
    `rig (${rig.position.x.toFixed(2)}, ${rig.position.z.toFixed(2)})`);

// Con la scala del mondo lo scostamento cambia di grandezza: va scalato.
rig.scale.setScalar(0.769);
L.teleportTo(meta);
h = testaInMondo();
check('vale anche col mondo ingrandito', Math.abs(h.x - meta.x) < 1e-6 && Math.abs(h.z - meta.z) < 1e-6,
    `(${h.x.toFixed(2)}, ${h.z.toFixed(2)})`);
rig.scale.setScalar(1);
L.teleportTo(meta);

// La rotazione a scatti: girarsi non e' spostarsi. Il rig girava attorno a
// se stesso, portando in giro su un arco chi non era al suo centro.
const prima = testaInMondo();
XS.session = { inputSources: [{ handedness: 'right', gamepad: { axes: [0, 0, 0, 0] } }] };
L._pollSnapTurn();                                    // arma lo scatto
XS.session.inputSources[0].gamepad.axes[2] = 1;
L._pollSnapTurn();                                    // scatto a destra
const dopo = testaInMondo();

check('rotazione: la testa gira, ma resta dov era',
    Math.abs(dopo.x - prima.x) < 1e-6 && Math.abs(dopo.z - prima.z) < 1e-6,
    `(${prima.x.toFixed(2)}, ${prima.z.toFixed(2)}) -> (${dopo.x.toFixed(2)}, ${dopo.z.toFixed(2)})`);
check('e lo scatto e di 30 gradi', Math.abs(Math.abs(rig.rotation.y) - Math.PI / 6) < 1e-6,
    (rig.rotation.y * 180 / Math.PI).toFixed(0) + '°');

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
