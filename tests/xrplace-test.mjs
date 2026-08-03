/**
 * Prova deterministica del punto di vista quando si entra in uno scenario
 * dall'interno della VR.
 *
 * `_placeRigAtCamera` gira una volta sola, all'ingresso in sessione. Scegliendo
 * uno scenario dalla hall il rig restava quindi al centro della hall — che è
 * l'origine, cioè *dentro* la macchina, modellata proprio lì attorno. Da dentro
 * una lamiera non si vede nulla: la scena risultava "completamente vuota" pur
 * essendo caricata correttamente.
 *
 * Qui si verifica con le coordinate vere di `core/scenes/homeconfig.ini`.
 */
import * as THREE from '../core/libs/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ getContext: () => null, addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false } }),
    addEventListener() {},
    readyState: 'complete',
};
globalThis.window = {
    THREE,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
};
globalThis.localStorage = window.localStorage;
globalThis.setTimeout = (fn) => 0;

new Function(readFileSync(`${ROOT}xr/XRSession.js`, 'utf8'))();
const XS = window.XRSession;

let fails = 0;
const check = (label, cond, extra = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const rig = new THREE.Object3D();
XS.rig = rig;
XS.isPresenting = true;

// Lo scenario vero, con le sue coordinate vere.
const elettromandrino = {
    name: 'Manutenzione Elettromandrino',
    cameraPos: '(-1.11, 1.44, 3.97)',
    cameraTarget: '(0, 0, 0)',
};

// Si parte da dove sta la hall: l'origine.
rig.position.set(0, 0, 0);
rig.rotation.y = 0;
const y0 = rig.position.y;

const ok = XS.placeRigForScenario(elettromandrino);
check('lo scenario dichiara un punto di vista e viene applicato', ok === true);
check('l osservatore non resta piu dentro la macchina',
    Math.hypot(rig.position.x, rig.position.z) > 1,
    `a ${Math.hypot(rig.position.x, rig.position.z).toFixed(2)} m dall origine`);
check('sta esattamente dove CameraPos dice, in pianta',
    Math.abs(rig.position.x - (-1.11)) < 1e-6 && Math.abs(rig.position.z - 3.97) < 1e-6,
    `(${rig.position.x}, ${rig.position.z})`);

// L'altezza NON si tocca: in VR la da' il visore, e imporla farebbe
// galleggiare o sprofondare.
check('ma l altezza resta quella calibrata dal visore', rig.position.y === y0);

// Girato verso la macchina: arrivarci dandole le spalle e' come non esserci.
const avanti = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, rig.rotation.y, 0));
const verso = new THREE.Vector3(0, 0, 0).sub(new THREE.Vector3(rig.position.x, 0, rig.position.z)).normalize();
check('e girato verso cio che lo scenario vuole far guardare',
    avanti.dot(verso) > 0.99, `dot=${avanti.dot(verso).toFixed(3)}`);

// Uno scenario senza CameraPos non deve spostare nessuno a caso.
rig.position.set(2, 0, 2);
const prima = rig.position.clone();
check('senza CameraPos non sposta nulla',
    XS.placeRigForScenario({ name: 'senza camera' }) === false && rig.position.equals(prima));

// Fuori sessione non si tocca il rig: sul desktop la camera e' di core.
XS.isPresenting = false;
rig.position.set(5, 0, 5);
const desktop = rig.position.clone();
check('e fuori dalla sessione non interferisce col desktop',
    XS.placeRigForScenario(elettromandrino) === false && rig.position.equals(desktop));
XS.isPresenting = true;

// Il parser regge il formato di homeconfig.ini, spazi e segni compresi.
check('legge le coordinate negative e decimali',
    (() => { const v = XS._vec3('(-1.11, 1.44, 3.97)'); return v.x === -1.11 && v.y === 1.44 && v.z === 3.97; })());
check('e su una stringa senza numeri non inventa una posizione',
    XS._vec3('boh') === null && XS._vec3(null) === null && XS._vec3('(1, 2)') === null);

// ─────────────────────────────────────────────────────────────────────────
// La testa, non il rig.
//
// Il rig è il pavimento sotto i piedi dell'utente, ma l'utente non ci sta in
// mezzo: sta dove si trova fisicamente in stanza rispetto all'origine del
// reference space. Mettendo il RIG su CameraPos, quello scostamento fisico
// si somma e si compare di lato — sul Quest, accanto alla console invece che
// davanti (2026-08-03). Qui la testa c'è, ed è lei a dover arrivare a posto.
// ─────────────────────────────────────────────────────────────────────────

/** Un utente in piedi 0,80 m a destra e 0,40 m avanti rispetto all'origine
 *  della stanza, girato di 35° per conto suo. */
const testa = new THREE.PerspectiveCamera();
testa.position.set(0.8, 1.7, -0.4);
testa.quaternion.setFromEuler(new THREE.Euler(0, 0.61, 0, 'YXZ'));
rig.add(testa);
window.Scene3D = { camera: testa };

const mondo = new THREE.Vector3();
const avantiTesta = new THREE.Vector3();
const misura = () => {
    rig.updateMatrixWorld(true);
    testa.getWorldPosition(mondo);
    avantiTesta.set(0, 0, -1).applyQuaternion(testa.getWorldQuaternion(new THREE.Quaternion()));
};

for (const scala of [1, 0.769]) {          // scala 1 e mondo ingrandito 1,3×
    rig.scale.setScalar(scala);
    rig.position.set(0, 0, 0);
    rig.rotation.y = 0;

    XS.placeRigForScenario(elettromandrino);
    misura();

    check(`la TESTA arriva su CameraPos (scala rig ${scala})`,
        Math.abs(mondo.x - (-1.11)) < 1e-6 && Math.abs(mondo.z - 3.97) < 1e-6,
        `(${mondo.x.toFixed(3)}, ${mondo.z.toFixed(3)})`);

    const versoMacchina = new THREE.Vector3(0, 0, 0)
        .sub(new THREE.Vector3(mondo.x, 0, mondo.z)).normalize();
    const avantiPiano = new THREE.Vector3(avantiTesta.x, 0, avantiTesta.z).normalize();
    check(`e guarda la macchina, non dove era girata prima (scala rig ${scala})`,
        avantiPiano.dot(versoMacchina) > 0.99, `dot=${avantiPiano.dot(versoMacchina).toFixed(3)}`);

    check(`il rig non coincide piu con CameraPos: e' scostato apposta (scala rig ${scala})`,
        Math.hypot(rig.position.x - (-1.11), rig.position.z - 3.97) > 0.1);
}

// Senza posa della testa leggibile si ripiega sul comportamento di prima,
// invece di compensare con dati inventati.
rig.remove(testa);
rig.scale.setScalar(1);
rig.position.set(0, 0, 0);
rig.rotation.y = 0;
XS.placeRigForScenario(elettromandrino);
check('senza testa agganciata al rig, si torna a posizionare il rig e basta',
    Math.abs(rig.position.x - (-1.11)) < 1e-6 && Math.abs(rig.position.z - 3.97) < 1e-6);

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
