/**
 * Prova deterministica dello shim del rAF di pagina (XRSession._shimPageRaf).
 *
 * Il fatto da difendere: dentro una sessione immersiva il browser congela
 * `window.requestAnimationFrame`, e `core/` lo usa come "appena puoi" — la
 * consegna dei modelli caricati (modelloader.js, `onComplete`) sta proprio lì.
 * Senza ripiego, scenario vuoto per sempre sul Quest (visto il 2026-08-03).
 *
 * Qui si verifica solo la meccanica dello shim: fuori sessione delega al rAF
 * nativo, in sessione ripiega su timer, l'annullamento funziona in entrambi
 * gli spazi, e installarlo due volte non avvolge due volte.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const check = (label, cond, extra = '') => {
    if (!cond) process.exitCode = 1;
    console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stub minimi: il modulo al top-level tocca solo window/document ─────
globalThis.window = globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.document = { readyState: 'complete', addEventListener() {}, getElementById: () => null };
// `navigator` in Node è un getter globale già senza `.xr`: la sonda dirà "no" da sé.

const chiamateNative = [];
globalThis.requestAnimationFrame = (cb) => { chiamateNative.push(cb); return 9001; };
const annullateNative = [];
globalThis.cancelAnimationFrame = (id) => { annullateNative.push(id); };

const SORGENTE = readFileSync(fileURLToPath(new URL('../xr/XRSession.js', import.meta.url)), 'utf8');
(0, eval)(SORGENTE);
const XS = globalThis.XRSession;

XS.isPresenting = false;
XS._shimPageRaf();

// ── Fuori sessione: delega al nativo, nessun timer ─────────────────────
{
    const id = window.requestAnimationFrame(() => {});
    check('fuori sessione: delega al rAF nativo', chiamateNative.length === 1 && id === 9001);
}

// ── In sessione: la callback gira comunque, via timer ──────────────────
{
    XS.isPresenting = true;
    let girata = 0; let tempo = -1;
    window.requestAnimationFrame((t) => { girata++; tempo = t; });
    check('in sessione: nessuna chiamata al rAF nativo (sarebbe congelato)', chiamateNative.length === 1);
    await attesa(60);
    check('in sessione: la callback gira via timer', girata === 1);
    check('in sessione: riceve un timestamp', tempo >= 0);
}

// ── Annullamento: vale per entrambi gli spazi di id ────────────────────
{
    let girata = false;
    const id = window.requestAnimationFrame(() => { girata = true; });
    window.cancelAnimationFrame(id);
    await attesa(60);
    check('cancel: il timer in sessione viene annullato', !girata);
    check('cancel: inoltrato anche al nativo (id dell\'altro spazio)', annullateNative.length > 0);
}

// ── Idempotente: installare due volte non avvolge due volte ────────────
{
    const wrapped = window.requestAnimationFrame;
    XS._shimPageRaf();
    check('idempotente: seconda installazione non riavvolge', window.requestAnimationFrame === wrapped);
}

// Il modulo al top-level arma timer propri (init ritardato + polling della
// scena): senza uscita esplicita il processo resterebbe appeso.
process.exit(process.exitCode || 0);
