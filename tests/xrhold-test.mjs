/**
 * Prova deterministica del vincolo "il telecomando sta nella sinistra".
 * Si simula la sequenza che rompeva tutto: spariscono entrambe le mani,
 * torna solo la destra — e per giunta sull'indice che era della sinistra.
 */
import * as THREE from '../core/libs/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const rig = new THREE.Object3D();
const camera = new THREE.PerspectiveCamera();
rig.add(camera);

/** Una sorgente come quella di XRInput: controller, handObj con giunti. */
function mkSource(index) {
    const controller = new THREE.Object3D();
    controller.name = `controller${index}`;
    const handObj = new THREE.Object3D();
    handObj.name = `hand${index}`;
    const joints = {};
    ['middle-finger-metacarpal', 'wrist'].forEach((n) => {
        const j = new THREE.Object3D();
        j.name = `${n}#${index}`;
        j.visible = true;
        handObj.add(j);
        joints[n] = j;
    });
    handObj.joints = joints;
    rig.add(controller);
    rig.add(handObj);
    return { index, controller, handObj, hand: null, isHand: false, inputSource: null };
}

const sources = [mkSource(0), mkSource(1)];
const connect = (i, hand) => { sources[i].inputSource = { handedness: hand }; sources[i].hand = hand; sources[i].isHand = true; };
const disconnect = (i) => { sources[i].inputSource = null; sources[i].hand = null; };

const model = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.02));
model.name = 'remote';
const world = new THREE.Object3D();
world.add(model);
world.add(rig);

globalThis.window = {
    THREE,
    Scene3D: { camera },
    HoldableSystem: {
        animatePick: () => {},
        updateHeldObjectPosition: () => {},
    },
    localStorage: undefined,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

new Function(readFileSync(`${ROOT}xr/XRHold.js`, 'utf8'))();
const XH = window.XRHold;

const xrSession = { isPresenting: true, rig };
XH.attach(xrSession, { sources });

let fails = 0;
const check = (label, cond, extra = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/** Risale la catena e dice a quale sorgente è appeso il modello. */
const holder = () => {
    let n = model.parent;
    while (n) {
        for (const s of sources) {
            if (n === s.controller) return `controller#${s.index}`;
            for (const k in s.handObj.joints) if (n === s.handObj.joints[k]) return `giunto#${s.index}`;
        }
        if (n === camera) return 'testa';
        n = n.parent;
    }
    return 'nessuno';
};

const place = () => { world.updateMatrixWorld(true); window.HoldableSystem.updateHeldObjectPosition(model); };

// 1. Presa normale: sinistra su indice 0, destra su indice 1.
connect(0, 'left');
connect(1, 'right');
place();
check('preso con le due mani in vista: sta nella sinistra', holder() === 'giunto#0', holder());

// 2. Anche se a toccarlo è stata la destra, resta nella sinistra.
place();
check('la destra non se lo prende', holder() === 'giunto#0', holder());

// 3. Spariscono entrambe le mani: si stacca dai giunti ma non si muove
//    di un millimetro — resta dove la sinistra l'ha lasciato.
world.updateMatrixWorld(true);
const posaInMano = model.getWorldPosition(new THREE.Vector3()).clone();
disconnect(0);
disconnect(1);
place();
world.updateMatrixWorld(true);
check('mani sparite: resta immobile, non rimbalza',
    model.getWorldPosition(new THREE.Vector3()).distanceTo(posaInMano) < 1e-6, holder());

// 4. IL CASO DEL BUG: torna solo la destra, e sull'indice 0 — quello che
//    prima era della sinistra. L'ancora era appesa ai giunti di quell'indice,
//    quindi il telecomando cominciava a seguire la destra, con la posa
//    dell'altra mano (si vedeva il retro).
world.updateMatrixWorld(true);
const posaPrima = model.getWorldPosition(new THREE.Vector3()).clone();
const rotPrima = model.getWorldQuaternion(new THREE.Quaternion()).clone();

connect(0, 'right');
// La destra si muove: se il telecomando la seguisse, si sposterebbe con lei.
sources[0].handObj.joints['middle-finger-metacarpal'].position.set(0.4, -0.3, 0.2);
place();
check('torna solo la destra: NON la segue', holder() !== 'giunto#0', holder());
check('non finisce nemmeno davanti alla faccia', holder() !== 'testa', holder());
check('la mano vincolata resta la sinistra', XH.getHand() === 'left');

world.updateMatrixWorld(true);
check('resta immobile dove la sinistra l aveva lasciato',
    model.getWorldPosition(new THREE.Vector3()).distanceTo(posaPrima) < 1e-6,
    model.getWorldPosition(new THREE.Vector3()).toArray().map((v) => v.toFixed(3)).join(','));
check('e con la stessa posa, non girato',
    model.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotPrima) < 1e-6);

// Anche insistendo per tutta la sessione: la destra non lo prende mai.
for (let i = 0; i < 10; i++) { sources[0].handObj.joints['middle-finger-metacarpal'].position.x += 0.05; place(); }
world.updateMatrixWorld(true);
check('la destra non se lo prende nemmeno insistendo',
    model.getWorldPosition(new THREE.Vector3()).distanceTo(posaPrima) < 1e-6, holder());

// 5. Torna la sinistra, stavolta sull'indice 1: lo riprende lei.
connect(1, 'left');
place();
check('la sinistra torna su un altro indice: se lo riprende', holder() === 'giunto#1', holder());

// 6. Una sola ancora in giro: nessun doppione appeso alle mani.
let anchors = 0;
rig.traverse((o) => { if (o.name === 'XRHoldAnchor') anchors++; });
camera.traverse((o) => { if (o.name === 'XRHoldAnchor') anchors++; });
check('esiste una sola ancora', anchors === 1, `${anchors} ancore`);

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
