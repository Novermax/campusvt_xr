/**
 * XRSession.js — bootstrap del layer WebXR di Campus Virtual Training.
 *
 * MILESTONE 0 (stato attuale): sonda di capability.
 *   Verifica che il sito appiattito giri con `core/` e riporta se il browser
 *   espone `navigator.xr` con supporto `immersive-vr`. Non apre ancora nessuna
 *   sessione: serve a validare setup, deploy e visore prima di scrivere codice XR.
 *
 * MILESTONE 1 (prossima): `enterVR()` accenderà davvero la sessione
 *   (renderer.xr.enabled, setAnimationLoop, XRRig) — vedi i TODO in fondo.
 *
 * VINCOLO ARCHITETTURALE: questo file non modifica mai `core/`. Tutti i moduli
 * di CVT sono singleton su `window.*` e vengono avvolti dall'esterno, esattamente
 * come fa già `core/js/touch/` con gli handler del mouse.
 *
 * CICLO DI VITA — punto verificato in Milestone 0, importante per la Milestone 1:
 *   `Scene3D` NON esiste al boot. `Scene3D.init()` viene chiamato solo quando si
 *   apre la pagina scenario (core/js/ui.js:442, core/js/ui/PageManager.js:158,
 *   core/js/ui/UICore.js:194). Quindi renderer, scena e camera compaiono *dopo*
 *   l'evento `app:initialized`. Ogni patch che tocchi il renderer deve passare
 *   da `whenSceneReady()`, mai agganciarsi al solo boot dell'app.
 */

(function () {
    'use strict';

    const XRSession = {
        version: '0.1.0-m0',

        /** Esito della sonda: null = non ancora eseguita. */
        supported: null,
        /** true se il browser espone del tutto l'API WebXR. */
        hasApi: false,
        /** true quando una sessione immersiva è attiva (Milestone 1). */
        isPresenting: false,

        _badge: null,
        _probeResult: null,

        init: async function () {
            console.log(`[XR] Layer WebXR v${this.version} — inizializzazione`);

            const res = await this.probe();
            this._probeResult = res;
            this._renderBadge(res);
            this._logDiagnostics(res, 'boot');

            // La scena 3D nasce più tardi (vedi nota sul ciclo di vita in testa al
            // file): rifacciamo la diagnostica quando c'è davvero un renderer, così
            // il log dice qualcosa di utile su renderer.xr.
            this.whenSceneReady().then((ready) => {
                if (ready) this._logDiagnostics(res, 'scena pronta');
            });
        },

        /**
         * Sonda le capability WebXR del browser corrente.
         * @returns {Promise<{hasApi:boolean, supported:boolean, reason:string}>}
         */
        probe: async function () {
            if (!('xr' in navigator) || !navigator.xr) {
                this.hasApi = false;
                this.supported = false;
                return { hasApi: false, supported: false, reason: 'navigator.xr assente' };
            }
            this.hasApi = true;

            try {
                const ok = await navigator.xr.isSessionSupported('immersive-vr');
                this.supported = ok;
                return {
                    hasApi: true,
                    supported: ok,
                    reason: ok ? 'immersive-vr disponibile' : 'immersive-vr non supportato su questo dispositivo',
                };
            } catch (err) {
                this.supported = false;
                return { hasApi: true, supported: false, reason: `isSessionSupported ha fallito: ${err.message}` };
            }
        },

        /**
         * Risolve quando `Scene3D` ha renderer, scena e camera pronti.
         * Il polling è coerente con il resto del codebase, che non emette eventi
         * per questa transizione.
         * @param {number} timeoutMs abbandona dopo questo tempo (default 10 min:
         *        l'utente potrebbe restare fermo sulla pagina di login).
         * @returns {Promise<boolean>} false se scaduto il timeout.
         */
        whenSceneReady: function (timeoutMs = 600000) {
            return new Promise((resolve) => {
                const deadline = Date.now() + timeoutMs;
                const check = () => {
                    const S = window.Scene3D;
                    if (S && S.isInitialized && S.renderer && S.scene && S.camera) return resolve(true);
                    if (Date.now() > deadline) return resolve(false);
                    setTimeout(check, 250);
                };
                check();
            });
        },

        /** Riepilogo in console: la si legge via chrome://inspect col Quest in USB debug. */
        _logDiagnostics: function (res, phase) {
            const S = window.Scene3D;
            const rows = {
                'WebXR API': res.hasApi ? 'sì' : 'NO',
                'immersive-vr': res.supported ? 'sì' : 'NO',
                'motivo': res.reason,
                'contesto sicuro': window.isSecureContext ? 'sì (https/localhost)' : 'NO — WebXR richiede HTTPS',
                'Three.js': window.THREE ? `r${window.THREE.REVISION}` : 'non caricato',
                'Scene3D': S && S.isInitialized ? 'inizializzato' : 'non ancora (si apre con la pagina scenario)',
                'renderer.xr': S && S.renderer && S.renderer.xr ? 'presente' : 'assente',
                'TouchSystem': window.TouchSystem && window.TouchSystem.initialized ? 'attivo' : 'inattivo',
                'user agent': navigator.userAgent,
            };
            console.groupCollapsed(`[XR] Diagnostica capability — ${phase}`);
            for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(18)} ${v}`);
            console.groupEnd();
        },

        /** Badge d'angolo: permette di leggere l'esito sul visore, senza cavo. */
        _renderBadge: function (res) {
            const el = document.createElement('div');
            el.className = 'xr-badge ' + (res.supported ? 'xr-badge--ok' : 'xr-badge--ko');
            el.textContent = res.supported
                ? '🥽 WebXR pronto (Milestone 0)'
                : `🥽 WebXR non disponibile — ${res.reason}`;
            el.title = 'Sonda capability del layer XR. Tocca per nascondere.';
            el.addEventListener('click', () => el.remove());
            document.body.appendChild(el);
            this._badge = el;
        },

        // -------------------------------------------------------------------
        // TODO Milestone 1 — apertura sessione immersiva:
        //   • await whenSceneReady() prima di toccare il renderer
        //   • renderer.xr.enabled = true
        //   • sostituire il loop di core/js/scene3d-modular.js:4105
        //     (requestAnimationFrame) con renderer.setAnimationLoop
        //   • XRRig: THREE.Group contenitore della camera, per la locomozione
        //   • disattivare TouchSystem all'ingresso in XR (il Quest Browser lo
        //     attiva perché la UA contiene "Mobile")
        // -------------------------------------------------------------------
    };

    window.XRSession = XRSession;

    // `app:initialized` è emesso da core/js/app.js:570 a fine boot.
    // Fallback su DOMContentLoaded: la sonda deve rispondere anche se il boot
    // di core fallisce — è proprio il caso che vogliamo poter diagnosticare.
    let started = false;
    const start = () => {
        if (started) return;
        started = true;
        XRSession.init();
    };

    window.addEventListener('app:initialized', start);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(start, 2000));
    } else {
        setTimeout(start, 2000);
    }
})();
