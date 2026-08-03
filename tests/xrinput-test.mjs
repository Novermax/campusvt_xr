/**
 * Prova deterministica del magnete e del dispatch di XRInput.
 * Niente visore, niente rAF: pose finte, un frame alla volta.
 */
import * as THREE from '../core/libs/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ── Stub del runtime ────────────────────────────────────────────────
const rig = new THREE.Object3D();
const scene = new THREE.Object3D();
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 1.6, 2);
scene.add(camera);
scene.updateMatrixWorld(true);

const toolCalls = [];
const actionCalls = [];
let activeTool = null;
let stepTool = 'Mani';         // Utensile dello step corrente
let animStarted = 0;
let animUid = 0;

const fakeController = () => new THREE.Object3D();

const Scene3D = {
    renderer: { xr: { getController: fakeController, getHand: fakeController } },
    scene, camera,
    loadedModels: [],
    tutorialTracker: { interactionsBlocked: false },
    dragDropSystem: null,
    animationSystem: { activeAnimations: [], multiStepAnimations: new Map() },
    findRootModel: (m) => m.userData.root || m,
    isModelSelectable: () => true,
    getCurrentTutorialStep: () => ({ properties: { Utensile: stepTool } }),
    getRequiredToolForStep: (step) => ({
        ChiaveBrugola: 'brugola', ChiaveInglese: 'chiave_inglese',
        Mani: 'mano', Aria: 'aria', Spray: 'spray',
    })[step.properties.Utensile] || 'mano',
    handleModelAction(root) {
        actionCalls.push(root.name);
        // Come il core: esce se lo strumento non è quello richiesto.
        const required = this.getRequiredToolForStep(this.getCurrentTutorialStep());
        if (!required || activeTool !== required) return;
        animStarted++;
        this.animationSystem.multiStepAnimations.set('u' + (++animUid), {});
    },
};

globalThis.window = {
    THREE, Scene3D,
    ToolsManager: {
        getActiveTool: () => activeTool,
        toggleTool: (t) => { toolCalls.push(t); activeTool = t; },
    },
    InteractiveObject3D: { highlightedButtons: new Map(), handleClick: () => false, handleHover: () => {} },
};

// ── Carica il modulo reale ─────────────────────────────────────────
new Function(readFileSync(`${ROOT}xr/XRInput.js`, 'utf8'))();
const XI = window.XRInput;

XI.init({ rig });
const realRebuild = XI._rebuildCandidates.bind(XI);   // serve alla prova 10
XI._rebuildCandidates = () => {};          // le candidate le mettiamo noi

// Mano finta: un solo osso, per vedere dove finisce disegnata.
const handRoot = new THREE.Object3D();
const bone = new THREE.Object3D();
handRoot.add(bone);

// Bersaglio: un pannello 20×20 cm a z=0, e un secondo non richiesto dallo step.
const mkBox = (cx, cy, cz) => new THREE.Box3(
    new THREE.Vector3(cx - 0.1, cy - 0.1, cz - 0.005),
    new THREE.Vector3(cx + 0.1, cy + 0.1, cz + 0.005),
);
const porta = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.01));
porta.name = 'porta';
porta.userData.root = Object.assign(new THREE.Object3D(), { name: 'a500' });
const altro = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.01));
altro.name = 'altro';
altro.userData.root = Object.assign(new THREE.Object3D(), { name: 'b200' });

const cEvid = { mesh: porta, kind: 'evidenziato', box: mkBox(0, 1.2, 0) };
const cPlain = { mesh: altro, kind: 'interattivo', box: mkBox(1, 1.2, 0) };

// Punta finta: la piazziamo dove serve, frame per frame.
const tip = new THREE.Vector3();
XI._updateTip = (s) => {
    if (s.index !== 0) return false;
    s.tips.length = 0;
    s.tip.copy(tip);
    s.tips.push(s.tip);
    s.hasTip = true;
    return true;
};

const src = () => XI.sources[0];
const frame = (x, y, z) => { tip.set(x, y, z); XI.update(); };
/** Il pannello e' spesso 1 cm: la distanza dal bordo e' z meno mezzo spessore. */
const HALF = 0.005;
const distOf = (z) => z - HALF;
/** Stacca il dito e azzera lo stato, come dopo aver ritirato la mano. */
const reset = () => { frame(0, 1.2, 0.5); src().engaged = null; XI._unlatch(src()); src().holdOffset.set(0, 0, 0); };

// La sorgente 0 disegna la mano finta; la 1 non è connessa.
XI.sources[0].handObj.add(handRoot);
XI.sources[0].handObj.joints = { 'index-finger-tip': bone };
XI.sources[0].handModel = { root: handRoot, bones: { 'index-finger-tip': bone }, base: new THREE.Vector3() };
/** Dove finisce disegnata la mano, in coordinate mondo. */
const handDrawnZ = () => {
    rig.updateMatrixWorld(true);
    return handRoot.getWorldPosition(new THREE.Vector3()).z;
};

// ── Prove ──────────────────────────────────────────────────────────
let fails = 0;
const check = (label, cond, extra = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// 1. Distanza a cui il contatto scatta, sul bersaglio dello step.
XI.candidates = [cEvid];
let trigger = null;
for (let z = 200; z >= 0; z--) {
    const d = z / 1000;                       // 20 cm → 0, un mm per frame
    frame(0, 1.2, d);
    if (src().engaged) { trigger = d; break; }
}
check('il bersaglio dello step scatta a 1 cm esatto, non prima',
    trigger !== null && Math.abs(distOf(trigger) - 0.010) <= 0.001,
    `a ${(distOf(trigger) * 1000).toFixed(1)} mm dal bersaglio`);

// 2. Il cursore viene accompagnato sul punto, non teletrasportato.
const pull = [];
for (const d of [0.030, 0.024, 0.020]) {     // 2,5 / 1,9 / 1,5 cm dal bersaglio
    reset();
    frame(0, 1.2, d);
    const world = src().cursor.position.clone();
    rig.localToWorld(world);
    pull.push({ d, resta: world.z, w: src().snapW });
}
check('a bordo campo il cursore resta sul dito', Math.abs(pull[0].resta - 0.030) < 0.002,
    `z=${pull[0].resta.toFixed(4)}`);
check('avvicinandosi il cursore viene tirato avanti',
    pull[0].resta > pull[1].resta && pull[1].resta > pull[2].resta,
    pull.map((p) => `${(p.d * 100).toFixed(0)}cm→${(p.resta * 100).toFixed(1)}`).join(' '));
check('l attrazione cresce con continuita', pull[0].w < pull[1].w && pull[1].w < pull[2].w,
    pull.map((p) => p.w.toFixed(2)).join(' '));
check('nessun salto oltre il punto di interazione', pull.every((p) => p.resta >= 0.0049),
    'il punto sta a z=0.005');

// 3. Nessuna scorciatoia sui bersagli che lo step non chiede.
XI.candidates = [cPlain];
reset();
let trigger2 = null;
for (let z = 200; z >= 0; z--) {
    const d = z / 1000;
    frame(1, 1.2, d);
    if (src().engaged) { trigger2 = d; break; }
}
check('bersaglio non richiesto: stessa distanza di attivazione',
    trigger2 !== null && Math.abs(distOf(trigger2) - 0.010) <= 0.001, `a ${(distOf(trigger2) * 1000).toFixed(0)} mm dal bersaglio`);

// 4. Isteresi: un dito che resta appoggiato non ripete il comando.
XI.candidates = [cEvid];
reset();
let presses = 0;
const realPress = XI._press.bind(XI);
XI._press = (m, s) => { presses++; realPress(m, s); };
for (let i = 0; i < 200; i++) frame(0, 1.2, 0.014 + 0.003 * Math.sin(i));   // dito che trema sul bordo
check('un dito che trema sul bordo preme una volta sola', presses === 1, `${presses} pressioni`);

// 5. Lo strumento dello step viene equipaggiato e l azione parte.
//    Di default ora lo sceglie l'utente: qui si prova la modalita' automatica.
check('di default lo strumento lo sceglie l utente', XI.getAutoTool() === false);
XI.setAutoTool(true);
activeTool = null;
animStarted = 0;
actionCalls.length = 0;
toolCalls.length = 0;
reset();                       // stacca la mano
frame(0, 1.2, 0.0);            // tocca
check('lo strumento viene equipaggiato da solo', toolCalls[0] === 'mano', toolCalls.join(','));
check('handleModelAction riceve il modello radice', actionCalls[0] === 'a500', actionCalls.join(','));
check('l azione parte davvero', animStarted === 1, `animazioni ${animStarted}`);
check('l esito finisce nel log', !!XI.lastTouch && XI.lastTouch.ok,
    XI.lastTouch ? `${XI.lastTouch.name} → ${XI.lastTouch.esito}` : 'nessuno');

// 6. Strumento diverso (spray): equipaggiato quello giusto.
stepTool = 'Spray';
activeTool = null;
toolCalls.length = 0;
reset();
frame(0, 1.2, 0.0);
check('step con spray: equipaggia spray', toolCalls[0] === 'spray', toolCalls.join(','));

// 7. Aggancio: al contatto la mano disegnata si ferma sul punto.
stepTool = 'Mani';
XI.candidates = [cEvid];
reset();
frame(0, 1.2, 0.012);                      // contatto → aggancio
check('al contatto la mano si aggancia', !!src().latch,
    src().latch ? src().latch.cand.mesh.name : 'nessun aggancio');

/** Dove si vede il dito: posizione vera + scostamento della mano disegnata. */
const drawn = () => tip.z + handDrawnZ();

// Piccoli movimenti dentro la tolleranza: la mano NON deve seguirli.
const wobble = [];
for (const d of [0.014, 0.011, 0.017, 0.013]) { frame(0, 1.2, d); wobble.push(drawn()); }
check('dentro la tolleranza la mano resta ferma sul punto',
    wobble.every((v) => Math.abs(v - wobble[wobble.length - 1]) < 1e-4),
    wobble.map((v) => v.toFixed(4)).join(' '));
check('l aggancio regge i piccoli movimenti', !!src().latch);

// Movimento laterale oltre la tolleranza: la mano torna libera.
frame(0.05, 1.2, 0.013);
check('oltre la tolleranza l aggancio si scioglie', !src().latch);

// Restando li', senza staccarsi, non si riaggancia da solo.
for (let i = 0; i < 10; i++) frame(0.05, 1.2, 0.013);
check('non si riaggancia senza un nuovo contatto', !src().latch && !!src().engaged);

// Ritirando il dito, la mano rientra sulla posizione vera senza scatti.
const back = [];
for (let i = 0; i < 20; i++) { frame(0.05, 1.2, 0.5); back.push(src().holdOffset.length()); }
check('la mano rientra gradualmente, non di scatto',
    back[0] > 0.001 && back[0] > back[3] && back[19] < 1e-5,
    `${back[0].toFixed(4)} → ${back[3].toFixed(4)} → ${back[19].toFixed(6)}`);

// 7b. Mano e sfera si muovono INSIEME, anche solo attratte.
reset();
const insieme = [];
for (const d of [0.030, 0.024, 0.020, 0.016]) {
    frame(0, 1.2, d);
    if (!src().cursor.visible) continue;
    const sfera = src().cursor.position.clone();
    rig.localToWorld(sfera);
    insieme.push({ d, scarto: Math.abs(sfera.z - drawn()), tirata: d - sfera.z });
}
check('la sfera e la mano stanno sempre nello stesso punto',
    insieme.every((v) => v.scarto < 1e-6),
    insieme.map((v) => v.scarto.toExponential(1)).join(' '));
check('e vengono tirate verso il bersaglio insieme',
    insieme[insieme.length - 1].tirata > 0.002,
    insieme.map((v) => (v.tirata * 1000).toFixed(1) + 'mm').join(' '));

// 8. Aggancio disattivabile.
XI.setLatch(0);
reset();
frame(0, 1.2, 0.010);
check('con tolleranza 0 il dito non viene mai trattenuto', !src().latch);
XI.setLatch(0.020);

// 9. Magnete disattivabile: si torna al comportamento precedente.
XI.setSnap(undefined, 0);
reset();
let trigger3 = null;
for (let z = 200; z >= 0; z--) {
    const d = z / 1000;
    frame(0, 1.2, d);
    if (src().engaged) { trigger3 = d; break; }
}
check('con forza 0 la distanza di attivazione non cambia',
    trigger3 !== null && Math.abs(distOf(trigger3) - 0.010) <= 0.001,
    `a ${(distOf(trigger3) * 1000).toFixed(0)} mm dal bersaglio`);


// 10. I bersagli si ricostruiscono solo quando la scena cambia davvero,
//     ma i box seguono gli oggetti che si muovono.
const macchina = new THREE.Object3D();
const bottone = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.01));
bottone.name = 'Pulsante_mdi';
bottone.userData.interactive = true;
macchina.add(bottone);
scene.add(macchina);
Scene3D.loadedModels = [macchina];
window.UI = { currentStepIndex: 0 };

let collect = 0;
const realCollect = XI._collectTargets.bind(XI);
XI._collectTargets = () => { collect++; realCollect(); };

XI.candidates = [];
XI._structureSig = null;
for (let i = 0; i < 5; i++) { scene.updateMatrixWorld(true); realRebuild(); }
check('scena ferma: la struttura si ricostruisce una volta sola', collect === 1, `${collect} ricostruzioni`);
check('il bersaglio interattivo e stato trovato', XI.candidates.length === 1, `${XI.candidates.length} bersagli`);

const primaX = XI.candidates[0].box.getCenter(new THREE.Vector3()).x;
macchina.position.x = 0.5;
scene.updateMatrixWorld(true);
realRebuild();
const dopoX = XI.candidates[0].box.getCenter(new THREE.Vector3()).x;
check('ma il box segue l oggetto che si muove', Math.abs(dopoX - primaX - 0.5) < 1e-6,
    `${primaX.toFixed(2)} -> ${dopoX.toFixed(2)}`);
check('senza ricostruire la struttura', collect === 1, `${collect} ricostruzioni`);

const boxPrima = XI.candidates[0].box;
window.UI.currentStepIndex = 1;
realRebuild();
check('cambiando step si ricostruisce', collect === 2, `${collect} ricostruzioni`);
check('e i box vengono riusati, non riallocati', XI.candidates[0].box === boxPrima);


// 11. Un gestore che lancia non deve far cadere il frame: in Three il loop
//     chiede il frame successivo DOPO la callback, quindi un'eccezione qui
//     ucciderebbe la sessione e il visore resterebbe congelato.
XI.candidates = [cEvid];
Scene3D.loadedModels = [];
const azioneVera = Scene3D.handleModelAction.bind(Scene3D);
Scene3D.handleModelAction = () => { throw new Error('core esplode'); };
reset();
let esploso = false;
try { frame(0, 1.2, 0.0); } catch (e) { esploso = true; }
check('un gestore che lancia non propaga fuori dal frame', !esploso);
check('e l errore finisce nell ultimo tocco',
    !!XI.lastTouch && !XI.lastTouch.ok && XI.lastTouch.esito.includes('core esplode'),
    XI.lastTouch ? XI.lastTouch.esito : 'nessuno');

// Il frame dopo continua a funzionare.
Scene3D.handleModelAction = azioneVera;
reset();
frame(0, 1.2, 0.0);
check('il frame successivo funziona di nuovo', !!XI.lastTouch && XI.lastTouch.ok,
    XI.lastTouch ? XI.lastTouch.esito : 'nessuno');


// 12. Il segno di contatto ha tre modi, e nessuno tocca la logica.
XI.setSnap(undefined, 0.95);          // la prova 9 aveva spento il magnete
XI.candidates = [cEvid];
XI.setCursorMode('sfera');
reset();
frame(0, 1.2, 0.020);
check('modo sfera: pallina sul dito', src().cursor.visible && !src().dot.visible);

XI.setCursorMode('punto');
reset();
frame(0, 1.2, 0.020);
check('modo punto: niente pallina, disco sul bersaglio',
    !src().cursor.visible && src().dot.visible);
const dotW = src().dot.position.clone();
rig.localToWorld(dotW);
check('e il disco sta sul bersaglio, non sul dito',
    Math.abs(dotW.z - 0.005) < 1e-6, `z=${dotW.z.toFixed(4)}`);
check('con opacita che cresce avvicinandosi', src().dot.material.opacity > 0.28,
    src().dot.material.opacity.toFixed(2));

XI.setCursorMode('niente');
reset();
frame(0, 1.2, 0.020);
check('modo niente: nessun segno', !src().cursor.visible && !src().dot.visible);
check('ma la mano continua a essere guidata', src().holdOffset.length() > 0.001,
    src().holdOffset.length().toFixed(4));
frame(0, 1.2, 0.0);
check('e il contatto funziona in tutti e tre i modi', !!src().engaged);
XI.setCursorMode('sfera');

// 13. I pulsanti del pannello in-world si premono come tutto il resto.
const uiMesh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.075, 0.005));
uiMesh.name = 'XRUI_next';
uiMesh.userData.xrUiAction = 'next';
const cUi = { mesh: uiMesh, kind: 'ui', box: mkBox(0, 1.2, 0) };
const premuti = [];
window.XRUI = {
    version: 1,
    targets: () => [uiMesh],
    activate: (m) => { premuti.push(m.userData.xrUiAction); return true; },
    update: () => {},
};

XI.candidates = [cUi];
reset();
frame(0, 1.2, 0.020);
check('anche il pannello gode dell assistenza magnetica', src().snapW > 0,
    src().snapW.toFixed(2));

let ui = null;
for (let z = 200; z >= 0; z--) {
    const d = z / 1000;
    frame(0, 1.2, d);
    if (src().engaged) { ui = d; break; }
}
check('e si attiva alla stessa distanza degli altri', ui !== null && Math.abs(distOf(ui) - 0.010) <= 0.001,
    `a ${(distOf(ui) * 1000).toFixed(1)} mm`);
check('la pressione va al pannello, non ai modelli', premuti.join(',') === 'next', premuti.join(','));
check('e l esito lo dice', !!XI.lastTouch && XI.lastTouch.esito.includes('pannello'),
    XI.lastTouch ? XI.lastTouch.esito : '-');

// 13b. A tutorial finito la scena si congela, il pannello no.
//      `interactionsBlocked` spegneva OGNI sorgente: il messaggio di fine
//      restava li' con il suo pulsante e nessun modo di premerlo.
const modello = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.075, 0.005));
modello.userData.interactive = true;
const cModello = { mesh: modello, kind: 'interattivo', box: mkBox(0, 1.2, 0) };

Scene3D.tutorialTracker.interactionsBlocked = true;
XI.candidates = [cModello];
reset();
frame(0, 1.2, 0.0);
check('a tutorial finito la macchina non si tocca piu', !src().engaged);

XI.candidates = [cUi];
reset();
frame(0, 1.2, 0.0);
check('ma il pannello resta premibile, o non si esce piu', !!src().engaged);
Scene3D.tutorialTracker.interactionsBlocked = false;

delete window.XRUI;


// 14. Lo step con utensile: nessun trigger fisico, quindi senza _stepElement
//     non ci sarebbe NULLA da toccare — ed e' li' che il tutorial si fermava.
const macchina2 = new THREE.Object3D();
macchina2.name = 'a500';
const naso = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05));
naso.name = 'naso';
macchina2.add(naso);
macchina2.position.set(0, 1.2, 0);      // ad altezza mano, come gli altri bersagli
scene.add(macchina2);
scene.updateMatrixWorld(true);
Scene3D.loadedModels = [macchina2];
Scene3D.findModelByName = (n) => (n === 'a500' ? macchina2 : null);

window.UI = {
    currentStepIndex: 0,
    tutorialSteps: [{
        title: 'Ingrassa con lo spray',
        properties: { Elemento: 'models/a500.glb', TargetChild: 'naso', Utensile: 'Spray' },
    }],
};
window.InteractiveObject3D.highlightedButtons = new Map();

XI.candidates = [];
XI._structureSig = null;
realRebuild();
check('l elemento dello step diventa toccabile', XI.candidates.length === 1, `${XI.candidates.length}`);
check('ed e proprio il child indicato', XI.candidates[0].mesh.name === 'naso', XI.candidates[0].mesh.name);
check('e gode dell assistenza, come i pulsanti', XI.candidates[0].kind === 'evidenziato');

// Uno step automatico invece NON deve essere premibile in anticipo.
window.UI.tutorialSteps[0].properties.AutoExecute = 'true';
XI._structureSig = null;
realRebuild();
check('gli step automatici restano fuori', XI.candidates.length === 0, `${XI.candidates.length}`);
delete window.UI.tutorialSteps[0].properties.AutoExecute;

// 15. Lo strumento automatico si puo' spegnere: allora sbagliare conta.
XI._structureSig = null;
realRebuild();
stepTool = 'Spray';
activeTool = 'mano';                 // strumento sbagliato in mano
animStarted = 0;
XI.setAutoTool(false);
reset();
frame(0, 1.2, 0.0);
check('con scelta manuale lo strumento sbagliato non fa nulla', animStarted === 0);
check('e non viene equipaggiato di nascosto', activeTool === 'mano', activeTool);
XI.setAutoTool(true);
reset();
frame(0, 1.2, 0.0);
check('riacceso, equipaggia e l azione parte', animStarted === 1 && activeTool === 'spray',
    `${activeTool}, ${animStarted}`);


// 16. La mano che regge il telecomando non ne preme i pulsanti.
//     Prendendolo, palmo e pollice finiscono DENTRO la sua geometria, a un
//     centimetro dai suoi stessi tasti: senza questa regola la presa faceva
//     partire da sola la sequenza di cambio utensile.
const ancora = new THREE.Object3D();          // XRHold appende qui l'oggetto
const remote = new THREE.Object3D();
remote.name = 'remote';
const play = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.005));
play.name = 'pulsante_r_play';
remote.add(play);
ancora.add(remote);
ancora.position.set(0, 1.2, 0);
scene.add(ancora);
scene.updateMatrixWorld(true);

window.XRHold = { getHand: () => 'left', getAnchor: () => ancora };
window.InteractiveObject3D.highlightedButtons = new Map([['remote.pulsante_r_play', play]]);
window.UI = { currentStepIndex: 0, tutorialSteps: [{ title: 'start', properties: {} }] };
Scene3D.loadedModels = [];

XI.candidates = [];
XI._structureSig = null;
realRebuild();
check('il tasto del telecomando resta un bersaglio', XI.candidates.length === 1);
check('ma marcato come "in mano"', XI.candidates[0].held === true);

// La sinistra, che lo regge, ha il palmo addosso al tasto: non deve premerlo.
XI.sources[0].hand = 'left';
reset();
frame(0, 1.2, 0.0);
check('la mano che regge non lo preme', !src().engaged);

// La destra invece si', ed e' il gesto vero.
XI.sources[0].hand = 'right';
reset();
frame(0, 1.2, 0.0);
check('l altra mano lo preme', !!src().engaged);
delete window.XRHold;

console.log(fails ? `\n${fails} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(fails ? 1 : 0);
