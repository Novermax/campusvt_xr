/**
 * Prova deterministica della copertina (XRCover).
 *
 * La domanda: **il flusso del documento regge in tutti e tre gli ingressi?**
 *
 *   1. login digitato   → ENTRA è il gesto → velo via, ingresso VR tentato subito;
 *   2. sessione ripristinata da localStorage → NESSUN gesto esiste → la
 *      copertina deve restare, con il solo ENTRA (il bug visto sul Quest il
 *      2026-08-03: home 2D nuda perché il velo se ne andava da solo);
 *   3. sonda `supported` ancora in corso → il fallback deve aspettare la
 *      risposta, non leggere `null` e arrendersi.
 *
 * DOM finto, XRSession finto. La resa vera la dice solo il visore.
 */

// ── DOM finto ──────────────────────────────────────────────────────────

/** Elemento minimo: classList, figli, listener richiamabili a mano. */
function el(id) {
    const listeners = {};
    const classi = new Set();
    return {
        id,
        children: [],
        parentNode: null,
        style: {},
        textContent: '',
        disabled: false,
        classList: {
            add: (c) => classi.add(c),
            remove: (c) => classi.delete(c),
            contains: (c) => classi.has(c),
        },
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; },
        querySelector() { return this._btn || null; },
        addEventListener(tipo, fn) { (listeners[tipo] = listeners[tipo] || []).push(fn); },
        fire(tipo, ev) { (listeners[tipo] || []).forEach((fn) => fn(ev || {})); },
        focus() {},
    };
}

/** Pagina finta: copertina, slot, login di core, container. */
function pagina({ containerVisibile }) {
    const byId = {};
    for (const id of ['xrCover', 'xrCoverArt', 'xrCoverLogin', 'loginPage', 'container', 'username']) {
        byId[id] = el(id);
    }
    byId.loginPage._btn = el('btnLogin');           // il bottone del form di core
    if (!containerVisibile) byId.container.classList.add('hidden');

    const osservatori = [];
    globalThis.MutationObserver = class {
        constructor(cb) { this.cb = cb; osservatori.push(this); }
        observe() {}
        disconnect() {}
    };
    globalThis.document = {
        readyState: 'complete',
        getElementById: (id) => byId[id] || null,
        createElement: (tag) => el(tag),
        addEventListener() {},
        body: el('body'),
    };
    return { byId, osservatori };
}

/** XRSession finto: si registra cosa viene chiamato. */
function sessioneFinta({ supported }) {
    return {
        supported,
        chiamate: 0,
        esito: false,
        enterAfterLogin: async function () { this.chiamate++; return this.esito; },
    };
}

const check = (label, cond, extra = '') => {
    if (!cond) process.exitCode = 1;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.window = globalThis;

/** Ogni scenario ricarica il modulo da zero: Node non ri-esegue un import con
 *  query diversa, quindi si (ri)valuta il sorgente direttamente. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const SORGENTE = readFileSync(fileURLToPath(new URL('../xr/XRCover.js', import.meta.url)), 'utf8');
async function copertinaNuova() {
    delete globalThis.XRCover;
    (0, eval)(SORGENTE);
    return globalThis.XRCover;
}

// ── 1. Login digitato: ENTRA è il gesto, si entra subito ──────────────

{
    const { byId, osservatori } = pagina({ containerVisibile: false });
    const XS = globalThis.XRSession = sessioneFinta({ supported: true });
    XS.esito = true;

    const cover = await copertinaNuova();
    check('login: il form di core viene adottato dentro la copertina',
        byId.xrCoverLogin.children.includes(byId.loginPage));
    check('login: il bottone del form dice ENTRA', byId.loginPage._btn.textContent === 'ENTRA');

    byId.loginPage.fire('submit');                  // l'utente preme ENTRA
    byId.container.classList.remove('hidden');      // core accetta le credenziali
    osservatori.forEach((o) => o.cb());
    await attesa(20);

    check('login: il velo se ne va', byId.xrCover.classList.contains('xr-cover--gone'));
    check('login: l\'ingresso VR viene tentato una volta', XS.chiamate === 1);
    check('login: nessun ENTRA solitario aggiunto',
        !byId.xrCoverLogin.children.some((c) => c.id === 'xrCoverEnter'));
    void cover;
}

// ── 2. Sessione ripristinata: nessun gesto, la copertina resta ────────

{
    const { byId } = pagina({ containerVisibile: true });   // core ha già scoperto tutto
    const XS = globalThis.XRSession = sessioneFinta({ supported: true });
    XS.esito = true;

    await copertinaNuova();
    await attesa(20);

    check('ripristino: la copertina NON se ne va da sola',
        !byId.xrCover.classList.contains('xr-cover--gone'));
    check('ripristino: nessun ingresso VR senza gesto', XS.chiamate === 0);

    const entra = byId.xrCoverLogin.children.find((c) => c.id === 'xrCoverEnter');
    check('ripristino: compare il solo ENTRA', !!entra);
    check('ripristino: ENTRA dice ENTRA', entra && entra.textContent === 'ENTRA');

    entra.fire('click');                            // il gesto, finalmente
    await attesa(20);
    check('ripristino: al click il velo se ne va', byId.xrCover.classList.contains('xr-cover--gone'));
    check('ripristino: al click si entra in VR', XS.chiamate === 1);
}

// ── 3. Sonda in corso: il fallback aspetta la risposta, non legge null ─

{
    const { byId } = pagina({ containerVisibile: true });
    const XS = globalThis.XRSession = sessioneFinta({ supported: null });
    XS.esito = false;                               // l'ingresso fallirà

    await copertinaNuova();
    await attesa(20);
    const entra = byId.xrCoverLogin.children.find((c) => c.id === 'xrCoverEnter');
    check('sonda: ENTRA c\'è anche a sonda in corso', !!entra);

    entra.fire('click');
    await attesa(50);
    check('sonda: ingresso tentato', XS.chiamate === 1);
    check('sonda: nessun varco finché la sonda non risponde', !document.body.children.some((c) => c.id === 'xrGate'));

    XS.supported = true;                            // la sonda risponde: il visore c'è
    await attesa(250);
    check('sonda: a risposta arrivata compare il varco ENTRA IN VR',
        document.body.children.some((c) => c.id === 'xrGate'));
}
