/**
 * XRSession.js — sessione WebXR immersiva per Campus Virtual Training.
 *
 * MILESTONE 1: apre `immersive-vr`, rende in stereo con testa tracciata, esce
 * pulito. Nessun controller ancora (Milestone 3): qui si guarda soltanto.
 *
 * VINCOLO ARCHITETTURALE: non modifica mai `core/`. Tutti i moduli di CVT sono
 * singleton su `window.*` e vengono avvolti dall'esterno, come fa già
 * `core/js/touch/` con gli handler del mouse.
 *
 * CICLO DI VITA — `Scene3D` NON esiste al boot: `Scene3D.init()` parte quando si
 * apre la pagina scenario (core/js/ui.js:442, core/js/ui/PageManager.js:158,
 * core/js/ui/UICore.js:194). Renderer, scena e camera compaiono quindi *dopo*
 * `app:initialized`. Ogni patch al renderer passa da `whenSceneReady()`.
 *
 * LOOP DI RENDER — WebXR non può girare su `requestAnimationFrame`: i frame
 * devono venire da `XRSession.requestAnimationFrame`, cioè da
 * `renderer.setAnimationLoop()`. Il loop legacy sta in
 * core/js/scene3d-modular.js:4105 ed è una closure che si ri-accoda da sola,
 * senza flag di stop. Lo neutralizziamo avvolgendo `Scene3D.render` (vedi
 * `_takeOverRenderLoop`). Il takeover scatta solo al primo ingresso in VR:
 * finché si resta sul desktop il comportamento di core è identico a prima.
 */

(function () {
    'use strict';

    /** Altezza occhi di ripiego se il visore non concede `local-floor`. */
    const FALLBACK_EYE_HEIGHT = 1.6;

    const XRSession = {
        version: '1.0.0-m1',

        /* --- capability --- */
        hasApi: false,
        supported: null,

        /* --- stato sessione --- */
        isPresenting: false,
        session: null,
        rig: null,
        referenceSpaceType: null,

        /* --- interni --- */
        _probeResult: null,
        _loopOwned: false,
        _originalRender: null,
        _inFrame: false,
        _cameraRestore: null,
        _touchWasEnabled: null,
        _listeners: { enter: [], exit: [] },

        // =====================================================================
        // Avvio
        // =====================================================================

        init: async function () {
            console.log(`[XR] Layer WebXR v${this.version} — inizializzazione`);

            const res = await this.probe();
            this._probeResult = res;
            this._logDiagnostics(res, 'boot');

            const ready = await this.whenSceneReady();
            if (!ready) {
                console.warn('[XR] Scena non pronta: nessuno scenario aperto. Layer XR in attesa.');
                return;
            }
            this._logDiagnostics(res, 'scena pronta');

            if (window.XRButton) window.XRButton.mount(this, res);
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
         * Risolve quando `Scene3D` ha renderer, scena e camera pronti. Il polling
         * è coerente col resto del codebase, che non emette eventi per questa
         * transizione.
         * @param {number} timeoutMs default 10 min: l'utente può restare fermo sul login.
         * @returns {Promise<boolean>} false se scaduto.
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

        // =====================================================================
        // Ingresso / uscita dalla sessione
        // =====================================================================

        /**
         * Apre la sessione immersiva.
         * @returns {Promise<boolean>} true se la sessione è partita.
         */
        enterVR: async function () {
            if (this.isPresenting) return true;
            if (!this.supported) {
                console.warn('[XR] enterVR ignorato: immersive-vr non supportato.');
                return false;
            }

            const S = window.Scene3D;
            if (!S || !S.renderer) {
                console.warn('[XR] enterVR ignorato: Scene3D non inizializzato.');
                return false;
            }

            let session;
            try {
                session = await navigator.xr.requestSession('immersive-vr', {
                    // Tutte opzionali: se il visore ne nega una la sessione parte comunque.
                    // `local-floor` è quella che conta — allinea y=0 al pavimento fisico,
                    // così la macchina virtuale sta all'altezza giusta.
                    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
                });
            } catch (err) {
                console.error('[XR] requestSession fallita:', err.message);
                return false;
            }

            try {
                this._takeOverRenderLoop();
                this._attachRig();

                const renderer = S.renderer;
                renderer.xr.enabled = true;
                try {
                    renderer.xr.setReferenceSpaceType('local-floor');
                    this.referenceSpaceType = 'local-floor';
                } catch (e) {
                    renderer.xr.setReferenceSpaceType('local');
                    this.referenceSpaceType = 'local';
                    console.warn('[XR] local-floor non disponibile, uso local con offset occhi.');
                }

                await renderer.xr.setSession(session);

                this.session = session;
                this.isPresenting = true;
                session.addEventListener('end', this._onSessionEnd.bind(this), { once: true });

                this._suspendTouchSystem();
                this._placeRigAtCamera();

                console.log(`[XR] ✅ Sessione immersiva attiva (reference space: ${this.referenceSpaceType})`);
                this._emit('enter');
                return true;
            } catch (err) {
                console.error('[XR] Avvio sessione fallito:', err.message);
                try { await session.end(); } catch (e) { /* già chiusa */ }
                return false;
            }
        },

        /** Chiude la sessione immersiva. Il cleanup avviene in `_onSessionEnd`. */
        exitVR: async function () {
            const s = this.session || (window.Scene3D?.renderer?.xr?.getSession?.());
            if (!s) return;
            try { await s.end(); } catch (err) { console.warn('[XR] end() ha fallito:', err.message); }
        },

        /** Cleanup: scatta sia su exitVR() sia se l'utente esce dal menu del visore. */
        _onSessionEnd: function () {
            this.isPresenting = false;
            this.session = null;
            this._detachRig();
            this._restoreTouchSystem();
            // Il loop resta nostro (setAnimationLoop continua a girare via rAF):
            // riprenderlo ogni volta rischierebbe due loop concorrenti.
            console.log('[XR] Sessione terminata, ritorno alla vista desktop.');
            this._emit('exit');
        },

        // =====================================================================
        // Loop di render
        // =====================================================================

        /**
         * Prende possesso del loop, una volta sola e in modo permanente.
         *
         * Il loop legacy è una closure ricorsiva senza stop (scene3d-modular.js:4105):
         * non si può spegnere, ma si può rendere innocuo. Avvolgiamo `Scene3D.render`
         * così che disegni solo se chiamato da dentro il nostro frame; il rAF legacy
         * continua a girare a vuoto, a costo trascurabile.
         *
         * Non lo rilasciamo all'uscita dalla VR: `setAnimationLoop` funziona anche
         * fuori sessione (usa rAF), mentre restituire il controllo al loop legacy
         * rischierebbe due loop concorrenti o nessuno, se il browser ha scartato il
         * rAF pendente durante la sessione immersiva.
         */
        _takeOverRenderLoop: function () {
            if (this._loopOwned) return;
            const S = window.Scene3D;
            const original = S.render.bind(S);
            this._originalRender = original;

            const self = this;
            S.render = function () {
                if (!self._inFrame) return; // zittisce il loop legacy e le chiamate dirette
                original();
            };

            S.renderer.setAnimationLoop(function () {
                self._inFrame = true;
                try { original(); } finally { self._inFrame = false; }
            });

            this._loopOwned = true;
            console.log('[XR] Loop di render passato a renderer.setAnimationLoop (richiesto da WebXR).');
        },

        // =====================================================================
        // XRRig — il "corpo" del giocatore
        // =====================================================================

        /**
         * In Three.js la posa del visore è assoluta dentro il reference space: per
         * spostare l'utente si sposta il *genitore* della camera. Quel genitore è
         * il rig, che dalla Milestone 7 sarà mosso dal teleport.
         *
         * Il reparent avviene solo entrando in VR e viene annullato all'uscita, così
         * la camera desktop torna esattamente com'era.
         */
        _attachRig: function () {
            const S = window.Scene3D;
            const THREE = window.THREE;
            if (this.rig) return;

            const rig = new THREE.Group();
            rig.name = 'XRRig';

            // La camera di CVT è già figlia di Scene. Salviamo la posa locale per il
            // ripristino e quella mondo per il posizionamento del rig: coincidono
            // finché Scene resta a identità, ma non vogliamo dipendere da questo.
            S.camera.updateMatrixWorld(true);
            this._cameraRestore = {
                parent: S.camera.parent,
                position: S.camera.position.clone(),
                quaternion: S.camera.quaternion.clone(),
                worldPosition: S.camera.getWorldPosition(new THREE.Vector3()),
                worldQuaternion: S.camera.getWorldQuaternion(new THREE.Quaternion()),
            };

            rig.add(S.camera);
            S.scene.add(rig);
            this.rig = rig;
        },

        _detachRig: function () {
            const S = window.Scene3D;
            if (!this.rig) return;

            this.rig.remove(S.camera);
            S.scene.remove(this.rig);

            const r = this._cameraRestore;
            if (r) {
                if (r.parent) r.parent.add(S.camera);
                S.camera.position.copy(r.position);
                S.camera.quaternion.copy(r.quaternion);
                S.camera.updateMatrixWorld(true);
            }

            this.rig = null;
            this._cameraRestore = null;
        },

        /**
         * Posiziona il rig dove stava la camera desktop, proiettata a terra e con
         * lo stesso orientamento orizzontale.
         *
         * Riusa già ora i dati `CameraPos`/`CameraTarget` dei tutorial: entrare in VR
         * da uno step ti mette esattamente dove guardava quello step. È il primo
         * mattone della locomozione della Milestone 7, dove le stesse posizioni
         * diventeranno postazioni di teleport.
         */
        _placeRigAtCamera: function () {
            const S = window.Scene3D;
            const THREE = window.THREE;
            const r = this._cameraRestore;
            if (!this.rig || !r) return;

            // Posa desktop salvata prima del reparent: quella corrente è già del visore.
            const pos = r.worldPosition;
            const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(r.worldQuaternion);

            this.rig.position.set(pos.x, 0, pos.z);

            // Se manca local-floor, y=0 coincide con la testa: abbassiamo il rig
            // dell'altezza occhi, altrimenti si finisce sospesi.
            if (this.referenceSpaceType !== 'local-floor') {
                this.rig.position.y = -FALLBACK_EYE_HEIGHT;
            }

            // Ruota il rig perché il suo -Z (avanti) segua la direzione orizzontale
            // di sguardo della camera desktop.
            const horiz = Math.hypot(dir.x, dir.z);
            if (horiz > 1e-6) this.rig.rotation.y = Math.atan2(-dir.x, -dir.z);

            this.rig.updateMatrixWorld(true);
            console.log(`[XR] Rig posizionato a (${this.rig.position.x.toFixed(2)}, ${this.rig.position.y.toFixed(2)}, ${this.rig.position.z.toFixed(2)})`);
        },

        // =====================================================================
        // Convivenza con il sistema touch
        // =====================================================================

        /**
         * Il Quest Browser espone una UA che contiene "Mobile", quindi core attiva
         * TouchSystem (core/index.html:546-563). In sessione immersiva i suoi
         * gesti non hanno senso e ruberebbero gli input: lo sospendiamo, e lo
         * ripristiniamo com'era all'uscita.
         */
        _suspendTouchSystem: function () {
            const T = window.TouchSystem;
            if (!T || typeof T.setEnabled !== 'function') return;
            this._touchWasEnabled = T.enabled !== undefined ? T.enabled : T.initialized;
            T.setEnabled(false);
            console.log('[XR] TouchSystem sospeso per la durata della sessione.');
        },

        _restoreTouchSystem: function () {
            const T = window.TouchSystem;
            if (!T || typeof T.setEnabled !== 'function') return;
            if (this._touchWasEnabled) T.setEnabled(true);
            this._touchWasEnabled = null;
        },

        // =====================================================================
        // Eventi
        // =====================================================================

        /** @param {'enter'|'exit'} evt */
        on: function (evt, fn) {
            if (this._listeners[evt]) this._listeners[evt].push(fn);
        },

        _emit: function (evt) {
            (this._listeners[evt] || []).forEach((fn) => {
                try { fn(this); } catch (e) { console.error(`[XR] listener ${evt}:`, e); }
            });
        },

        // =====================================================================
        // Diagnostica
        // =====================================================================

        /** Riepilogo in console: leggibile via chrome://inspect col Quest in USB debug. */
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
                'loop': this._loopOwned ? 'setAnimationLoop (XR)' : 'requestAnimationFrame (legacy core)',
                'TouchSystem': window.TouchSystem && window.TouchSystem.initialized ? 'attivo' : 'inattivo',
                'user agent': navigator.userAgent,
            };
            console.groupCollapsed(`[XR] Diagnostica — ${phase}`);
            for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(18)} ${v}`);
            console.groupEnd();
        },

        /** Stato sintetico, comodo da chiamare a mano dalla console. */
        debugInfo: function () {
            const S = window.Scene3D;
            const info = {
                versione: this.version,
                supported: this.supported,
                isPresenting: this.isPresenting,
                referenceSpace: this.referenceSpaceType,
                loopOwned: this._loopOwned,
                rig: this.rig ? this.rig.position.toArray().map((n) => +n.toFixed(2)) : null,
                triangoli: S?.renderer?.info?.render?.triangles ?? null,
                drawCalls: S?.renderer?.info?.render?.calls ?? null,
            };
            console.table(info);
            return info;
        },
    };

    window.XRSession = XRSession;

    // `app:initialized` è emesso da core/js/app.js:570 a fine boot. Il fallback su
    // DOMContentLoaded serve perché la sonda deve rispondere anche se il boot di
    // core fallisce: è proprio il caso che vogliamo poter diagnosticare.
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
