/**
 * XRHall.js — la home, dentro il mondo.
 *
 * In `immersive-vr` il DOM non esiste, quindi la home di CVT — l'elenco di card
 * con gli scenari — semplicemente non c'è. Finora l'unica strada era: scegliere
 * lo scenario sul desktop, poi indossare il visore, e a tutorial finito toglierlo
 * per sceglierne un altro. Il pannello del tutorial lo diceva a chiare lettere:
 * «Esci dalla VR e scegli un tutorial dalla pagina, poi rientra.»
 *
 * Qui quella pagina diventa un luogo: si entra una volta e si resta dentro. La
 * hall mostra gli stessi scenari della home 2D come pannelli premibili col dito;
 * premendone uno si entra nella scena, e a tutorial finito si torna qui.
 *
 * ## Rispecchiare, non reimplementare
 *
 * Vale la stessa regola di `XRUI`: l'elenco degli scenari **si legge** da
 * `UI.scenarioManager.scenariosConfig`, cioè esattamente ciò che ha popolato le
 * card della home; e premere una card **chiama** `scenarioManager.loadScenario()`,
 * la stessa funzione del click del mouse. Caricamento modelli, configurazione di
 * camera e luci, scelta del tutorial localizzato: tutto resta di `core/`.
 *
 * ## Perché il cambio scenario non spegne la VR
 *
 * `loadScenario` passa da `Scene3D.clearAllModels`, che rimuove *solo* gli
 * oggetti in `loadedModels`. Né `scene` né `renderer` vengono ricreati — nascono
 * una volta sola in `Scene3D.init()` — e la sessione WebXR vive appesa a
 * `renderer.xr`. L'`XRRig` è figlio di `scene` e non sta fra i modelli caricati,
 * quindi sopravvive alla pulizia. È questo che rende possibile entrare e uscire
 * dagli scenari senza mai togliersi il visore.
 *
 * Non tocca `core/`.
 */

(function () {
    'use strict';

    /** Card: larghezza e altezza in metri, misurate a un metro di distanza. */
    const CARD_W = 0.34;
    const CARD_H = 0.105;
    const CARD_GAP = 0.016;

    /**
     * Quante card per colonna prima di affiancarne un'altra.
     *
     * Gli scenari veri sono dieci, non due: in colonna unica sarebbero 1,28 m di
     * pannelli: la prima sopra la testa, l'ultima sotto le ginocchia, e quasi
     * nessuna a distanza di dito. Cinque per colonna stanno dentro l'arco che il
     * braccio raggiunge senza spostarsi.
     */
    const MAX_RIGHE = 5;

    /** Titolo della hall, sopra la colonna. */
    const TITLE_W = 0.46;
    const TITLE_H = 0.10;

    /** Risoluzione delle texture: stessa densità di XRUI (~2050 px/m). */
    const CARD_TEX_W = 1024;
    const CARD_TEX_H = Math.round(CARD_TEX_W * CARD_H / CARD_W);
    const TITLE_TEX_W = 1024;
    const TITLE_TEX_H = Math.round(TITLE_TEX_W * TITLE_H / TITLE_W);

    /**
     * Le stesse misure di XRUI, e per lo stesso motivo: un pannello che si preme
     * col dito deve stare dove il dito arriva, cioè entro una sessantina di
     * centimetri. Le misure sono scritte per un metro e poi scalate con la
     * distanza, così spostare la colonna non ne cambia la leggibilità.
     */
    const DIST = 0.60;
    const REF_DIST = 1.00;
    const DROP = 0.19;
    const FOLLOW = 0.06;

    const COL_BG = 'rgba(22, 26, 33, 0.94)';
    const COL_EDGE = 'rgba(255, 210, 30, 0.55)';
    const COL_TITLE = '#ffd21e';
    const COL_TEXT = '#f2f5f9';
    const COL_DIM = '#9aa7b8';
    const COL_CARD_ON = 'rgba(255, 210, 30, 0.92)';

    /** Il pavimento della hall: procedurale, così non aspetta la rete. */
    const FLOOR_R = 12;
    const GRID_N = 24;

    /**
     * Le uniche due frasi scritte qui dentro.
     *
     * Tutto il resto della hall — nomi e descrizioni degli scenari — è già nella
     * lingua giusta senza che ce ne occupiamo: al login `core/` ricarica
     * `homeconfig_<lingua>.ini`, e la hall legge quello. Per queste due righe non
     * esiste una sorgente a monte da rispecchiare, quindi stanno qui.
     *
     * I codici sono quelli di `users.txt` (campo 4), gli stessi del selettore in
     * gestione utenti: it, eng, fra, deu.
     */
    const T = {
        it:  { scegli: 'Scegli uno scenario', attesa: 'Caricamento scenari…', vuoto: 'Nessuno scenario disponibile' },
        eng: { scegli: 'Choose a scenario',   attesa: 'Loading scenarios…',  vuoto: 'No scenarios available' },
        fra: { scegli: 'Choisissez un scénario', attesa: 'Chargement des scénarios…', vuoto: 'Aucun scénario disponible' },
        deu: { scegli: 'Szenario wählen',     attesa: 'Szenarien werden geladen…', vuoto: 'Keine Szenarien verfügbar' },
    };

    /** Dopo quanto un'attesa smette di essere un'attesa e diventa un guasto. */
    const ATTESA_MAX_MS = 12000;

    const XRHall = {
        enabled: false,
        xr: null,
        root: null,
        cards: [],

        /** Cambia quando cambia l'insieme dei bersagli premibili. */
        version: 0,

        _visible: false,
        _sig: '',

        // =====================================================================
        // Ciclo di vita
        // =====================================================================

        init: function (xrSession) {
            if (this.enabled) return;
            const THREE = window.THREE;
            if (!THREE || !xrSession.rig) return;

            this.xr = xrSession;

            // Sotto il rig come XRUI: eredita la scala del mondo, quindi resta
            // grande uguale rispetto alla mano anche cambiando `worldScale`.
            this.root = new THREE.Group();
            this.root.name = 'XRHall';
            xrSession.rig.add(this.root);

            this.title = this._makeQuad(TITLE_W, TITLE_H, TITLE_TEX_W, TITLE_TEX_H);
            this.root.add(this.title);

            this.column = new THREE.Group();
            this.root.add(this.column);

            // Il pavimento sta nella SCENA, non nel rig: è il mondo, e deve
            // restare fermo mentre ci si sposta col teleport. Dentro il rig
            // seguirebbe la testa come un tappetino incollato ai piedi.
            this._buildFloor();

            this.cards = [];
            // null e non '': una lista vuota produce firma '', e partendo da ''
            // il primo giro sembrerebbe "nessun cambiamento" — il titolo di
            // attesa non verrebbe mai disegnato.
            this._sig = null;
            this._placed = false;
            this.enabled = true;
            this.setVisible(false);
            console.log('[XRHall] Hall immersiva pronta.');
        },

        dispose: function () {
            if (!this.enabled) return;
            this._disposeTree(this.root);
            this._disposeTree(this.floor);
            if (this.root && this.root.parent) this.root.parent.remove(this.root);
            if (this.floor && this.floor.parent) this.floor.parent.remove(this.floor);
            this.root = null;
            this.floor = null;
            this.title = null;
            this.column = null;
            this.cards = [];
            // null e non '': una lista vuota produce firma '', e partendo da ''
            // il primo giro sembrerebbe "nessun cambiamento" — il titolo di
            // attesa non verrebbe mai disegnato.
            this._sig = null;
            this.enabled = false;
            this.version++;
        },

        _disposeTree: function (obj) {
            obj && obj.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    if (o.material.map) o.material.map.dispose();
                    o.material.dispose();
                }
            });
        },

        // =====================================================================
        // Costruzione
        // =====================================================================

        /**
         * Un piano d'appoggio e una griglia, generati a runtime.
         *
         * Gli scenari hanno il loro `pavimento.glb`, ma arriva dal Worker e pesa:
         * la hall è la prima cosa che si vede entrando, e deve esserci subito.
         * Senza nulla sotto i piedi si galleggia nel vuoto — che è esattamente il
         * modo più rapido di sentirsi male in VR, perché manca il riferimento
         * orizzontale che dice al corpo dov'è il basso.
         */
        _buildFloor: function () {
            const THREE = window.THREE;
            const S = window.Scene3D;
            if (!S || !S.scene) return;

            const g = new THREE.Group();
            g.name = 'XRHallFloor';

            const disc = new THREE.Mesh(
                new THREE.CircleGeometry(FLOOR_R, 48),
                new THREE.MeshBasicMaterial({ color: 0x121821, toneMapped: false })
            );
            disc.rotation.x = -Math.PI / 2;
            // Sotto la griglia di un millimetro: complanari, sfarfallerebbero.
            disc.position.y = -0.001;
            g.add(disc);

            g.add(new THREE.GridHelper(FLOOR_R * 2, GRID_N, 0x2a3547, 0x1d2532));
            S.scene.add(g);
            this.floor = g;
        },

        /** Quad con texture da canvas: `MeshBasicMaterial`, il testo non deve
         *  essere spento dalle luci di scena. */
        _makeQuad: function (w, h, tw, th) {
            const THREE = window.THREE;
            const canvas = document.createElement('canvas');
            canvas.width = tw;
            canvas.height = th;

            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;

            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(w, h),
                new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthTest: false })
            );
            mesh.renderOrder = 998;
            mesh.userData.canvas = canvas;
            mesh.userData.tex = tex;
            return mesh;
        },

        // =====================================================================
        // Disegno
        // =====================================================================

        _roundRect: function (g, x, y, w, h, r) {
            g.beginPath();
            g.moveTo(x + r, y);
            g.arcTo(x + w, y, x + w, y + h, r);
            g.arcTo(x + w, y + h, x, y + h, r);
            g.arcTo(x, y + h, x, y, r);
            g.arcTo(x, y, x + w, y, r);
            g.closePath();
        },

        /** Spezza il testo alla larghezza data, al massimo `maxLines` righe. */
        _wrap: function (g, text, maxW, maxLines) {
            const words = String(text || '').split(/\s+/).filter(Boolean);
            const lines = [];
            let line = '';
            for (const w of words) {
                const probe = line ? `${line} ${w}` : w;
                if (g.measureText(probe).width > maxW && line) {
                    lines.push(line);
                    line = w;
                    if (lines.length === maxLines) break;
                } else {
                    line = probe;
                }
            }
            if (lines.length < maxLines && line) lines.push(line);
            // L'ultima riga tagliata lo dice, invece di finire a metà parola.
            if (lines.length === maxLines && words.length) {
                const joined = lines.join(' ');
                if (joined.length < String(text).length - 1) {
                    lines[maxLines - 1] = lines[maxLines - 1].replace(/[,.;:]?$/, '…');
                }
            }
            return lines;
        },

        _drawTitle: function (nome) {
            const c = this.title.userData.canvas;
            const g = c.getContext('2d');
            g.clearRect(0, 0, c.width, c.height);

            this._roundRect(g, 6, 6, c.width - 12, c.height - 12, 26);
            g.fillStyle = COL_BG;
            g.fill();
            g.lineWidth = 4;
            g.strokeStyle = COL_EDGE;
            g.stroke();

            g.fillStyle = COL_TITLE;
            g.font = '700 58px system-ui, -apple-system, Segoe UI, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(nome, c.width / 2, c.height / 2 + 2);

            this.title.userData.tex.needsUpdate = true;
        },

        _drawCard: function (mesh, pressed) {
            const c = mesh.userData.canvas;
            const g = c.getContext('2d');
            const sc = mesh.userData.scenario;
            g.clearRect(0, 0, c.width, c.height);

            this._roundRect(g, 6, 6, c.width - 12, c.height - 12, 24);
            g.fillStyle = pressed ? COL_CARD_ON : COL_BG;
            g.fill();
            g.lineWidth = 4;
            g.strokeStyle = COL_EDGE;
            g.stroke();

            const pad = 34;
            g.textAlign = 'left';
            g.textBaseline = 'top';

            g.fillStyle = pressed ? '#1a1d23' : COL_TITLE;
            g.font = '700 46px system-ui, -apple-system, Segoe UI, sans-serif';
            const titolo = this._wrap(g, sc.name, c.width - pad * 2, 1)[0] || '';
            g.fillText(titolo, pad, pad - 6);

            // La spiegazione è il motivo per cui la card esiste: senza, sono
            // due nomi tecnici e si sceglie a caso.
            g.fillStyle = pressed ? '#2b3038' : COL_DIM;
            g.font = '400 34px system-ui, -apple-system, Segoe UI, sans-serif';
            const righe = this._wrap(g, sc.description, c.width - pad * 2, 2);
            righe.forEach((r, i) => g.fillText(r, pad, pad + 58 + i * 42));

            mesh.userData.tex.needsUpdate = true;
        },

        // =====================================================================
        // Elenco degli scenari
        // =====================================================================

        /**
         * Le frasi della hall nella lingua dell'utente.
         *
         * La lingua sta nel profilo (`users.txt`) e `core/` la mette in
         * `currentUser.language` al login: non va chiesta di nuovo. Senza
         * profilo — o con una lingua che non conosciamo — si resta all'italiano,
         * che è la lingua della configurazione di default.
         */
        _t: function () {
            const l = (window.currentUser && window.currentUser.language || '').toLowerCase();
            return T[l] || T.it;
        },

        /**
         * Gli stessi scenari della home 2D, dalla stessa configurazione.
         *
         * ## Di `UI` ne esistono due, e a runtime vince quella vecchia
         *
         * `core/js/ui/ui-coordinator.js` definisce una `UI` modulare con
         * `scenarioManager`, `tutorialManager`, ecc. Subito dopo viene caricata
         * `core/js/ui.js`, il monolite, che si fa da parte **solo se** trova la
         * modulare già avviata — la riconosce da `_tutorialManager`, che però a
         * quel punto è ancora `null` perché `UI.init()` non è stato chiamato.
         * Il risultato è che in pratica comanda sempre il monolite, dove:
         *
         *  - `scenariosConfig` è **direttamente un array**, non `{scenarios:[…]}`;
         *  - `loadScenario` sta su `UI`, non su `UI.scenarioManager`.
         *
         * Leggere solo la forma modulare — com'era qui — significava non trovare
         * mai nulla: la hall restava su «Caricamento scenari…» per sempre, e le
         * card non erano nemmeno costruite. Si accettano quindi entrambe le
         * forme, senza decidere quale sia "quella giusta": è una condizione di
         * `core/`, e a noi tocca sopravviverci.
         */
        _scenarios: function () {
            const U = window.UI;
            if (!U) return [];

            const SM = U.scenarioManager;
            const raw = (SM && SM.scenariosConfig) || U.scenariosConfig;
            if (!raw) return [];

            if (Array.isArray(raw)) return raw;                       // ui.js (monolite)
            if (Array.isArray(raw.scenarios)) return raw.scenarios;   // ui-coordinator
            return [];
        },

        /** Chi sa caricare uno scenario, nell'una o nell'altra `UI`. */
        _loader: function () {
            const U = window.UI;
            if (!U) return null;
            const SM = U.scenarioManager;
            if (SM && typeof SM.loadScenario === 'function') return SM.loadScenario.bind(SM);
            if (typeof U.loadScenario === 'function') return U.loadScenario.bind(U);
            return null;
        },

        /**
         * Ricostruisce le card solo quando l'elenco cambia davvero. La
         * configurazione arriva via rete dopo il boot, quindi la prima volta
         * l'elenco è vuoto e va rifatto appena compare.
         */
        _buildCards: function () {
            const list = this._scenarios();
            // La lingua entra nella firma: la configurazione viene ricaricata
            // tradotta al login, e il titolo deve seguirla anche nel caso — raro
            // ma possibile — in cui i nomi degli scenari restino identici.
            const lang = (window.currentUser && window.currentUser.language) || '';
            const sig = lang + '#' + list.map((s) => s.name).join('|');
            if (sig === this._sig) return;
            this._avvisato = false;
            this._sig = sig;

            for (const c of this.cards) {
                this.column.remove(c);
                this._disposeTree(c);
            }
            this.cards = [];

            list.forEach((sc, i) => {
                const mesh = this._makeQuad(CARD_W, CARD_H, CARD_TEX_W, CARD_TEX_H);
                mesh.name = `XRHall_card_${i}`;
                mesh.userData.xrUiAction = `hall:${i}`;
                mesh.userData.scenario = sc;
                this._drawCard(mesh, false);
                this.column.add(mesh);
                this.cards.push(mesh);
            });

            this._layout();

            const t = this._t();
            if (list.length) {
                this._vuotoDa = 0;
                this._drawTitle(t.scegli);
            } else {
                // Un'attesa che non finisce va detta. Dentro il visore non c'è
                // console: se la configurazione non arriva, «Caricamento…» per
                // sempre è indistinguibile da un blocco, e non si saprebbe
                // nemmeno se valga la pena aspettare.
                this._vuotoDa = this._vuotoDa || Date.now();
                this._drawTitle(t.attesa);
            }
            this.version++;
            console.log(`[XRHall] Card ricostruite: ${this.cards.length}.`);
        },

        // =====================================================================
        // Frame
        // =====================================================================

        /**
         * La hall si vede quando non si sta facendo uno scenario, e lo si chiede
         * al DOM come tutto il resto del layer: `UI.currentPage` è la stessa cosa
         * che decide quale pagina è visibile sul desktop.
         */
        _shouldShow: function () {
            const U = window.UI;
            if (!U) return false;
            return U.currentPage !== 'scenario';
        },

        update: function () {
            if (!this.enabled || !this.xr.isPresenting) return;

            const show = this._shouldShow();
            if (show !== this._visible) this.setVisible(show);
            if (!show) return;

            this._buildCards();
            this._checkAttesa();
            this._place();
        },

        /**
         * Dispone le card in griglia, riempiendo per colonne.
         *
         * Per colonne e non per righe: leggendo si scorre una colonna dall'alto
         * in basso, come un elenco, e la seconda comincia solo quando la prima è
         * finita. Riempiendo per righe, due voci consecutive finirebbero
         * affiancate e l'ordine si perderebbe.
         *
         * Tutto centrato davanti: nella hall non c'è una macchina da guardare
         * dietro i pannelli, quindi il centro del campo visivo non va lasciato
         * libero — è esattamente dove serve che stiano.
         */
        _layout: function () {
            const n = this.cards.length;
            const passoY = CARD_H + CARD_GAP;
            const passoX = CARD_W + CARD_GAP;

            const colonne = Math.max(1, Math.ceil(n / MAX_RIGHE));
            const righe = Math.max(1, Math.ceil(n / colonne));

            const x0 = -(colonne - 1) * passoX / 2;
            const y0 = (righe - 1) * passoY / 2;

            this.cards.forEach((m, i) => {
                const c = Math.floor(i / righe);
                const r = i % righe;
                m.position.set(x0 + c * passoX, y0 - r * passoY, 0);
            });

            this.title.position.set(0, y0 + CARD_H / 2 + TITLE_H / 2 + CARD_GAP * 2, 0);
        },

        /** L'attesa che si trascina diventa un messaggio, non un silenzio. */
        _checkAttesa: function () {
            if (!this._vuotoDa || this._avvisato) return;
            if (Date.now() - this._vuotoDa < ATTESA_MAX_MS) return;
            this._avvisato = true;
            this._drawTitle(this._t().vuoto);
            console.warn('[XRHall] Nessuno scenario dopo '
                + (ATTESA_MAX_MS / 1000) + 's. UI.scenariosConfig: '
                + JSON.stringify(window.UI ? (window.UI.scenariosConfig === undefined ? 'assente' : (window.UI.scenariosConfig === null ? 'null' : 'presente')) : 'UI assente'));
        },

        setVisible: function (on) {
            this._visible = !!on;
            if (this.root) this.root.visible = this._visible;
            if (this.floor) this.floor.visible = this._visible;
            // Entrando in uno scenario le card spariscono dai bersagli: XRInput
            // deve rifare l'elenco, o resterebbero premibili da invisibili.
            this.version++;
            // Rientrando, il pannello si rimette davanti invece di scivolarci
            // da dove era rimasto.
            if (this._visible) this._placed = false;
        },

        /** Come XRUI: davanti alla testa, più in basso dello sguardo, e insegue
         *  solo in imbardata. Vedi il commento di `XRUI._place`. */
        _place: function () {
            const THREE = window.THREE;
            const S = window.Scene3D;
            const cam = S && S.camera;
            if (!cam) return;

            this._v = this._v || new THREE.Vector3();
            this._q = this._q || new THREE.Quaternion();
            this._e = this._e || new THREE.Euler();

            const head = cam.position;
            this._e.setFromQuaternion(cam.quaternion, 'YXZ');
            const yaw = this._e.y;
            const k = DIST / REF_DIST;

            this.root.scale.setScalar(k);
            this._v.set(
                head.x - Math.sin(yaw) * DIST,
                head.y - DROP * k,
                head.z - Math.cos(yaw) * DIST
            );

            if (!this._placed) {
                this.root.position.copy(this._v);
                this._placed = true;
            } else {
                this.root.position.lerp(this._v, FOLLOW);
            }

            this._q.setFromEuler(this._e.set(0, Math.atan2(
                head.x - this.root.position.x,
                head.z - this.root.position.z
            ), 0, 'YXZ'));
            this.root.quaternion.slerp(this._q, FOLLOW * 3);
        },

        // =====================================================================
        // Pressione
        // =====================================================================

        /** Bersagli premibili, per XRInput. */
        targets: function () {
            if (!this.enabled || !this._visible) return null;
            return this.cards;
        },

        /** Se la hall è in scena, il pannello del tutorial si fa da parte:
         *  sono due interfacce che occupano lo stesso posto. */
        isVisible: function () {
            return this.enabled && this._visible;
        },

        /**
         * Entra nello scenario scelto.
         *
         * Passa dalla stessa `loadScenario` del click del mouse: è lei a
         * mostrare la pagina scenario, applicare camera e luci, caricare i
         * modelli e scegliere il tutorial nella lingua giusta. Rifarne qui anche
         * solo un pezzo significherebbe vederlo divergere al primo cambiamento
         * a monte.
         *
         * @returns {boolean} true se l'azione è stata riconosciuta.
         */
        activate: function (mesh) {
            const action = mesh && mesh.userData && mesh.userData.xrUiAction;
            if (!action || action.indexOf('hall:') !== 0) return false;

            const sc = mesh.userData.scenario;
            const load = this._loader();
            if (!sc || !load) {
                console.warn('[XRHall] Nessuna UI sa caricare uno scenario: impossibile entrare.');
                return false;
            }

            this._flash(mesh);
            console.log(`[XRHall] Entro nello scenario "${sc.name}".`);
            load(sc);

            // Non si aspetta il caricamento per nascondere la hall: `update` la
            // toglie da sé appena `currentPage` diventa 'scenario'. Aspettare
            // qui vorrebbe dire indovinare quando i modelli sono pronti.
            return true;
        },

        /** La card si illumina alla pressione: senza aptica è l'unica conferma
         *  che il dito è arrivato. */
        _flash: function (mesh) {
            this._drawCard(mesh, true);
            setTimeout(() => {
                if (mesh.userData && mesh.userData.canvas) this._drawCard(mesh, false);
            }, 140);
        },

        // =====================================================================
        // Diagnostica
        // =====================================================================

        debugInfo: function () {
            const info = {
                attiva: this.enabled,
                visibile: this._visible,
                scenari: this.cards.map((c) => c.userData.scenario.name),
                pagina: window.UI ? window.UI.currentPage : '-',
                versione: this.version,
            };
            console.table(info);
            return info;
        },
    };

    window.XRHall = XRHall;
})();
