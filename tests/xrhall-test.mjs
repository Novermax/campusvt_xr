/**
 * Prova deterministica della hall immersiva.
 *
 * Niente visore: DOM finto, `UI` finto, e si guarda cosa la hall mostra, quando
 * compare e sparisce, e cosa chiama quando si preme una card.
 *
 * La domanda a cui questo file risponde è una sola: **si può fare tutto il giro
 * — scegliere uno scenario, finirlo, tornare a scegliere — senza mai uscire
 * dalla sessione?** È il punto dell'intera hall, ed è anche l'unica cosa che si
 * può verificare qui: che la resa sia comoda lo dice solo il visore.
 */
import * as THREE from '../core/libs/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ── DOM finto ──────────────────────────────────────────────────────────
const drawn = [];
const fakeCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({
        clearRect() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {},
        fill() {}, stroke() {},
        measureText: (t) => ({ width: String(t).length * 20 }),
        fillText: (t) => drawn.push(String(t)),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
        set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    }),
});

globalThis.document = {
    getElementById: () => null,
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : {}),
};

// ── Scena finta: quel che conta e' che rig e pavimento sopravvivano ────
const scene = new THREE.Scene();
const rig = new THREE.Object3D();
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 1.6, 0);
rig.add(camera);
scene.add(rig);

/** I due scenari veri di `core/scenes/homeconfig.ini`. */
const scenari = [
    {
        name: 'Manutenzione Elettromandrino',
        id: 'elettromandrino',
        description: 'Controllo e manutenzione elettromandrino con coni HSK: pulizia pinza, lubrificazione, sblocco/blocco manuale della pinza.',
    },
    {
        name: 'Manutenzione pompa del vuoto',
        id: 'pompa_becker',
        description: 'Smontaggio e rimontaggio della pompa del vuoto Becker.',
    },
];

let pagina = 'home';
let config = null;               // arriva dalla rete DOPO il boot
const caricati = [];
const modelli = [];              // finti loadedModels

globalThis.window = {
    THREE,
    Scene3D: {
        scene,
        camera,
        loadedModels: modelli,
        // Il vero clearAllModels: rimuove SOLO i modelli caricati.
        clearAllModels() {
            modelli.forEach((m) => scene.remove(m));
            modelli.length = 0;
        },
    },
    UI: {
        get currentPage() { return pagina; },
        get scenarioManager() {
            return {
                get scenariosConfig() { return config; },
                loadScenario(sc) {
                    caricati.push(sc.name);
                    pagina = 'scenario';
                    const finto = new THREE.Object3D();
                    modelli.push(finto);
                    scene.add(finto);
                },
            };
        },
    },
};
globalThis.setTimeout = (fn) => 0;   // il lampo della card non ci interessa

new Function(readFileSync(`${ROOT}xr/XRHall.js`, 'utf8'))();
const H = window.XRHall;

let fails = 0;
const check = (label, cond, extra = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const testo = () => drawn.join(' ');
const bersagli = () => (H.targets() || []).map((c) => c.userData.xrUiAction).join(',');

H.init({ isPresenting: true, rig });

// ── 1. Prima che la configurazione arrivi ──────────────────────────────
// La lista scenari e' una fetch: al primo frame in VR non c'e' ancora.
drawn.length = 0;
H.update();
check('senza configurazione lo dice, invece di restare vuota',
    testo().includes('Caricamento'), testo().slice(0, 40));
check('e non offre card da premere a vuoto', bersagli() === '', bersagli());

// ── 2. Arrivata la configurazione: la home diventa un luogo ────────────
config = { scenarios: scenari };
drawn.length = 0;
H.update();
check('mostra un pannello per ogni scenario', H.cards.length === 2, String(H.cards.length));
check('col nome dello scenario', testo().includes('Manutenzione Elettromandrino'));
check('e con la spiegazione, o si sceglie a caso',
    testo().includes('coni HSK') || testo().includes('pulizia pinza'), testo().slice(0, 120));
check('le card sono premibili', bersagli() === 'hall:0,hall:1', bersagli());
check('e c e un pavimento sotto i piedi', !!H.floor && H.floor.parent === scene);

// La colonna sta a sinistra e girata verso l'operatore: un rettangolo di
// testo visto di taglio e' testo che non si legge.
check('la colonna sta a sinistra', H.column.position.x < -0.2, H.column.position.x.toFixed(2));
check('e girata verso chi guarda', H.column.rotation.y > 0.2,
    (H.column.rotation.y * 180 / Math.PI).toFixed(0) + '°');
check('a portata di braccio, o non si preme', H.root.position.distanceTo(camera.position) < 0.7,
    H.root.position.distanceTo(camera.position).toFixed(2) + ' m');

// Le card non si ricostruiscono a ogni frame: sarebbe una texture rifatta
// 72 volte al secondo per niente.
const v = H.version;
H.update();
check('e a elenco invariato non si ricostruisce nulla', H.version === v);

// ── 3. Premere una card entra nello scenario ───────────────────────────
const rigPrima = rig.parent;
H.activate(H.cards[0]);
check('premere una card carica lo scenario giusto',
    caricati.join(',') === 'Manutenzione Elettromandrino', caricati.join(','));
check('passando dalla stessa loadScenario del mouse', pagina === 'scenario');

H.update();
check('entrati nello scenario la hall sparisce', !H.isVisible());
check('e le sue card non sono piu premibili', H.targets() === null);

// Il punto di tutta la faccenda: la sessione XR non si interrompe.
check('ma il rig resta appeso alla scena — la VR non si interrompe',
    rig.parent === rigPrima && rig.parent === scene);

// ── 4. Fine tutorial: goHome riporta nella hall ────────────────────────
// `UICore.goHome` fa clearAllModels e showPage('home'). Non ricrea ne'
// scene ne' renderer: e' per questo che si puo' tornare senza togliersi
// il visore.
window.Scene3D.clearAllModels();
pagina = 'home';
H.update();
check('tornati alla home la hall ricompare', H.isVisible());
check('con le card di nuovo premibili', bersagli() === 'hall:0,hall:1', bersagli());
check('e il rig e sopravvissuto alla pulizia dei modelli', rig.parent === scene);
check('come il pavimento della hall, che non e un modello caricato',
    H.floor.parent === scene && H.floor.visible);

// Si puo' rientrare in un altro scenario: il giro e' chiuso.
H.activate(H.cards[1]);
check('e si puo entrare in un altro scenario', caricati.length === 2, caricati.join(','));

// ── 4b. La lingua dell'utente, non una scelta in piu' ──────────────────
// Nomi e descrizioni arrivano gia' tradotti (core ricarica homeconfig_<lang>),
// ma le due frasi della hall sono nostre e devono seguirli.
pagina = 'home';
window.currentUser = { name: 'tester', language: 'eng' };
config = {
    scenarios: [{ name: 'Electrospindle Maintenance', id: 'elettromandrino', description: 'Spindle check and maintenance.' }],
};
drawn.length = 0;
H.update();
check('col profilo in inglese la hall parla inglese',
    testo().includes('Choose a scenario'), testo().slice(0, 60));
check('e mostra i nomi tradotti che arrivano da core',
    testo().includes('Electrospindle Maintenance'));

window.currentUser = { name: 'tester', language: 'deu' };
config = { scenarios: [{ name: 'Wartung Elektrospindel', id: 'elettromandrino', description: 'Wartung.' }] };
drawn.length = 0;
H.update();
check('e in tedesco parla tedesco', testo().includes('Szenario wählen'), testo().slice(0, 60));

// Lingua sconosciuta o profilo assente: si resta all'italiano, che e' la
// lingua della configurazione di default. Non si mostra una stringa vuota.
window.currentUser = { name: 'tester', language: 'xx' };
config = { scenarios: scenari };
drawn.length = 0;
H.update();
check('con una lingua che non conosciamo resta l italiano',
    testo().includes('Scegli uno scenario'), testo().slice(0, 60));

window.currentUser = null;
config = { scenarios: scenari };

// ── 5. Fuori dalla home la hall non esiste, nemmeno come bersaglio ─────
pagina = 'scenario';
H.update();
check('durante uno scenario niente hall', H.targets() === null);
check('e il suo pavimento sparisce, o coprirebbe quello vero', !H.floor.visible);

// ── 6. Azioni altrui: la hall le lascia passare ────────────────────────
// Pannello e hall si dividono `xrUiAction`; ciascuno deve riconoscere solo
// le proprie, o il primo che risponde mangerebbe i tocchi dell'altro.
check('non rivendica le azioni del pannello del tutorial',
    H.activate({ userData: { xrUiAction: 'ok' } }) === false);
check('ne quelle degli strumenti',
    H.activate({ userData: { xrUiAction: 'tool:spray' } }) === false);

// ── 7. Chiusura: niente resta appeso alla scena ────────────────────────
H.dispose();
check('chiudendo la sessione la hall si stacca dalla scena',
    !H.floor && !scene.children.some((c) => c.name === 'XRHallFloor'));

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
