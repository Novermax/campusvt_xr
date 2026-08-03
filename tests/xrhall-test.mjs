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

/**
 * La pagina, che e' cio' che la hall guarda davvero.
 *
 * `paginaDom` normalmente segue `pagina`; forzandolo si simula il caso vero
 * del sito pubblicato, dove `UI.currentPage` resta indietro (vedi prova 9).
 */
let paginaDom = null;
const scenarioPageEl = {
    classList: { contains: (c) => c === 'hidden' && (paginaDom || pagina) !== 'scenario' },
};

globalThis.document = {
    getElementById: (id) => (id === 'scenarioPage' ? scenarioPageEl : null),
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

const entra = (sc) => {
    caricati.push(sc.name);
    pagina = 'scenario';
    const finto = new THREE.Object3D();
    modelli.push(finto);
    scene.add(finto);
};

/**
 * Di `UI` ne esistono DUE, e vanno provate entrambe.
 *
 * `ui-coordinator.js` espone `UI.scenarioManager.scenariosConfig = {scenarios:[…]}`;
 * `ui.js` — il monolite, che a runtime è quello che comanda davvero — espone
 * `UI.scenariosConfig` come **array nudo** e `UI.loadScenario` direttamente.
 * Provare solo la prima forma è esattamente l'errore che teneva la hall su
 * «Caricamento scenari…» per sempre sul sito vero: nessun test se ne accorgeva.
 */
const UI_MODULARE = {
    get currentPage() { return pagina; },
    get scenarioManager() {
        return {
            get scenariosConfig() { return config; },
            loadScenario: entra,
        };
    },
};

const UI_MONOLITE = {
    get currentPage() { return pagina; },
    // Array nudo, non {scenarios: […]}.
    get scenariosConfig() { return config ? config.scenarios : null; },
    loadScenario: entra,
};

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
    UI: UI_MODULARE,
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

check('a portata di braccio, o non si preme', H.root.position.distanceTo(camera.position) < 0.7,
    H.root.position.distanceTo(camera.position).toFixed(2) + ' m');
check('con pochi scenari resta una colonna sola',
    new Set(H.cards.map((c) => c.position.x.toFixed(3))).size === 1);

// Le card non si ricostruiscono a ogni frame: sarebbe una texture rifatta
// 72 volte al secondo per niente.
const v = H.version;
H.update();
check('e a elenco invariato non si ricostruisce nulla', H.version === v);

// ── 3. Premere una card entra nello scenario ───────────────────────────
const rigPrima = rig.parent;
// L'osservatore deve essere portato al punto di vista dello scenario: entrando
// dall'origine — dove sta la hall — ci si ritroverebbe DENTRO la macchina, che
// e' modellata proprio li' attorno, e la scena sembrerebbe vuota.
const spostato = [];
window.XRSession = {
    isPresenting: true,
    rig,
    placeRigForScenario(sc) { spostato.push(sc.name); return true; },
};
H.activate(H.cards[0]);
check('entrando porta l osservatore al punto di vista dello scenario',
    spostato.join(',') === 'Manutenzione Elettromandrino', spostato.join(','));
delete window.XRSession;
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

// ── 6b. Dieci scenari, che e' il numero vero ───────────────────────────
// `homeconfig.ini` ne dichiara dieci, non due. In colonna unica sarebbero
// 1,28 m di pannelli: la prima sopra la testa, l'ultima sotto le ginocchia.
pagina = 'home';
config = { scenarios: Array.from({ length: 10 }, (_, i) => ({
    name: `Scenario ${i + 1}`, id: `s${i}`, description: 'Descrizione.',
})) };
H.update();
check('con dieci scenari costruisce dieci card', H.cards.length === 10, String(H.cards.length));

const colonneX = [...new Set(H.cards.map((c) => c.position.x.toFixed(3)))];
const righeY = [...new Set(H.cards.map((c) => c.position.y.toFixed(3)))];
check('e le affianca invece di impilarle tutte', colonneX.length === 2, colonneX.length + ' colonne');
check('cinque per colonna', righeY.length === 5, righeY.length + ' righe');

// Riempite per colonne: due voci consecutive non devono finire affiancate,
// o l'ordine dell'elenco si perde.
check('riempite per colonne, come si legge un elenco',
    H.cards[0].position.x === H.cards[1].position.x
    && H.cards[0].position.y > H.cards[1].position.y);

// Tutto deve restare raggiungibile: e' il motivo per cui si affiancano.
const altezza = Math.max(...H.cards.map((c) => c.position.y)) - Math.min(...H.cards.map((c) => c.position.y));
check('e la griglia resta alta quanto un braccio arriva', altezza < 0.7, altezza.toFixed(2) + ' m');
check('col titolo sopra a tutte',
    H.title.position.y > Math.max(...H.cards.map((c) => c.position.y)));

// ── 7. L'ALTRA UI: il monolite, che a runtime e' quello che comanda ────
// `ui.js` si fa da parte solo se trova la UI modulare gia' AVVIATA, e la
// riconosce da `_tutorialManager` — che a quel punto e' ancora null. In
// pratica vince sempre lui, con `scenariosConfig` come array nudo e
// `loadScenario` su UI. Leggendo solo la forma modulare, la hall sul sito
// vero restava su «Caricamento scenari…» e nessuna card veniva costruita.
H.dispose();

pagina = 'home';
caricati.length = 0;
window.UI = UI_MONOLITE;
config = { scenarios: scenari };
window.currentUser = null;

const rig2 = new THREE.Object3D();
scene.add(rig2);
H.init({ isPresenting: true, rig: rig2 });
drawn.length = 0;
H.update();
check('legge gli scenari anche dal monolite (array nudo)',
    H.cards.length === 2, String(H.cards.length));
check('e non resta bloccata su "Caricamento"',
    testo().includes('Scegli uno scenario'), testo().slice(0, 40));
H.activate(H.cards[0]);
check('e li carica con UI.loadScenario, che li sta su UI',
    caricati.join(',') === 'Manutenzione Elettromandrino', caricati.join(','));

// Nessuna delle due: non si inventa nulla e non esplode.
H.dispose();
pagina = 'home';
window.UI = { get currentPage() { return pagina; } };
const rig3 = new THREE.Object3D();
scene.add(rig3);
H.init({ isPresenting: true, rig: rig3 });
H.update();
check('senza nessuna UI utile non costruisce card fantasma', H.cards.length === 0);
check('e premere non fa danni',
    H.activate({ userData: { xrUiAction: 'hall:0', scenario: scenari[0] } }) === false);

// ── 8b. La hall guarda la PAGINA, non UI.currentPage ──────────────────
//
// Sul sito pubblicato `UI.currentPage` resta 'home' per sempre: il monolite
// lo aggiorna solo dentro showPage, e solo se UI.elements.scenarioPage
// esiste — cosa che non accade mai, perche' UI.init() non viene chiamato.
// Fidandosi di quel campo, l'elenco degli scenari restava sospeso in mezzo
// alla macchina e il tutorial sembrava non partire (XRUI si fa da parte
// finche' la hall e' in scena). Riscontrato sul Quest il 2026-08-03.

H.dispose();
pagina = 'home';
paginaDom = null;
config = { scenarios: scenari };
window.UI = UI_MONOLITE;
const rig4 = new THREE.Object3D();
scene.add(rig4);
H.init({ isPresenting: true, rig: rig4 });
H.update();
check('in home la hall si vede', H.isVisible());

paginaDom = 'scenario';        // la pagina cambia...
H.update();
check('aperto lo scenario la hall si toglie, anche se UI.currentPage resta indietro',
    !H.isVisible(), `currentPage=${window.UI.currentPage}`);

paginaDom = null;              // ...e tornando indietro ricompare
H.update();
check('e tornando alla scelta ricompare', H.isVisible());
H.dispose();

// ── 8c. Mai la parola «undefined» davanti agli occhi ──────────────────
//
// `fillText(undefined)` non solleva niente: scrive «undefined» a caratteri
// cubitali in mezzo al mondo, ed e' quello che l'utente si e' trovato al
// posto del nome di uno scenario (Quest, 2026-08-03). Da dentro il visore
// non si capisce nemmeno quale dato manchi: la console non c'e'.

H.dispose();
pagina = 'home';
paginaDom = null;
config = { scenarios: [{ name: undefined, description: undefined, id: 'rotto' }] };
window.UI = UI_MONOLITE;
const rig5 = new THREE.Object3D();
scene.add(rig5);
H.init({ isPresenting: true, rig: rig5 });
drawn.length = 0;
H.update();
check('con uno scenario senza nome non scrive "undefined"',
    !drawn.some((t) => /undefined/i.test(t)), drawn.join(' | ').slice(0, 60));

// E nemmeno il titolone, se per qualunque ragione arriva vuoto.
drawn.length = 0;
H._drawTitle(undefined);
check('e nemmeno il titolo se arriva vuoto',
    !drawn.some((t) => /undefined/i.test(t)), drawn.join(' | ').slice(0, 40));
H.dispose();
config = { scenarios: scenari };

// ── 8. Chiusura: niente resta appeso alla scena ────────────────────────
H.dispose();
check('chiudendo la sessione la hall si stacca dalla scena',
    !H.floor && !scene.children.some((c) => c.name === 'XRHallFloor'));

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
