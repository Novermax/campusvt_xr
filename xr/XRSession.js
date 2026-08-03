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

    /** Chiave localStorage dell'altezza occhi scelta dall'operatore. */
    const EYE_HEIGHT_KEY = 'cvtxr.eyeHeight';

    /** Chiave localStorage del fattore di scala del mondo. */
    const WORLD_SCALE_KEY = 'cvtxr.worldScale';

    /** Limiti del fattore di scala: oltre questi la stereoscopia diventa sgradevole. */
    const SCALE_MIN = 0.5;
    const SCALE_MAX = 4.0;

    /**
     * Scala di partenza, tarata sul Quest 3 con lo scenario Elettromandrino: alla
     * metrica nativa dei GLB la macchina risulta miniaturizzata, e 1,25 è il valore
     * a cui la proporzione con l'operatore torna credibile.
     *
     * Implica una macchina percepita di 2,80 × 1,25 = 3,50 m. Se è questa la
     * quota reale della a500, la correzione andrebbe prima o poi fatta a monte
     * sui modelli, non compensata qui sull'osservatore.
     */
    const DEFAULT_WORLD_SCALE = 1.25;

    /** Azzurro chiaro dello sfondo in sessione. Vedi `_applySkyBackground`. */
    const SKY_COLOR = 0xbfe0f5;

    /** Regolazione dal vivo col thumbstick: soglia, velocità, granularità del feedback. */
    const STICK_DEADZONE = 0.2;
    const SCALE_RATE_PER_SEC = 0.4;
    const HAPTIC_STEP = 0.1;

    /** Frame di posa da mediare prima di calibrare, ~0,3 s a 72 Hz. */
    const CALIBRATION_SAMPLES = 20;

    /** Scratch riusato nel loop per non allocare a ogni frame. THREE arriva tardi
     *  (lo importa core/js/app.js come ES module), quindi si crea al primo uso. */
    let _tmpVec = null;

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
        _listeners: { enter: [], exit: [], scale: [] },
        _rigBaseY: 0,
        _headSamples: [],
        _calibrated: false,
        _lastTuneTime: null,
        _lastHapticStep: null,
        _worldScale: null,
        _tuning: false,
        /** Ultima altezza occhi misurata dal visore, in metri. Diagnostica. */
        measuredEyeHeight: null,

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
         *
         * Se la scena non c'è ancora la crea, invece di aspettarla: `core/`
         * chiama `Scene3D.init()` solo aprendo la pagina scenario, quindi stando
         * in home non esisterebbe mai — e senza scena non c'è pulsante VR, e
         * senza pulsante VR non si può entrare nella hall. Vedi `_initScene`.
         *
         * @param {number} timeoutMs default 10 min: l'utente può restare fermo sul login.
         * @returns {Promise<boolean>} false se scaduto.
         */
        whenSceneReady: function (timeoutMs = 600000) {
            return new Promise((resolve) => {
                const deadline = Date.now() + timeoutMs;
                const check = () => {
                    const S = window.Scene3D;
                    if (S && S.isInitialized && S.renderer && S.scene && S.camera) return resolve(true);
                    if (this._initScene()) return check();
                    if (Date.now() > deadline) return resolve(false);
                    setTimeout(check, 250);
                };
                check();
            });
        },

        /**
         * Crea la scena 3D senza aspettare che si apra uno scenario.
         *
         * `core/` chiama `Scene3D.init()` solo all'apertura della pagina
         * scenario. Qui serve prima, e per due motivi diversi: non esisterebbe
         * la Home in VR (non c'è scena in cui metterla), e soprattutto la
         * sessione va aperta **nell'istante** in cui l'utente preme ENTRA —
         * `requestSession` esige una user activation fresca, e non c'è tempo per
         * costruire un renderer in mezzo.
         *
         * Si fa quindi già durante la copertina, mentre l'utente digita le
         * credenziali: quel tempo è tempo morto, ed è esattamente quanto serve.
         *
         * Non chiede che la pagina scenario sia visibile: `Scene3D.init()` legge
         * `#canvas3d` dal DOM — che esiste anche dentro un contenitore `hidden` —
         * e dimensiona il renderer su `window.innerWidth/innerHeight`, non sul
         * canvas. Un canvas a dimensione zero non è comunque un problema in
         * sessione immersiva, dove i fotogrammi vanno nel framebuffer della
         * sessione e non sul canvas della pagina.
         *
         * `core/` non viene toccato: `PageManager.onScenarioPageShown` inizializza
         * solo `if (!window.Scene3D.scene)`, quindi trovandola già pronta la
         * lascia stare.
         *
         * @returns {boolean} true se l'init è appena riuscito.
         */
        _initScene: function () {
            const S = window.Scene3D;
            if (!S || typeof S.init !== 'function' || S.scene) return false;
            if (this._initTried) return false;
            if (!document.getElementById('canvas3d')) return false;
            // Le dipendenze di `Scene3D.init()`. Senza, fallirebbe — e siccome
            // si prova una volta sola, fallire per essere arrivati troppo presto
            // significherebbe non avere mai la scena. Meglio ripassare.
            if (!window.THREE || !window.AppConfig) return false;

            this._initTried = true;
            const ok = S.init();
            console.log(ok
                ? '[XR] Scena pronta prima del login: si entra in VR col gesto di ENTRA.'
                : '[XR] Scena non creata: si resterà sulla home 2D.');
            return !!ok;
        },

        /**
         * Entra in VR subito dopo un login riuscito.
         *
         * È il passaggio che il flusso chiede: ENTRA → autenticazione → Home in
         * VR, senza una pagina 2D in mezzo e senza un secondo pulsante da
         * premere. La Home non è una pagina con dentro un collegamento alla VR:
         * è una scena, e ci si arriva direttamente.
         *
         * ## Perché può non riuscire, e perché va bene
         *
         * `requestSession` pretende una **user activation**: il gesto che l'ha
         * originata dev'essere recente. Qui il gesto è la pressione di ENTRA, e
         * in mezzo `core/` fa una cosa sola — leggere `users.txt` e confrontare
         * le credenziali — che su file locale dura millisecondi. Rientra
         * comodamente nella finestra, ma non è garantito su ogni browser: una
         * rete lenta sul fetch del file, e l'attivazione è scaduta.
         *
         * E su un desktop senza visore non riuscirà mai, per definizione.
         *
         * Il fallimento quindi non è un errore da segnalare: è il caso normale
         * fuori dal visore. Si resta sulla home 2D con il pulsante 🥽, che è
         * esattamente il comportamento di prima. Nessuna strada viene chiusa.
         */
        enterAfterLogin: async function () {
            if (this.isPresenting) return true;

            if (!this.supported) {
                console.log(`[XR] Ingresso automatico non possibile (${this._probeResult ? this._probeResult.reason : 'VR non disponibile'}): resta la home 2D.`);
                return false;
            }
            if (!window.Scene3D || !window.Scene3D.isInitialized) {
                console.warn('[XR] Scena non pronta al login: resta la home 2D, si entra col pulsante.');
                return false;
            }

            const ok = await this.enterVR();
            console.log(ok
                ? '[XR] Entrato in VR dal login: la Home è la hall immersiva.'
                : '[XR] Ingresso automatico rifiutato (user activation scaduta?): resta il pulsante 🥽.');
            return ok;
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
                this._startedAt = Date.now();
                this._calibrated = false;
                this._headSamples = [];
                session.addEventListener('end', this._onSessionEnd.bind(this), { once: true });

                this._suspendTouchSystem();
                this._suspendDomCircles();
                this._resetFrameMeter();
                this._watchStalls(session);
                this._applySkyBackground();
                this._placeRigAtCamera();
                if (window.XRInput) window.XRInput.init(this);

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
            // PRIMA di qualunque smontaggio: dopo, sorgenti, aggancio e sfondo
            // sono già stati azzerati e la fotografia mostrerebbe le macerie.
            if (window.XRLog) {
                const ms = this._startedAt ? Date.now() - this._startedAt : 0;
                window.XRLog.captureSession({ durata: `${Math.round(ms / 1000)} s` });
            }
            this.isPresenting = false;
            this.session = null;
            this._tuning = false;
            this._lastTuneTime = null;
            // Se la sessione finisce con lo stick ancora premuto, il salvataggio
            // al rilascio non arriva mai: salviamo qui.
            this.persistWorldScale();
            // Prima dei controller, poi il rig: sono suoi figli.
            if (window.XRInput) window.XRInput.dispose();
            this._restoreBackground();
            this._detachRig();
            this._restoreTouchSystem();
            this._restoreDomCircles();
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

            /*
             * Ogni metà del frame ha il suo `try`, e nessuna eccezione esce di
             * qui. Non è prudenza generica: in Three r155 il loop è
             *
             *     function onAnimationFrame(time, frame) {
             *         animationLoop(time, frame);
             *         requestId = context.requestAnimationFrame(onAnimationFrame);
             *     }
             *
             * — il frame successivo si chiede DOPO aver eseguito la callback.
             * Se la callback lancia, quella riga non viene mai raggiunta e il
             * loop muore per sempre: l'applicazione smette di consegnare
             * fotogrammi e il visore resta congelato sull'ultimo, immobile
             * anche girando la testa. Un singolo errore dentro il codice di
             * core — che di eccezioni non è avaro — basta a far sembrare rotta
             * la sessione intera.
             *
             * Con il `try` un errore diventa un frame storto e una riga nel
             * log, invece della fine della sessione.
             */
            S.renderer.setAnimationLoop(function (time) {
                const t0 = self.isPresenting ? performance.now() : 0;
                if (self.isPresenting) {
                    try {
                        self._guardRig();
                        self._pollScaleTuning(time);
                        self._sampleHead();
                        if (window.XRInput) window.XRInput.update();
                    } catch (err) {
                        self._noteFrameError('interazione', err);
                    }
                }
                const t1 = self.isPresenting ? performance.now() : 0;
                self._inFrame = true;
                try {
                    original();
                } catch (err) {
                    self._noteFrameError('scena', err);
                } finally {
                    self._inFrame = false;
                }
                if (self.isPresenting) self._meterFrame(t0, t1, performance.now());
            });

            this._loopOwned = true;
            console.log('[XR] Loop di render passato a renderer.setAnimationLoop (richiesto da WebXR).');
        },

        // =====================================================================
        // Misura del frame
        // =====================================================================

        /*
         * Perché misurare, invece di ottimizzare a intuito.
         *
         * "Perde la sincronia" ha molte cause possibili — lavoro nostro, lavoro
         * di core, GC, tracking del visore — e dentro il Quest non c'è modo di
         * aprire un profiler. Qui si contano tre cose sole, che bastano a
         * separare i casi:
         *
         *  - quanto dura l'intero frame (se sfora, il compositore riproietta e
         *    il mondo "scivola");
         *  - quanto ne consuma il layer XR;
         *  - quanti frame hanno sforato, e il peggiore.
         *
         * Se il layer XR è una frazione trascurabile del frame ma i frame
         * sforano lo stesso, il problema non è nei nostri calcoli: è a valle,
         * nel rendering della scena o fuori dalla pagina.
         */

        /** Soglia oltre cui un frame è "lungo": 72 Hz vuol dire 13,9 ms. */
        _frameBudgetMs: 13.9,

        _resetFrameMeter: function () {
            this._meter = { n: 0, sum: 0, worst: 0, over: 0, xrSum: 0, xrWorst: 0 };
            this.frameErrors = { n: 0, first: null, last: null };
        },

        /**
         * Registra un errore di frame senza far cadere la sessione.
         *
         * Il PRIMO errore è quello che conta: gli altri sono spesso la stessa
         * cosa ripetuta 72 volte al secondo. Si conserva quello, si conta il
         * resto, e in console si scrive di rado — riempire il log a raffica
         * costerebbe più dell'errore.
         *
         * @param {'interazione'|'scena'} dove metà del frame in cui è successo.
         */
        _noteFrameError: function (dove, err) {
            const msg = (err && err.message) || String(err);
            const e = this.frameErrors || (this.frameErrors = { n: 0, first: null, last: null });
            e.n++;
            if (!e.first) {
                e.first = { dove, msg, stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '' };
                console.error(`[XR] Errore nel frame (${dove}): ${msg}`, e.first.stack);
            }
            e.last = { dove, msg };
            const now = performance.now();
            if (!e._loggedAt || now - e._loggedAt > 3000) {
                e._loggedAt = now;
                if (e.n > 1) console.error(`[XR] Errori nel frame: ${e.n} finora, ultimo (${dove}): ${msg}`);
            }
        },

        /**
         * @param {number} t0 inizio dell'aggiornamento XR.
         * @param {number} t1 fine dell'aggiornamento XR (inizio del render).
         * @param {number} t2 fine del frame.
         */
        _meterFrame: function (t0, t1, t2) {
            const m = this._meter;
            if (!m) return;
            const total = t2 - t0;
            const xr = t1 - t0;
            m.n++;
            m.lastAt = t2;
            m.sum += total;
            m.xrSum += xr;
            if (total > m.worst) m.worst = total;
            if (xr > m.xrWorst) m.xrWorst = xr;
            if (total > this._frameBudgetMs) m.over++;
        },

        /**
         * Sensori per le due cause di blocco che non lasciano traccia in un
         * `try`, perché non sono eccezioni.
         *
         * **Contesto WebGL perso**: la GPU molla (memoria esaurita, driver che
         * reimposta). Da quel momento ogni disegno è un no-op silenzioso e il
         * visore resta sull'ultimo fotogramma, immobile anche girando la testa.
         * Senza questo listener è indistinguibile da un loop morto.
         *
         * **Sessione non visibile**: il menu di sistema del visore mette la
         * sessione in `hidden` o `visible-blurred` e i frame smettono
         * legittimamente di arrivare. Sembra un blocco, non lo è.
         *
         * Entrambi finiscono nel riepilogo: dentro il Quest sono l'unico modo
         * per sapere quale delle due è successa.
         */
        _watchStalls: function (session) {
            const S = window.Scene3D;
            this.glLost = null;
            this.visibility = session.visibilityState || 'visible';

            if (S && S.renderer && S.renderer.domElement && !this._glWatched) {
                this._glWatched = true;
                S.renderer.domElement.addEventListener('webglcontextlost', (e) => {
                    this.glLost = { at: Date.now() };
                    console.error('[XR] CONTESTO WEBGL PERSO: da qui in poi nulla viene piu\' disegnato.');
                    // Senza preventDefault il contesto non viene mai ripristinato.
                    e.preventDefault();
                });
                S.renderer.domElement.addEventListener('webglcontextrestored', () => {
                    console.warn('[XR] Contesto WebGL ripristinato.');
                });
            }

            session.addEventListener('visibilitychange', (e) => {
                this.visibility = e.session.visibilityState;
                console.log(`[XR] Sessione ora "${this.visibility}".`);
            });
        },

        /** Riepilogo in chiaro, per il pannello leggibile dal visore. */
        frameReport: function () {
            const m = this._meter;
            if (!m || !m.n) return null;
            return {
                frames: m.n,
                medio: `${(m.sum / m.n).toFixed(1)} ms`,
                peggiore: `${m.worst.toFixed(0)} ms`,
                lunghi: `${((m.over / m.n) * 100).toFixed(1)}%`,
                layerXR: `${(m.xrSum / m.n).toFixed(2)} ms (picco ${m.xrWorst.toFixed(0)})`,
                // Letto alla fine della sessione dice la cosa decisiva: se i
                // frame si sono fermati molto prima dell'uscita, il loop era
                // morto — non era lentezza, era un blocco.
                fermoDa: `${((performance.now() - (m.lastAt || 0)) / 1000).toFixed(1)} s`,
            };
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

            if (!_tmpVec) _tmpVec = new THREE.Vector3();

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
            // Riferimento per la calibrazione: l'eventuale correzione di altezza
            // si applica come scostamento da qui.
            this._rigBaseY = this.rig.position.y;

            // La scala va applicata dopo il posizionamento: tocca solo l'osservatore.
            this._applyWorldScale(this.getWorldScale());

            // Ruota il rig perché il suo -Z (avanti) segua la direzione orizzontale
            // di sguardo della camera desktop.
            const horiz = Math.hypot(dir.x, dir.z);
            if (horiz > 1e-6) this.rig.rotation.y = Math.atan2(-dir.x, -dir.z);

            this.rig.updateMatrixWorld(true);
            console.log(`[XR] Rig posizionato a (${this.rig.position.x.toFixed(2)}, ${this.rig.position.y.toFixed(2)}, ${this.rig.position.z.toFixed(2)})`);
        },

        /**
         * Porta l'osservatore al punto di vista previsto da uno scenario.
         *
         * Serve quando lo scenario si sceglie **da dentro la VR**: `_placeRigAtCamera`
         * gira una volta sola, all'ingresso, e da lì in poi il rig resta dove lo
         * ha lasciato l'utente. Entrando nell'Elettromandrino dalla hall ci si
         * ritrovava quindi ancora al centro della hall — che è l'origine, cioè
         * *dentro* la macchina, che è modellata proprio lì attorno. Da dentro una
         * lamiera non si vede niente, e la scena sembrava vuota pur essendo
         * caricata.
         *
         * Il punto di vista lo dichiara già lo scenario con `CameraPos` e
         * `CameraTarget`, gli stessi che sul desktop inquadrano la macchina.
         * Qui si applicano al **rig**, proiettati a terra: in VR l'altezza degli
         * occhi la dà il visore, non la configurazione, e imporla farebbe
         * galleggiare o sprofondare.
         *
         * Non tocca `core/`: `applyScenarioConfiguration` continua a fare quel
         * che faceva sulla camera, che in sessione immersiva viene comunque
         * sovrascritta dalla posa del visore a ogni frame.
         *
         * @param {{cameraPos?:string, cameraTarget?:string, name?:string}} scenario
         * @returns {boolean} true se il rig è stato spostato.
         */
        placeRigForScenario: function (scenario) {
            if (!this.isPresenting || !this.rig || !scenario) return false;
            const THREE = window.THREE;

            const pos = this._vec3(scenario.cameraPos);
            if (!pos) {
                console.warn(`[XR] "${scenario.name}" non dichiara CameraPos: l'osservatore resta dov'è.`);
                return false;
            }

            this.rig.position.x = pos.x;
            this.rig.position.z = pos.z;
            // La y resta quella calibrata: porta l'altezza occhi dell'operatore.

            // Girato verso ciò che lo scenario vuole far guardare. Senza target
            // si punta all'origine, che è dove stanno le macchine.
            const target = this._vec3(scenario.cameraTarget) || new THREE.Vector3(0, 0, 0);
            const dx = target.x - pos.x;
            const dz = target.z - pos.z;
            if (Math.hypot(dx, dz) > 1e-6) this.rig.rotation.y = Math.atan2(dx, dz) + Math.PI;

            this.rig.updateMatrixWorld(true);
            console.log(`[XR] Osservatore portato al punto di vista di "${scenario.name}": `
                + `(${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}).`);
            return true;
        },

        /** "(x, y, z)" → Vector3. Il formato è quello di `homeconfig.ini`. */
        _vec3: function (s) {
            if (!s) return null;
            const n = String(s).match(/-?\d+(?:\.\d+)?/g);
            if (!n || n.length < 3) return null;
            return new window.THREE.Vector3(parseFloat(n[0]), parseFloat(n[1]), parseFloat(n[2]));
        },

        // =====================================================================
        // Scala del mondo
        // =====================================================================

        /*
         * "Tutto sembra miniaturizzato" e "sono troppo alto" sono lo stesso
         * sintomo: il rapporto fra operatore e macchina è sbagliato. Abbassare
         * solo gli occhi non lo risolve — diventi una persona bassa in un mondo
         * piccolo.
         *
         * La correzione si applica al RIG, non ai modelli. Scalare i modelli
         * romperebbe le posizioni e le animazioni scritte nei tutorial e
         * cambierebbe anche la vista desktop. Scalando il rig si tocca solo
         * l'osservatore: la posa della testa e la distanza interpupillare vengono
         * moltiplicate, e il mondo appare più grande in proporzione.
         *
         * `rig.scale = 1 / worldScale`: scala del mondo 1,3 significa rig a 0,769,
         * quindi occhi a 1,75 / 1,3 = 1,35 unità contro una macchina di 2,80 —
         * come stare davanti a una macchina reale di 3,64 m.
         */

        /**
         * @returns {number} fattore di ingrandimento del mondo. 1 = metrica nativa
         * dei GLB; senza scelta salvata vale {@link DEFAULT_WORLD_SCALE}.
         *
         * Il valore vivo sta in memoria, non in localStorage: la regolazione col
         * thumbstick passa di qui a ogni frame, e rileggere/riscrivere lo storage
         * 72 volte al secondo sarebbe sia lento (è sincrono) sia impreciso —
         * l'arrotondamento della serializzazione si accumulerebbe a ogni frame.
         */
        getWorldScale: function () {
            if (this._worldScale === null) {
                let n = NaN;
                try { n = parseFloat(localStorage.getItem(WORLD_SCALE_KEY)); } catch (e) { /* storage negato */ }
                this._worldScale = Number.isFinite(n) && n >= SCALE_MIN && n <= SCALE_MAX ? n : DEFAULT_WORLD_SCALE;
            }
            return this._worldScale;
        },

        /**
         * @param {number} scale >1 ingrandisce il mondo, <1 lo rimpicciolisce.
         * @param {boolean} [persist=true] passare false durante una regolazione
         *        continua; poi chiamare `persistWorldScale()` una volta a fine corsa.
         */
        setWorldScale: function (scale, persist = true) {
            const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(scale) || 1));
            this._worldScale = s;
            if (persist) this.persistWorldScale();
            this._applyWorldScale(s);
            this._emit('scale');
            return s;
        },

        /** Salva la scala corrente. Separato da setWorldScale per non toccare
         *  localStorage dentro il render loop. */
        persistWorldScale: function () {
            try { localStorage.setItem(WORLD_SCALE_KEY, this.getWorldScale().toFixed(3)); } catch (e) { /* storage negato */ }
        },

        _applyWorldScale: function (s) {
            if (!this.rig) return;
            this.rig.scale.setScalar(1 / s);
            this.rig.updateMatrixWorld(true);
            // L'altezza misurata è in unità scena e dipende dalla scala:
            // va ricalibrata, altrimenti resta tarata sul fattore precedente.
            this._calibrated = false;
            this._headSamples = [];
        },

        /**
         * Regolazione dal vivo col thumbstick destro, su/giù.
         *
         * NON è il layer di input della milestone 3: legge soltanto un asse per
         * permettere di tarare la scala mentre la si guarda, senza uscire e
         * rientrare dalla sessione a ogni tentativo. Il valore raggiunto viene
         * persistito, così a fine prova si legge dal selettore sulla pagina 2D.
         *
         * @param {number} time timestamp del frame XR, in ms.
         */
        _pollScaleTuning: function (time) {
            const session = this.session;
            if (!session || !session.inputSources) return;

            const dt = this._lastTuneTime === null ? 0 : Math.min(0.1, (time - this._lastTuneTime) / 1000);
            this._lastTuneTime = time;
            if (dt <= 0) return;

            let axis = 0;
            let source = null;
            for (const src of session.inputSources) {
                if (src.handedness !== 'right' || !src.gamepad) continue;
                const a = src.gamepad.axes;
                // Mapping xr-standard: axes[2]/[3] sono il thumbstick; su alcuni
                // runtime più vecchi il primo asse valido è axes[1].
                const v = a.length >= 4 ? a[3] : (a.length >= 2 ? a[1] : 0);
                if (Math.abs(v) > STICK_DEADZONE) { axis = v; source = src; }
                break;
            }
            if (!axis) {
                // Stick rilasciato: è il momento di salvare, una volta sola.
                if (this._tuning) { this._tuning = false; this.persistWorldScale(); }
                return;
            }
            this._tuning = true;

            // Stick in avanti (valore negativo) = mondo più grande.
            const dir = -Math.sign(axis);
            const amount = (Math.abs(axis) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
            const next = this.getWorldScale() + dir * amount * SCALE_RATE_PER_SEC * dt;
            const applied = this.setWorldScale(next, false);

            // Tacca aptica ogni 0,1: dà il senso della granularità senza vedere numeri.
            const step = Math.round(applied / HAPTIC_STEP);
            if (step !== this._lastHapticStep) {
                this._lastHapticStep = step;
                const act = source.gamepad.hapticActuators && source.gamepad.hapticActuators[0];
                if (act && act.pulse) { try { act.pulse(0.3, 20); } catch (e) { /* non supportato */ } }
                console.log(`[XR] Scala mondo: ${applied.toFixed(2)}×`);
            }
        },

        // =====================================================================
        // Altezza dell'operatore
        // =====================================================================

        /*
         * I modelli sono in scala reale (a500 = 2,80 m, pulpito = 1,27 m), quindi
         * con `local-floor` l'altezza di default è già corretta: gli occhi stanno
         * dove stanno davvero. Serve comunque poterla imporre, per due motivi:
         *
         *  1. la calibrazione del pavimento del Guardian può essere sbagliata (se
         *     fatta da seduti o su una superficie rialzata, y=0 finisce troppo in
         *     alto e l'operatore si sente gigante);
         *  2. in un training è spesso preferibile che tutti vedano la macchina
         *     dalla stessa altezza, indipendentemente dalla statura reale.
         *
         * Non si può però imporre `rig.y` a priori: l'altezza vera la conosciamo
         * solo dalla posa del visore, a sessione avviata. Quindi campioniamo i
         * primi frame e correggiamo una volta sola (`_calibrateHeight`).
         */

        /**
         * Altezza occhi desiderata, in metri sopra il pavimento virtuale.
         * `null` = automatica, cioè l'altezza reale dell'operatore.
         * @returns {number|null}
         */
        getEyeHeight: function () {
            try {
                const v = localStorage.getItem(EYE_HEIGHT_KEY);
                if (v === null || v === 'auto') return null;
                const n = parseFloat(v);
                return Number.isFinite(n) && n > 0.5 && n < 2.5 ? n : null;
            } catch (e) {
                return null;
            }
        },

        /**
         * @param {number|null} meters altezza occhi voluta, o null per automatica.
         *        Applicata subito se una sessione è già in corso.
         */
        setEyeHeight: function (meters) {
            try {
                if (meters === null) localStorage.removeItem(EYE_HEIGHT_KEY);
                else localStorage.setItem(EYE_HEIGHT_KEY, String(meters));
            } catch (e) { /* storage negato: resta valido per questa sessione */ }

            if (this.isPresenting) {
                this._calibrated = false;
                this._headSamples = [];
                if (meters === null && this.rig) {
                    this.rig.position.y = this._rigBaseY; // torna all'altezza reale
                }
            }
            console.log(`[XR] Altezza occhi impostata: ${meters === null ? 'automatica' : meters.toFixed(2) + ' m'}`);
        },

        /** Raccoglie la posa verticale della testa; calibra una volta raggiunti i campioni. */
        _sampleHead: function () {
            const S = window.Scene3D;
            if (!this.rig || !S || !S.camera) return;

            const h = S.camera.getWorldPosition(_tmpVec).y - this.rig.position.y;
            if (!Number.isFinite(h) || h <= 0.2) return; // posa non ancora valida
            this.measuredEyeHeight = h;

            if (this._calibrated) return;
            this._headSamples.push(h);
            if (this._headSamples.length >= CALIBRATION_SAMPLES) this._calibrateHeight();
        },

        /** Sposta il rig perché gli occhi cadano all'altezza richiesta. */
        _calibrateHeight: function () {
            this._calibrated = true;

            const target = this.getEyeHeight();
            const samples = this._headSamples.slice().sort((a, b) => a - b);
            const measured = samples[Math.floor(samples.length / 2)]; // mediana: ignora scatti
            this.measuredEyeHeight = measured;

            if (target === null) {
                console.log(`[XR] Altezza occhi automatica: ${measured.toFixed(2)} m (nessuna correzione).`);
                return;
            }

            const delta = target - measured;
            this.rig.position.y = this._rigBaseY + delta;
            this.rig.updateMatrixWorld(true);
            console.log(`[XR] Altezza calibrata: misurata ${measured.toFixed(2)} m → richiesta ${target.toFixed(2)} m (correzione ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} m).`);
        },

        /**
         * Sfondo azzurro chiaro al posto del nero.
         *
         * `Scene3D.initScene` imposta `scene.background = null`: sul desktop è
         * corretto, perché il canvas è trasparente e sotto c'è il gradiente CSS
         * della pagina. In VR non c'è nessuna pagina sotto, e uno sfondo nullo
         * diventa vuoto nero — sgradevole e disorientante, perché toglie ogni
         * riferimento all'orizzonte.
         */
        _applySkyBackground: function () {
            const S = window.Scene3D;
            const THREE = window.THREE;
            if (!S || !S.scene) return;
            this._prevBackground = S.scene.background;
            S.scene.background = new THREE.Color(SKY_COLOR);
        },

        _restoreBackground: function () {
            const S = window.Scene3D;
            if (!S || !S.scene) return;
            if (S.scene.background && S.scene.background.isColor) S.scene.background.dispose?.();
            S.scene.background = this._prevBackground !== undefined ? this._prevBackground : null;
            this._prevBackground = undefined;
        },

        /**
         * Rimette la camera nel rig se qualcuno gliel'ha portata via.
         *
         * `HoldableSystem.init` fa `scene.add(this.camera)` quando la camera non
         * è figlia diretta della scena (core/js/core/HoldableSystem.js:102) — gli
         * serve perché il renderer disegni `holdContainer`, che è figlio della
         * camera. Se quell'init capita mentre siamo in sessione, il rig viene
         * scavalcato e con esso posizione, rotazione e scala dell'osservatore.
         *
         * Controllo per frame: un confronto di riferimenti, costo nullo.
         */
        _guardRig: function () {
            const S = window.Scene3D;
            if (!this.rig || !S || !S.camera) return;
            if (S.camera.parent === this.rig) return;
            console.warn('[XR] Camera sottratta al rig, la riaggancio.');
            this.rig.add(S.camera);
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

        /**
         * Ferma il loop DOM dei cerchi di evidenziazione.
         *
         * `HighlightCircleManager` tiene un `setInterval` a 60 Hz che, per ogni
         * cerchio attivo, fa `updateMatrixWorld`, costruisce un `Box3` nuovo,
         * proietta in 2D, **legge `canvas.clientWidth`** — che forza un reflow —
         * e riscrive `style.left/top`. In `immersive-vr` quei cerchi non si
         * vedono nemmeno: è lavoro interamente sprecato.
         *
         * Non è solo sprecato, è dannoso. Gira su un timer indipendente dal
         * frame XR, quindi cade a metà frame, e layout forzato più scritture di
         * stile a 60 Hz sono esattamente il genere di lavoro che fa sforare la
         * scadenza dei 13,8 ms e perdere la sincronia col visore.
         *
         * In VR il loro compito lo fanno gli anelli 3D di XRInput.
         */
        _suspendDomCircles: function () {
            const M = window.Scene3D && window.Scene3D.highlightCircleManager;
            if (!M || typeof M.stopUpdateLoop !== 'function') return;
            M.stopUpdateLoop();
            this._circlesSuspended = true;
            // Nascondili anche: restano fermi sull'ultima posizione calcolata,
            // e all'uscita dalla VR si riposizionano da soli al primo giro.
            if (M.circles) M.circles.forEach((c) => { if (c.element) c.element.style.display = 'none'; });
            console.log('[XR] Cerchi DOM sospesi: in VR li sostituiscono gli anelli 3D.');
        },

        _restoreDomCircles: function () {
            const M = window.Scene3D && window.Scene3D.highlightCircleManager;
            if (!M || !this._circlesSuspended) return;
            this._circlesSuspended = false;
            if (typeof M.startUpdateLoop === 'function') M.startUpdateLoop();
        },

        // =====================================================================
        // Eventi
        // =====================================================================

        /** @param {'enter'|'exit'|'scale'} evt */
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
                'Scene3D': S && S.isInitialized ? 'inizializzato' : 'non ancora (si apre dopo il login)',
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
                scalaMondo: this.getWorldScale().toFixed(2) + '×',
                altezzaOcchiMisurata: this.measuredEyeHeight ? +this.measuredEyeHeight.toFixed(2) + ' unità' : 'non ancora misurata',
                altezzaOcchiRichiesta: this.getEyeHeight() === null ? 'automatica' : this.getEyeHeight().toFixed(2) + ' unità',
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
