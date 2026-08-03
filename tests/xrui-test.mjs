/**
 * Prova deterministica del pannello in-world.
 * Niente visore: DOM finto, camera finta, e si guarda cosa il pannello legge,
 * quali pulsanti espone e cosa chiama quando vengono premuti.
 */
import * as THREE from '../core/libs/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ── DOM finto: solo gli elementi che il pannello rispecchia ────────────
const els = {};
const mkEl = (id, text) => {
    const cls = new Set();
    const el = {
        id,
        textContent: text || '',
        get innerText() { return this.textContent; },
        classList: {
            contains: (c) => cls.has(c),
            add: (c) => cls.add(c),
            remove: (c) => cls.delete(c),
        },
        clicks: 0,
        click() { this.clicks++; },
    };
    els[id] = el;
    return el;
};

mkEl('stepDescription', 'Premi il pulsante MDI sul pulpito.');
mkEl('stepCurrentNumber', '3');
mkEl('stepTotalNumber', '21');
mkEl('infoModal', '');
mkEl('infoModalTitle', 'Importante');
mkEl('infoModalMessage', 'Usa lo spray lubrificante sul naso.');
mkEl('infoModalOkBtn', 'OK');

// Contenitore media: core ci mette dentro un <video> o una <img>.
let media = null;
els['infoModalMedia'] = { querySelector: (sel) => (media && media.tagName.toLowerCase() === sel ? media : null) };

let animVisible = false;
let animState = null;             // stato di AnimatedWindowSystem
let activeTool = null;
const toolCalls = [];
globalThis.THREE_LOADED = [];

/** Canvas finto: registra il testo scritto, che e' quel che ci interessa. */
const drawn = [];
const fakeCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({
        clearRect() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {},
        fill() {}, stroke() {},
        measureText: (t) => ({ width: String(t).length * 22 }),
        fillText: (t, x, y) => drawn.push(String(t)),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
        set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    }),
});

let stepIndex = 2;
const steps = new Array(21).fill(null).map((_, i) => ({
    title: `Titolo dello step ${i + 1}`,
    properties: { Descrizione: `Descrizione ${i + 1}` },
}));

const nav = [];
const rig = new THREE.Object3D();
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 1.6, 0);
rig.add(camera);
const world = new THREE.Object3D();
world.add(rig);

globalThis.document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : {}),
};
globalThis.window = {
    THREE,
    Scene3D: {
        camera,
        getCurrentTutorialStep: () => ({ properties: { Utensile: 'Spray' } }),
        getRequiredToolForStep: (st) => ({ Spray: 'spray', Mani: 'mano' })[st.properties.Utensile] || null,
    },
    AnimatedWindowSystem: {
        get isVisible() { return animVisible; },
        get state() { return animState; },
    },
    ToolRegistry: {
        getAllTools: () => [
            { id: 'mano', label: 'Mano', icon: 'utilimages/mano.png' },
            { id: 'spray', label: 'Spray', icon: 'utilimages/spray.png' },
        ],
    },
    ToolsManager: {
        getActiveTool: () => activeTool,
        toggleTool: (id) => { toolCalls.push(id); activeTool = id; },
    },
    UI: {
        get currentStepIndex() { return stepIndex; },
        tutorialSteps: steps,
        nextStep: () => { nav.push('next'); stepIndex++; },
        prevStep: () => { nav.push('prev'); stepIndex--; },
    },
};
globalThis.setTimeout = (fn) => 0;   // il lampo del pulsante non ci interessa

const caricate = [];
THREE.TextureLoader.prototype.load = function (url, onLoad) {
    caricate.push(url);
    const tex = { image: { width: 1280, height: 720 }, colorSpace: null, dispose() {} };
    if (onLoad) onLoad(tex);
    return tex;
};
new Function(readFileSync(`${ROOT}xr/XRUI.js`, 'utf8'))();
const UIX = window.XRUI;

const xrSession = { isPresenting: true, rig };
UIX.init(xrSession);

let fails = 0;
const check = (label, cond, extra = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
/** Solo i pulsanti di navigazione: gli strumenti si contano a parte. */
const visibili = () => UIX.targets().map((b) => b.userData.xrUiAction)
    .filter((a) => a.indexOf('tool:') !== 0).join(',');
const strumenti = () => UIX.targets().map((b) => b.userData.xrUiAction)
    .filter((a) => a.indexOf('tool:') === 0).join(',');
const testo = () => drawn.join(' ');

// ── 1. Passo normale ───────────────────────────────────────────────────
drawn.length = 0;
UIX.update();
check('mostra il contatore del passo', testo().includes('Passo 3 di 21'), testo().slice(0, 40));
check('mostra il titolo dello step', testo().includes('Titolo dello step 3'));
check('mostra la descrizione letta dal DOM', testo().includes('Premi il pulsante MDI'));
check('durante lo step l unico pulsante e il ritorno alla hall', visibili() === 'hall', visibili());
check('e mentre si lavora il fumetto sta a sinistra', UIX.bubble.position.x < -0.4,
    UIX.bubble.position.x.toFixed(2));
check('e in alto, staccato dagli strumenti', UIX.bubble.position.y > 0.3,
    UIX.bubble.position.y.toFixed(2));
check('girato verso l operatore, per non leggerlo di taglio',
    UIX.bubble.rotation.y > 0.3, (UIX.bubble.rotation.y * 180 / Math.PI).toFixed(0) + '°');
check('gli strumenti restano in basso, staccati dal fumetto',
    UIX.toolBar.position.y < UIX.bubble.position.y - 0.2);

// ── 2. Vale a ogni passo, primo compreso ───────────────────────────────
stepIndex = 0;
els.stepCurrentNumber.textContent = '1';
UIX.update();
check('nemmeno al primo passo compaiono frecce', visibili() === 'hall', visibili());

// ── 3. In VR si avanza facendo lo step, non premendo una freccia ───────
// Il pannello non deve avere alcuna strada per navigare da solo: saltare
// uno step in VR significa portarsi via l'azione che lo step chiedeva.
check('il pannello non espone azioni di navigazione fra gli step',
    UIX.buttons.every((b) => ['ok', 'hall'].includes(b.userData.xrUiAction)),
    UIX.buttons.map((b) => b.userData.xrUiAction).join(','));
check('e non ha mai chiamato UI.nextStep/prevStep', nav.join(',') === '', nav.join(','));

// ── 4. Il modale: era il vero blocco, invisibile in VR ─────────────────
els.infoModal.classList.add('show');
drawn.length = 0;
UIX.update();
check('col modale aperto mostra il messaggio', testo().includes('spray lubrificante'), testo().slice(0, 50));
check('e il suo titolo', testo().includes('Importante'));
check('resta solo OK da premere', visibili() === 'ok', visibili());
check('e col modale il fumetto torna al centro e dritto',
    UIX.bubble.position.x === 0 && UIX.bubble.position.y === 0 && UIX.bubble.rotation.y === 0,
    `${UIX.bubble.position.x.toFixed(2)},${UIX.bubble.position.y.toFixed(2)}`);
check('col video sopra di se', UIX.media.parent === UIX.bubble);
check('e col modale aperto gli strumenti non si toccano', strumenti() === '', strumenti());

UIX.activate(UIX.btnOk);
check('OK preme il vero pulsante del modale', els.infoModalOkBtn.clicks === 1);
check('senza navigare per conto proprio', nav.join(',') === '', nav.join(','));

els.infoModal.classList.remove('show');
UIX.update();
check('chiuso il modale torna il solo ritorno alla hall', visibili() === 'hall', visibili());

// ── 4b. Fine tutorial: era il secondo blocco invisibile ────────────────
// `core/` costruisce al volo #congratulationsModal e congela la scena con
// interactionsBlocked. Senza rispecchiarlo, l'ultimo passo lasciava il
// visore davanti a una scena morta e nessun modo di uscirne.
const congrats = mkEl('congratulationsModal', '');
congrats.querySelector = (sel) => ({
    '.congratulations-header': { innerText: '🎉 Complimenti!', textContent: '🎉 Complimenti!' },
    '.congratulations-body': {
        innerText: 'Mario, hai completato con successo il tutorial: "Manutenzione Elettromandrino"',
        textContent: 'Mario, hai completato con successo il tutorial',
    },
}[sel] || null);
mkEl('congratulationsCloseBtn', 'Continua');

congrats.classList.add('show');
drawn.length = 0;
UIX.update();
check('a tutorial finito mostra le congratulazioni', testo().includes('Complimenti'), testo().slice(0, 40));
check('col nome del tutorial completato', testo().includes('Elettromandrino'));
check('e un solo pulsante da premere', visibili() === 'ok', visibili());
check('che dice Continua, non OK', UIX.btnOk.userData.label === 'Continua', UIX.btnOk.userData.label);
check('col fumetto al centro, come per ogni modale',
    UIX.bubble.position.x === 0 && UIX.bubble.position.y === 0);

UIX.activate(UIX.btnOk);
check('e preme il vero pulsante di core', els.congratulationsCloseBtn.clicks === 1);
check('senza toccare quello dell altro modale', els.infoModalOkBtn.clicks === 1);

congrats.classList.remove('show');
delete els.congratulationsModal;
delete els.congratulationsCloseBtn;
UIX.update();
check('e chiuso torna il pulsante a dire OK', UIX.btnOk.userData.label === 'OK', UIX.btnOk.userData.label);

// ── 5. Tutorial non avviato ────────────────────────────────────────────
stepIndex = -1;
drawn.length = 0;
UIX.update();
check('senza tutorial lo dice invece di restare vuoto', testo().includes('non avviato'), testo().slice(0, 40));
check('e non offre strumenti', strumenti() === '', strumenti());
check('ma la via d uscita resta: e proprio quando serve di piu',
    visibili() === 'hall', visibili());

// ── 6. Posizionamento: davanti alla testa, piu' in basso ───────────────
stepIndex = 3;
UIX.update();
world.updateMatrixWorld(true);
const p = UIX.root.position.clone();
check('sta davanti alla testa, non addosso', Math.abs(p.z - (camera.position.z - 0.60)) < 0.01,
    `z=${p.z.toFixed(2)}`);
check('e sotto la linea dello sguardo', p.y < camera.position.y - 0.1, `y=${p.y.toFixed(2)}`);
check('ma soprattutto a portata di braccio', p.distanceTo(camera.position) < 0.7,
    `${p.distanceTo(camera.position).toFixed(2)} m`);
check('e ridotto in proporzione, cosi sembra grande uguale',
    Math.abs(UIX.root.scale.x - 0.60) < 1e-6, UIX.root.scale.x.toFixed(2));

// Girando la testa il pannello insegue, ma con calma.
camera.rotation.set(0, Math.PI / 2, 0);
UIX.update();
const dopoUnFrame = UIX.root.position.clone();
check('un frame solo non lo sposta di scatto', dopoUnFrame.distanceTo(p) < 0.15,
    dopoUnFrame.distanceTo(p).toFixed(3));
for (let i = 0; i < 200; i++) UIX.update();
const aRegime = UIX.root.position.clone();
check('ma alla fine si rimette davanti', Math.abs(aRegime.x - (camera.position.x - 0.60)) < 0.02,
    `x=${aRegime.x.toFixed(2)}`);

// ── 7. I bersagli cambiano => XRInput deve rifare l'elenco ─────────────
const v0 = UIX.version;
els.infoModal.classList.add('show');
UIX.update();
check('cambiando i pulsanti cambia la versione', UIX.version > v0, `${v0} -> ${UIX.version}`);
const v1 = UIX.version;
UIX.update();
check('ma senza cambiamenti resta ferma', UIX.version === v1);

// ── 8. Nascosto non e' nemmeno premibile ───────────────────────────────
UIX.setVisible(false);
check('nascosto non offre bersagli', UIX.targets() === null);
UIX.setVisible(true);


// ── 9. Strumenti: la legenda 2D torna come colonna in-world ────────────
els.infoModal.classList.remove('show');   // il modale della prova 7 era rimasto aperto
UIX.update();      // torna in modo "step": gli strumenti riappaiono
const toolBtns = UIX.tools.map((t) => t.userData.tool.id);
check('la legenda strumenti compare in-world', toolBtns.join(',') === 'mano,spray', toolBtns.join(','));
check('e sta al fianco, dal lato opposto al fumetto',
    UIX.toolBar.position.x > 0.2 && UIX.toolBar.position.x > UIX.bubble.position.x,
    UIX.toolBar.position.x.toFixed(2));
check('inclinata come un bracciolo, non come una vetrina',
    UIX.toolBar.rotation.x < -0.5 && UIX.toolBar.rotation.x > -1.2,
    (UIX.toolBar.rotation.x * 180 / Math.PI).toFixed(0) + '°');
check('e girata verso l operatore', Math.abs(UIX.toolBar.rotation.y) > 0.2,
    (UIX.toolBar.rotation.y * 180 / Math.PI).toFixed(0) + '°');
check('e viene incontro, non resta sul piano del fumetto', UIX.toolBar.position.z > 0.1,
    UIX.toolBar.position.z.toFixed(2));
check('sono premibili insieme alle frecce',
    UIX.targets().some((b) => b.userData.xrUiAction === 'tool:spray'));

UIX._syncTools();
const spray = UIX.tools.find((t) => t.userData.tool.id === 'spray');
check('lo strumento chiesto dallo step e incorniciato', spray.userData.frame === 'false|true',
    spray.userData.frame);

UIX.activate(spray);
check('premerlo lo attiva davvero', toolCalls.join(',') === 'spray', toolCalls.join(','));
check('e la cornice passa ad attivo', spray.userData.frame === 'true|true', spray.userData.frame);

// ── 10. Media del modale: si mostra quel che core ha gia' caricato ─────
media = { tagName: 'VIDEO', videoWidth: 1920, videoHeight: 1080 };
els.infoModal.classList.add('show');
UIX.update();
check('col modale il video compare nel pannello', UIX.media.visible);
check('e usa proprio l elemento di core', UIX.media.userData.el === media);
const h = UIX.media.scale.y * (0.52 * 0.5625);
const w = UIX.media.scale.x * 0.52;
check('rispettando le proporzioni 16:9', Math.abs(w / h - 16 / 9) < 0.01, (w / h).toFixed(3));
check('e sta sopra il pannello', UIX.media.position.y > 0.12, UIX.media.position.y.toFixed(2));

media = { tagName: 'IMG', naturalWidth: 800, naturalHeight: 800, src: 'x.png', currentSrc: 'x.png' };
UIX.update();
check('un immagine quadrata resta quadrata',
    Math.abs(UIX.media.scale.x * 0.52 - UIX.media.scale.y * (0.52 * 0.5625)) < 0.001);

media = null;
els.infoModal.classList.remove('show');
UIX.update();
check('chiuso il modale il riquadro sparisce', !UIX.media.visible);


// ── 11. La finestra animata a fotogrammi ──────────────────────────────
check('senza finestra animata il riquadro sta spento', !UIX.anim.visible);

// Aperta da core, con la sua sequenza. Il pannello legge lo STATO, non il DOM:
// cosi' non c'e' alcun istante di decodifica da indovinare.
animState = { images: ['screens/mandrino/01.png', 'screens/mandrino/02.png'], currentIndex: 0 };
animVisible = true;
caricate.length = 0;
UIX.update();
check('aperta, il primo fotogramma compare', UIX.anim.visible);
check('caricato proprio quello indicato dallo stato',
    caricate.join(',') === 'screens/mandrino/01.png', caricate.join(','));
check('al centro, col fumetto che resta a sinistra',
    Math.abs(UIX.anim.position.x) < 1e-9 && UIX.bubble.position.x < -0.4,
    UIX.bubble.position.x.toFixed(2));
check('con le proporzioni del fotogramma', 
    Math.abs((UIX.anim.scale.x * 0.52) / (UIX.anim.scale.y * 0.52 * 0.5625) - 16 / 9) < 0.01);

// Avanza il fotogramma: si carica il nuovo.
animState.currentIndex = 1;
UIX.update();
check('avanzando si carica il fotogramma dopo',
    caricate.join(',') === 'screens/mandrino/01.png,screens/mandrino/02.png', caricate.join(','));

// Tornando indietro — l'animazione fa avanti e indietro — non si ricarica.
animState.currentIndex = 0;
UIX.update();
animState.currentIndex = 1;
UIX.update();
check('e i fotogrammi gia visti non si ricaricano', caricate.length === 2, String(caricate.length));

// Aperta ma senza immagini: non si mostra nulla, e non si esplode.
animState = { images: [], currentIndex: 0 };
UIX.update();
check('aperta senza immagini non mostra nulla', !UIX.anim.visible);

animVisible = false;
animState = null;
UIX.update();
check('chiusa, il riquadro sparisce', !UIX.anim.visible);

// ── 13. Il ritorno alla hall ──────────────────────────────────────────
//
// Senza, uno scenario e' un vicolo cieco: si esce solo finendo il tutorial
// o togliendosi il visore. Il documento chiede l'opposto — la navigazione
// fra Home e scenari deve restare dentro la VR.

stepIndex = 3;
UIX.update();
check('il ritorno alla hall e premibile durante lo step',
    UIX.targets().some((b) => b.userData.xrUiAction === 'hall'));
check('sta sotto la colonna degli strumenti, non accanto a OK',
    UIX.btnHall.parent === UIX.toolBar
    && UIX.btnHall.position.y < Math.min(...UIX.tools.map((t) => t.position.y)),
    UIX.btnHall.position.y.toFixed(2));

// Premerlo passa dal pulsante Home di core: e' lui a sapere cosa azzerare.
const home = mkEl('homeButton', '🏠');
UIX.activate(UIX.btnHall);
check('premerlo preme il pulsante Home di core', home.clicks === 1);
check('e non tocca i modali', els.infoModalOkBtn.clicks === 1);

// Con un modale aperto sparisce: core e' fermo su quella promise, e
// sfilarsi di lato la lascerebbe appesa.
els.infoModal.classList.add('show');
UIX.update();
check('ma con un modale aperto si fa da parte', visibili() === 'ok', visibili());
els.infoModal.classList.remove('show');
UIX.update();
check('e chiuso l avviso torna disponibile', visibili() === 'hall', visibili());

// L'etichetta segue la lingua del profilo, decisa al login.
check('l etichetta e nella lingua dell utente',
    UIX.btnHall.userData.label === 'Scenari', UIX.btnHall.userData.label);
window.currentUser = { name: 'Pluto', language: 'eng' };
check('e in inglese per un profilo inglese', UIX._hallLabel() === 'Scenarios', UIX._hallLabel());
window.currentUser = null;

// ── 14. Mai la parola «undefined» sui pulsanti ────────────────────────
// `fillText(undefined)` non fallisce: la scrive, a caratteri cubitali.
drawn.length = 0;
UIX.btnHall.userData.label = undefined;
UIX._drawButton(UIX.btnHall, false);
check('un pulsante senza etichetta resta muto, non dice "undefined"',
    !drawn.some((t) => /undefined/i.test(t)), drawn.join(' | ').slice(0, 40));
UIX.btnHall.userData.label = 'Scenari';

// ── 15. L'interfaccia sta dentro il mondo ─────────────────────────────
//
// Nasceva disegnata senza test di profondita': un pannello mangiato dalla
// lamiera e' illeggibile proprio quando serve. Ma cosi' il fumetto restava
// sopra anche alle dita che ci passavano davanti, e un oggetto che non si
// riesce a mettere dietro la propria mano non sembra un oggetto: sembra un
// adesivo attaccato alla lente.

const materiali = [];
UIX.root.traverse((o) => { if (o.material) materiali.push(o); });
check('tutti i pezzi del pannello rispettano la profondita',
    materiali.length > 0 && materiali.every((o) => o.material.depthTest === true),
    materiali.filter((o) => !o.material.depthTest).map((o) => o.name).join(',') || `${materiali.length} pezzi`);
check('ma nessuno scrive profondita: fra loro comanda renderOrder',
    materiali.every((o) => o.material.depthWrite === false));
check('e l icona dello strumento resta sopra la sua cornice',
    UIX.tools.length > 0 && UIX.tools.every((t) => t.userData.icon.renderOrder > t.renderOrder));

// Ribaltabile: dentro la macchina la pulsantiera puo' finire in un pezzo di
// lamiera, e chi prova deve poter tornare indietro senza aspettare una
// modifica al codice.
UIX.setProfondita(false);
check('e la scelta si puo ribaltare a caldo',
    materiali.every((o) => o.material.depthTest === false));
UIX.setProfondita(true);
check('e rimettere', materiali.every((o) => o.material.depthTest === true));

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
