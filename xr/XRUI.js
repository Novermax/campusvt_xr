/**
 * XRUI.js — il fumetto del tutorial, dentro il mondo.
 *
 * MILESTONE 4. In `immersive-vr` il DOM non esiste: il compositore mostra solo
 * ciò che la pagina disegna in WebGL. Tutta l'interfaccia di CVT — fumetto con
 * la descrizione dello step, contatore, modali informativi — è HTML, quindi in
 * VR sparisce. Restava il buco più grosso del porting: si entrava nella scena
 * senza sapere cosa fare, e uno step con `message` bloccava il tutorial per
 * sempre, perché il pulsante OK che lo sblocca era invisibile.
 *
 * Qui quell'interfaccia viene rifatta come geometria: un pannello di testo e
 * pochi pulsanti, premibili col dito come qualunque comando della macchina.
 *
 * ## Rispecchiare, non reimplementare
 *
 * Il pannello **legge il DOM** (`#stepDescription`, `#stepCurrentNumber`,
 * `#infoModalMessage`, …) e **richiama le stesse funzioni** che userebbe il
 * mouse (il click sul vero `#infoModalOkBtn`).
 *
 * Non è pigrizia: è l'unico modo per non avere due verità. La logica del
 * tutorial — quando si può avanzare, cosa succede alla chiusura di un modale,
 * quali step sono automatici — vive in `core/` ed è intricata. Duplicarla qui
 * significherebbe vederla divergere al primo cambiamento a monte. Rispecchiando
 * il DOM, invece, qualunque modifica futura di `core/` arriva da sola.
 *
 * Non tocca `core/`.
 */

(function () {
    'use strict';

    /** Larghezza e altezza del pannello, in metri. */
    const PANEL_W = 0.50;
    const PANEL_H = 0.25;

    /**
     * Risoluzione della texture. Il rapporto con PANEL_W dà la densità:
     * 1024 px su 0,50 m sono ~2050 px/m. Un carattere da 56 px è alto 27 mm,
     * che a un metro sottende ~1,6° — la soglia sotto la quale, nei visori
     * attuali, il testo comincia a sgranarsi e stancare.
     */
    const TEX_W = 1024;
    const TEX_H = 512;

    /**
     * Distanza e altezza del pannello rispetto alla testa, in metri.
     *
     * **A portata di braccio, non a distanza di lettura.** La prima versione
     * stava a un metro: si leggeva benissimo e non si poteva premere, perché il
     * braccio arriva a una sessantina di centimetri. Un pannello che si tocca
     * col dito deve stare dove il dito arriva — leggibilità e portata non sono
     * negoziabili l'una contro l'altra.
     *
     * Le misure sono scritte per un metro e poi scalate: cambiando distanza il
     * pannello conserva la stessa dimensione APPARENTE, quindi la stessa
     * leggibilità. Spostarlo non vuol dire ritararlo.
     */
    const REF_DIST = 1.0;
    let DIST = 0.60;
    let DROP = 0.32;

    /**
     * Inseguimento della testa, frazione di scarto recuperata per frame.
     * Lento di proposito: un pannello incollato allo sguardo è illeggibile
     * mentre ci si muove, e nausea. Così resta dov'è per i movimenti piccoli e
     * si riporta davanti con calma quando ci si gira davvero.
     */
    const FOLLOW = 0.05;

    /** Pulsanti: larghezza, altezza e distanza fra i centri, in metri. */
    const BTN_W = 0.15;
    const BTN_H = 0.075;
    const BTN_GAP = 0.02;

    /** Riquadro del media (immagine o video) sopra il pannello. */
    const MEDIA_W = 0.52;
    const MEDIA_MAX_H = 0.34;

    /** Pulsanti degli strumenti, in colonna al fianco dell'operatore. */
    const TOOL_SIZE = 0.10;
    const TOOL_GAP = 0.016;

    /**
     * L'etichetta del ritorno alla hall, nelle lingue di `users.txt`.
     * Stesse quattro di `XRHall`: la lingua è quella del profilo, decisa al
     * login e mai più richiesta.
     */
    const T_HALL = { it: 'Scenari', eng: 'Scenarios', fra: 'Scénarios', deu: 'Szenarien' };

    /**
     * Posa della pulsantiera degli strumenti.
     *
     * Non è un cartello da leggere, è una tastiera da premere: il riferimento
     * giusto non è un pannello a parete ma il **bracciolo di una sedia** —
     * vicino, in basso, inclinato verso l'alto, dove la mano cade da sola
     * senza alzare il braccio.
     *
     * Verticale come una vetrina costringeva a portare la mano davanti al viso;
     * del tutto orizzontale sarebbe scomparsa di taglio. La via di mezzo — 45°
     * — si vede e si preme.
     *
     * `TOOLS_YAW` la gira verso l'operatore: stando di lato, altrimenti la si
     * guarderebbe di sbieco.
     */
    let TOOLS_SIDE = 1;              // +1 destra, -1 sinistra
    let TOOLS_X = 0.42;
    let TOOLS_Y = -0.26;
    let TOOLS_Z = 0.22;              // verso l'operatore
    let TOOLS_TILT = -45;            // gradi: 0 in piedi, -90 sdraiata
    // L'imbardata segue lo scostamento: piu' la pulsantiera va di lato, piu'
    // deve girarsi, o la si guarda di sbieco. A 0,42 la testa sta a ~28°.
    let TOOLS_YAW = 30;              // gradi, verso l'operatore

    /**
     * Quanto il fumetto si sposta a sinistra mentre si lavora.
     *
     * Durante uno step il centro dello sguardo serve alla macchina: è lì che si
     * deve guardare per premere un pulsante o infilare il dito in una feritoia.
     * Fumetto a sinistra e strumenti a destra lasciano libero il mezzo, e
     * restano entrambi dove l'occhio li ritrova senza cercarli.
     *
     * Il modale è l'eccezione, e giustamente: quando `core/` si ferma ad
     * aspettare, quello È il compito. Torna al centro, col video e l'OK.
     */
    const SIDE_X = 0.46;

    /**
     * Quanto il fumetto si gira verso l'operatore.
     *
     * Spinto al bordo del cono visivo lo si guarda molto di sbieco, e un
     * rettangolo di testo visto di taglio è testo che non si legge. Girarlo
     * verso la testa costa nulla e restituisce la pagina piatta davanti agli
     * occhi. L'angolo segue lo scostamento: alla testa, che sta un metro più in
     * là, `atan(SIDE_X)` — a 0,46 sono circa 25°.
     */
    const SIDE_YAW = 25;

    /**
     * Quanto il fumetto sale, mentre gli strumenti restano in basso.
     *
     * Spostarlo di lato non bastava: fumetto e strumenti restavano alla stessa
     * altezza e continuavano a leggersi come un blocco unico che occupa tutta
     * la fascia bassa. Separati anche in verticale diventano due cose distinte —
     * il testo in alto a sinistra, dove si legge senza che dia fastidio; gli
     * strumenti in basso a destra, dove la mano li raggiunge.
     */
    const RAISE = 0.40;

    const COL_BG = 'rgba(22, 26, 33, 0.94)';
    const COL_EDGE = 'rgba(255, 210, 30, 0.55)';
    const COL_TITLE = '#ffd21e';
    const COL_TEXT = '#f2f5f9';
    const COL_DIM = '#9aa7b8';
    const COL_BTN = 'rgba(46, 54, 66, 0.96)';
    const COL_BTN_ON = 'rgba(255, 210, 30, 0.92)';

    const XRUI = {
        enabled: false,
        xr: null,
        root: null,
        buttons: [],

        /** Cambia quando cambia l'insieme dei bersagli premibili. */
        version: 0,

        _state: null,     // ultima istantanea disegnata, per non ridisegnare a vuoto
        _visible: true,

        // =====================================================================
        // Ciclo di vita
        // =====================================================================

        init: function (xrSession) {
            if (this.enabled) return;
            const THREE = window.THREE;
            if (!THREE || !xrSession.rig) return;

            this.xr = xrSession;
            this.root = new THREE.Group();
            this.root.name = 'XRUI';
            // Sotto il rig: eredita la scala del mondo, come le mani. Un
            // pannello a scala fissa in un mondo ingrandito sembrerebbe un
            // francobollo o un cartellone.
            xrSession.rig.add(this.root);

            // Il fumetto e il suo pulsante sono un blocco solo: si spostano
            // insieme fra il lato e il centro.
            this.bubble = new THREE.Group();
            this.root.add(this.bubble);

            this.panel = this._makeQuad(PANEL_W, PANEL_H, TEX_W, TEX_H);
            this.bubble.add(this.panel);

            // Niente Avanti/Indietro: in VR si avanza facendo lo step, come
            // sul desktop. Resta solo OK, che sblocca i modali informativi.
            this.btnOk = this._makeButton('OK', 'ok');

            /*
             * Il ritorno alla hall.
             *
             * Senza, uno scenario è un vicolo cieco fino all'ultimo step: per
             * cambiare macchina — o solo per uscire da quella sbagliata —
             * bisognava finire il tutorial o togliersi il visore. Il documento
             * chiede l'opposto: la navigazione fra Home e scenari deve restare
             * dentro la VR.
             *
             * Sta in fondo alla pulsantiera, non accanto a OK: è un'uscita, e
             * le uscite non vanno messe dove cade il pollice mentre si lavora.
             */
            this.btnHall = this._makeButton(this._hallLabel(), 'hall');
            this.buttons = [this.btnOk, this.btnHall];

            const y = -PANEL_H / 2 - BTN_H / 2 - BTN_GAP;
            this.btnOk.position.set(0, y, 0);
            this.bubble.add(this.btnOk);

            // Media del modale: sopra il fumetto, quindi si sposta con lui.
            this.media = this._makeMediaQuad();
            this.bubble.add(this.media);

            // Finestra animata: al centro, dove si sta già guardando.
            this.anim = this._makeMediaQuad();
            this.root.add(this.anim);

            // Pulsantiera: un gruppo suo, così posizione e inclinazione si
            // regolano in un punto solo.
            this.toolBar = new THREE.Group();
            this.root.add(this.toolBar);
            this.tools = [];
            this._toolsSig = '';
            this.toolBar.add(this.btnHall);
            this._placeToolBar();
            this._buildTools();
            this._placeHallButton();

            this._state = null;
            this._placed = false;
            this.enabled = true;
            this.version++;
            console.log('[XRUI] Pannello tutorial in-world attivo.');
        },

        dispose: function () {
            if (!this.enabled) return;
            if (this.root && this.root.parent) this.root.parent.remove(this.root);
            this.root && this.root.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    if (o.material.map) o.material.map.dispose();
                    o.material.dispose();
                }
            });
            this.root = null;
            this.bubble = null;
            this.panel = null;
            this.media = null;
            this.anim = null;
            this.buttons = [];
            this.toolBar = null;
            this.tools = [];
            this._toolsSig = '';
            this.enabled = false;
            this.version++;
        },

        // =====================================================================
        // Costruzione
        // =====================================================================

        /** Quad con una texture da canvas: `MeshBasicMaterial` perché il testo
         *  non deve essere spento dalle luci di scena. */
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
            // Davanti alla macchina: un pannello mangiato dalla geometria della
            // cabina sarebbe illeggibile proprio quando serve.
            mesh.renderOrder = 998;
            mesh.userData.canvas = canvas;
            mesh.userData.tex = tex;
            return mesh;
        },

        _makeButton: function (label, action) {
            const mesh = this._makeQuad(BTN_W, BTN_H, 256, 128);
            mesh.name = `XRUI_${action}`;
            mesh.userData.xrUiAction = action;
            mesh.userData.label = label;
            this._drawButton(mesh, false);
            return mesh;
        },

        /**
         * Riquadro per l'immagine o il video del modale.
         *
         * La texture arriva **dall'elemento che `core/` ha già creato** dentro
         * `#infoModalMedia`: il video lo carica e lo riproduce lui, con i suoi
         * controlli e la sua gestione degli errori; qui se ne mostrano i
         * fotogrammi. Ricaricarlo per conto nostro significherebbe due
         * decodifiche dello stesso file e due punti dove può fallire.
         */
        _makeMediaQuad: function () {
            const THREE = window.THREE;
            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(MEDIA_W, MEDIA_W * 0.5625),
                new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthTest: false })
            );
            mesh.renderOrder = 998;
            mesh.visible = false;
            return mesh;
        },

        /**
         * Mostra su un quad l'elemento DOM dato, con le sue proporzioni vere.
         * Un video 16:9 stirato in 4:3 si nota subito.
         *
         * @param {THREE.Mesh} mesh riquadro su cui mostrarlo.
         * @param {?HTMLElement} el `<video>` o `<img>`; null per spegnere.
         * @returns {number} altezza in metri di quel che è stato mostrato, 0 se nulla.
         */
        _showOn: function (mesh, el) {
            const THREE = window.THREE;

            // Un `<img>` senza sorgente esiste ma non ha nulla da mostrare:
            // la finestra animata lo crea vuoto e lo riempie al primo trigger.
            if (!el || (el.tagName === 'IMG' && !el.src)) {
                if (mesh.userData.el) {
                    if (mesh.material.map) mesh.material.map.dispose();
                    mesh.material.map = null;
                    mesh.material.needsUpdate = true;
                    mesh.userData.el = null;
                }
                mesh.visible = false;
                return 0;
            }

            if (el !== mesh.userData.el) {
                if (mesh.material.map) mesh.material.map.dispose();
                const tex = el.tagName === 'VIDEO'
                    ? new THREE.VideoTexture(el)
                    : new THREE.Texture(el);
                tex.colorSpace = THREE.SRGBColorSpace;
                mesh.material.map = tex;
                mesh.material.needsUpdate = true;
                mesh.userData.el = el;
                mesh.userData.src = null;
            }

            /*
             * `VideoTexture` si aggiorna da sé; un `<img>` no, e la finestra
             * animata cambia `src` a ogni fotogramma.
             *
             * Ma non basta accorgersi del cambio: al momento in cui `src` viene
             * assegnato l'immagine **non è ancora decodificata**, e caricare
             * allora la texture significa caricare il nulla. Con un solo
             * tentativo per fotogramma il riquadro resta vuoto per sempre —
             * ogni upload arriva un istante troppo presto e nessuno lo rifà.
             *
             * Quindi si segna il fotogramma come in attesa e si riprova finché
             * l'immagine non è pronta: `complete` da solo non basta, perché è
             * vero anche per un'immagine fallita, mentre `naturalWidth > 0` dice
             * che c'è davvero qualcosa da mostrare.
             */
            if (el.tagName !== 'VIDEO') {
                const src = el.currentSrc || el.src;
                if (src !== mesh.userData.src) {
                    mesh.userData.src = src;
                    mesh.userData.pending = true;
                }
                if (mesh.userData.pending && el.complete && el.naturalWidth > 0) {
                    mesh.userData.pending = false;
                    mesh.material.map.needsUpdate = true;
                }
            }

            const w = el.videoWidth || el.naturalWidth || 16;
            const h = el.videoHeight || el.naturalHeight || 9;
            let mw = MEDIA_W;
            let mh = (MEDIA_W * h) / w;
            if (mh > MEDIA_MAX_H) { mh = MEDIA_MAX_H; mw = (MEDIA_MAX_H * w) / h; }
            mesh.scale.set(mw / MEDIA_W, mh / (MEDIA_W * 0.5625), 1);
            mesh.visible = true;
            return mh;
        },

        /** Immagine o video del modale, sopra il fumetto. */
        _syncMedia: function (show) {
            const box = document.getElementById('infoModalMedia');
            const el = show && box ? (box.querySelector('video') || box.querySelector('img')) : null;
            const mh = this._showOn(this.media, el);
            if (mh) this.media.position.set(0, PANEL_H / 2 + mh / 2 + BTN_GAP, 0);
            return !!mh;
        },

        /**
         * La finestra animata a fotogrammi (`AnimatedWindowSystem`).
         *
         * È il filmato che accompagna certi passi — l'apertura e chiusura della
         * pinza comandata dal tecpad, per dire: si preme il pulsante e i
         * fotogrammi avanzano. Sul desktop è una finestra HTML sopra la scena;
         * in VR non esisteva, quindi si premeva il pulsante e non succedeva
         * niente di visibile.
         *
         * Va al centro, non sopra il fumetto: durante uno step il centro è
         * libero apposta, ed è lì che si sta già guardando mentre si preme.
         *
         * ## Perché qui NON si rispecchia il DOM
         *
         * Ovunque altro il layer XR mostra l'elemento che `core/` ha già
         * caricato. Qui no, e la ragione è che con l'`<img>` non ha funzionato
         * due volte: la texture va caricata quando l'immagine è decodificata, e
         * indovinare quell'istante dall'esterno è fragile — un tentativo troppo
         * presto e il riquadro resta vuoto senza che nessuno se ne accorga.
         *
         * Si legge invece lo **stato**: `state.images` e `state.currentIndex`
         * dicono quale fotogramma mostrare, e la texture la si carica per conto
         * proprio, una volta sola per fotogramma e tenuta in cache. Sono PNG
         * piccoli e già nella cache del browser, quindi il doppio caricamento
         * non costa nulla; in cambio non c'è più alcun istante da indovinare.
         * Sequenza, direzione, conteggio dei trigger e chiusura restano di
         * `core/`: si rispecchia il *cosa*, non il *quando*.
         */
        _syncAnimation: function () {
            const THREE = window.THREE;
            const A = window.AnimatedWindowSystem;
            const st = A && A.isVisible ? A.state : null;
            const list = st && st.images;
            const url = list && list.length ? list[st.currentIndex || 0] : null;

            if (!url) {
                this.anim.visible = false;
                if (this._animOn) { this._animOn = false; console.log('[XRUI] Finestra animata chiusa.'); }
                return false;
            }

            if (url !== this._animUrl) {
                this._animUrl = url;
                const cached = this._animCache && this._animCache.get(url);
                if (cached) {
                    this._applyAnimTexture(cached);
                } else {
                    this._animCache = this._animCache || new Map();
                    this._animLoader = this._animLoader || new THREE.TextureLoader();
                    this._animLoader.load(url, (tex) => {
                        tex.colorSpace = THREE.SRGBColorSpace;
                        this._animCache.set(url, tex);
                        // Nel frattempo il fotogramma può essere già cambiato:
                        // si applica solo se è ancora quello richiesto.
                        if (this._animUrl === url) this._applyAnimTexture(tex);
                    }, undefined, () => {
                        console.warn(`[XRUI] Fotogramma non caricato: ${url}`);
                    });
                }
            }

            this.anim.visible = !!this.anim.material.map;
            this.anim.position.set(0, RAISE * 0.5, 0);

            if (!this._animOn) {
                this._animOn = true;
                console.log(`[XRUI] Finestra animata in-world: ${list.length} fotogrammi, primo ${url}`);
            }
            return this.anim.visible;
        },

        /** Mette il fotogramma sul riquadro, con le sue proporzioni. */
        _applyAnimTexture: function (tex) {
            this.anim.material.map = tex;
            this.anim.material.needsUpdate = true;

            const img = tex.image || {};
            const w = img.width || 16;
            const h = img.height || 9;
            let mw = MEDIA_W;
            let mh = (MEDIA_W * h) / w;
            if (mh > MEDIA_MAX_H) { mh = MEDIA_MAX_H; mw = (MEDIA_MAX_H * w) / h; }
            this.anim.scale.set(mw / MEDIA_W, mh / (MEDIA_W * 0.5625), 1);
            this.anim.visible = true;
        },

        // =====================================================================
        // Strumenti
        // =====================================================================

        /*
         * Sul desktop lo strumento si sceglie dalla legenda in basso a destra.
         * In VR quella legenda è DOM, quindi invisibile: finora l'unico modo di
         * avere lo strumento giusto era che `XRInput` lo equipaggiasse da sé al
         * momento della pressione. Funziona, ma toglie di mezzo un pezzo del
         * tutorial — scegliere l'utensile corretto è parte dell'esercizio.
         *
         * Qui la legenda torna, come colonna di pulsanti alla destra del
         * pannello: icona vera dello strumento, bordo acceso su quello attivo,
         * cornice gialla su quello che lo step sta chiedendo.
         */
        _buildTools: function () {
            const THREE = window.THREE;
            const R = window.ToolRegistry;
            const list = (R && typeof R.getAllTools === 'function' ? R.getAllTools() : []) || [];
            const sig = list.map((t) => t && t.id).join(',');
            if (sig === this._toolsSig) return;
            this._toolsSig = sig;

            this.tools.forEach((t) => {
                this.toolBar.remove(t);
                t.geometry.dispose();
                if (t.material.map) t.material.map.dispose();
                t.material.dispose();
                if (t.userData.icon) {
                    t.remove(t.userData.icon);
                    t.userData.icon.geometry.dispose();
                    if (t.userData.icon.material.map) t.userData.icon.material.map.dispose();
                    t.userData.icon.material.dispose();
                }
            });
            this.tools = [];

            const loader = new THREE.TextureLoader();
            const total = list.length * TOOL_SIZE + (list.length - 1) * TOOL_GAP;

            list.forEach((tool, i) => {
                if (!tool) return;
                const btn = this._makeQuad(TOOL_SIZE, TOOL_SIZE, 192, 192);
                btn.name = `XRUI_tool_${tool.id}`;
                btn.userData.xrUiAction = `tool:${tool.id}`;
                btn.userData.tool = tool;
                btn.position.set(0, total / 2 - TOOL_SIZE / 2 - i * (TOOL_SIZE + TOOL_GAP), 0);
                btn.visible = !!this._toolsOn;
                this._drawToolFrame(btn, false, false);

                // L'icona sta su un quad suo, davanti alla cornice: è un PNG
                // con trasparenza, e comporlo dentro il canvas vorrebbe dire
                // aspettarne il caricamento prima di poter disegnare la cornice.
                if (tool.icon) {
                    const icon = new THREE.Mesh(
                        new THREE.PlaneGeometry(TOOL_SIZE * 0.62, TOOL_SIZE * 0.62),
                        new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthTest: false })
                    );
                    icon.renderOrder = 999;
                    icon.position.z = 0.001;
                    loader.load(tool.icon, (tex) => {
                        tex.colorSpace = THREE.SRGBColorSpace;
                        icon.material.map = tex;
                        icon.material.needsUpdate = true;
                    }, undefined, () => {
                        console.warn(`[XRUI] Icona non caricata: ${tool.icon}`);
                    });
                    btn.add(icon);
                    btn.userData.icon = icon;
                }

                this.toolBar.add(btn);
                this.tools.push(btn);
            });

            if (this.tools.length) console.log(`[XRUI] Strumenti in-world: ${sig}`);
            this._placeHallButton();
            this.version++;
        },

        /** L'etichetta del ritorno, nella lingua del profilo. */
        _hallLabel: function () {
            const l = (window.currentUser && window.currentUser.language || '').toLowerCase();
            return T_HALL[l] || T_HALL.it;
        },

        /**
         * Il pulsante della hall va sotto l'ultimo strumento, e si risistema
         * ogni volta che la colonna cambia: gli scenari non hanno tutti gli
         * stessi strumenti, quindi la sua altezza non è una costante.
         */
        _placeHallButton: function () {
            if (!this.btnHall) return;
            const n = this.tools.length;
            const total = n ? n * TOOL_SIZE + (n - 1) * TOOL_GAP : 0;
            const sotto = n ? -total / 2 - TOOL_GAP * 2 - BTN_H / 2 : 0;
            this.btnHall.position.set(0, sotto, 0);
        },

        /** Applica posizione e inclinazione della pulsantiera. */
        _placeToolBar: function () {
            if (!this.toolBar) return;
            const d = Math.PI / 180;
            this.toolBar.position.set(TOOLS_X * TOOLS_SIDE, TOOLS_Y, TOOLS_Z);
            // L'imbardata è speculare fra i due lati: da destra si gira a
            // sinistra, e viceversa.
            this.toolBar.rotation.set(TOOLS_TILT * d, -TOOLS_YAW * d * TOOLS_SIDE, 0);
        },

        /** Cornice del pulsante strumento: attivo, richiesto, o nessuno dei due. */
        _drawToolFrame: function (btn, active, required) {
            const c = btn.userData.canvas;
            const g = c.getContext('2d');
            g.clearRect(0, 0, c.width, c.height);

            this._roundRect(g, 6, 6, c.width - 12, c.height - 12, 24);
            g.fillStyle = active ? 'rgba(255, 210, 30, 0.30)' : COL_BTN;
            g.fill();
            g.lineWidth = required || active ? 9 : 4;
            g.strokeStyle = active ? COL_BTN_ON : (required ? COL_EDGE : 'rgba(255,255,255,0.20)');
            g.stroke();

            btn.userData.tex.needsUpdate = true;
            btn.userData.frame = `${active}|${required}`;
        },

        /** Aggiorna le cornici quando cambia lo strumento attivo o richiesto. */
        _syncTools: function () {
            const TM = window.ToolsManager;
            const S = window.Scene3D;
            if (!this.tools.length) return;

            const active = TM && TM.getActiveTool ? TM.getActiveTool() : null;
            let required = null;
            if (S && typeof S.getCurrentTutorialStep === 'function' && typeof S.getRequiredToolForStep === 'function') {
                const st = S.getCurrentTutorialStep();
                if (st) required = S.getRequiredToolForStep(st);
            }

            this.tools.forEach((btn) => {
                const id = btn.userData.tool.id;
                const want = `${id === active}|${id === required}`;
                if (btn.userData.frame !== want) {
                    this._drawToolFrame(btn, id === active, id === required);
                }
            });
        },

        // =====================================================================
        // Disegno
        // =====================================================================

        _drawButton: function (mesh, pressed) {
            const c = mesh.userData.canvas;
            const g = c.getContext('2d');
            g.clearRect(0, 0, c.width, c.height);

            this._roundRect(g, 4, 4, c.width - 8, c.height - 8, 26);
            g.fillStyle = pressed ? COL_BTN_ON : COL_BTN;
            g.fill();
            g.lineWidth = 4;
            g.strokeStyle = COL_EDGE;
            g.stroke();

            g.fillStyle = pressed ? '#1a1d23' : COL_TEXT;
            g.font = '600 54px system-ui, -apple-system, Segoe UI, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            // Mai `fillText(undefined)`: non fallisce, scrive «undefined» a
            // caratteri cubitali sul pulsante. Meglio un pulsante muto e una
            // riga nel log, che il pannello «📋 Log XR» riporta fuori dalla
            // sessione — dentro il visore la console non si può aprire.
            const etichetta = mesh.userData.label;
            if (typeof etichetta !== 'string') {
                console.warn(`[XRUI] Pulsante senza etichetta (${mesh.userData.xrUiAction}): resta muto.`);
            }
            g.fillText(typeof etichetta === 'string' ? etichetta : '', c.width / 2, c.height / 2 + 2);

            mesh.userData.tex.needsUpdate = true;
        },

        /**
         * Ridisegna il pannello. Chiamato solo quando il contenuto cambia
         * davvero: ridisegnare un canvas e ricaricare la texture a ogni frame
         * costerebbe più di tutto il resto del layer messo insieme.
         */
        _drawPanel: function (st) {
            const c = this.panel.userData.canvas;
            const g = c.getContext('2d');
            g.clearRect(0, 0, c.width, c.height);

            this._roundRect(g, 6, 6, c.width - 12, c.height - 12, 34);
            g.fillStyle = COL_BG;
            g.fill();
            g.lineWidth = 5;
            g.strokeStyle = COL_EDGE;
            g.stroke();

            const pad = 54;
            let y = 92;

            // Riga di servizio: dove siamo nel tutorial.
            if (st.counter) {
                g.fillStyle = COL_DIM;
                g.font = '500 40px system-ui, -apple-system, Segoe UI, sans-serif';
                g.textAlign = 'left';
                g.textBaseline = 'alphabetic';
                g.fillText(st.counter, pad, y);
                y += 26;
            }

            if (st.title) {
                g.fillStyle = COL_TITLE;
                g.font = '700 58px system-ui, -apple-system, Segoe UI, sans-serif';
                y = this._wrap(g, st.title, pad, y + 46, c.width - pad * 2, 64, 2);
                y += 18;
            }

            if (st.body) {
                g.fillStyle = COL_TEXT;
                g.font = '400 52px system-ui, -apple-system, Segoe UI, sans-serif';
                this._wrap(g, st.body, pad, y + 46, c.width - pad * 2, 60, 5);
            }

            this.panel.userData.tex.needsUpdate = true;
        },

        /**
         * Testo a capo automatico.
         * @returns {number} la y raggiunta, per impilare i blocchi.
         */
        _wrap: function (g, text, x, y, maxW, lineH, maxLines) {
            const words = String(text).split(/\s+/);
            let line = '';
            let lines = 0;
            for (let i = 0; i < words.length; i++) {
                const attempt = line ? line + ' ' + words[i] : words[i];
                if (g.measureText(attempt).width > maxW && line) {
                    if (lines + 1 >= maxLines) {
                        // L'ultima riga finisce con i puntini: un testo tagliato
                        // a metà parola sembra un errore, non una scelta.
                        while (g.measureText(line + '…').width > maxW && line.length > 1) {
                            line = line.slice(0, -1);
                        }
                        g.fillText(line + '…', x, y);
                        return y;
                    }
                    g.fillText(line, x, y);
                    y += lineH;
                    lines++;
                    line = words[i];
                } else {
                    line = attempt;
                }
            }
            if (line) { g.fillText(line, x, y); }
            return y;
        },

        _roundRect: function (g, x, y, w, h, r) {
            g.beginPath();
            g.moveTo(x + r, y);
            g.arcTo(x + w, y, x + w, y + h, r);
            g.arcTo(x + w, y + h, x, y + h, r);
            g.arcTo(x, y + h, x, y, r);
            g.arcTo(x, y, x + w, y, r);
            g.closePath();
        },

        // =====================================================================
        // Lettura dello stato dal DOM
        // =====================================================================

        /**
         * Istantanea di cosa il tutorial sta dicendo, letta dagli stessi
         * elementi che l'utente vedrebbe sul desktop.
         *
         * Il modale ha la precedenza: se è aperto, `core/` sta aspettando quel
         * click e nient'altro può succedere finché non arriva.
         */
        _readState: function () {
            // Fine tutorial. `core/` lo costruisce al volo
            // (`Scene3D.displayCongratulationsModal`) e non è `#infoModal`:
            // senza rispecchiarlo, l'ultimo passo spegneva la VR in silenzio —
            // scena congelata da `interactionsBlocked`, messaggio invisibile
            // perché DOM, e nessun pulsante da premere. Viene prima di tutto
            // il resto perché è lo stato più bloccante che ci sia.
            // `.show` arriva 50 ms dopo l'inserimento e sparisce 300 ms prima
            // della rimozione: è lo stesso segnale di `#infoModal`, e seguirlo
            // evita di mostrare il pannello mentre il modale sta sfumando.
            const done = document.getElementById('congratulationsModal');
            if (done && done.classList.contains('show')) {
                const h = done.querySelector('.congratulations-header');
                const b = done.querySelector('.congratulations-body');
                return {
                    mode: 'modal',
                    ok: 'congratulationsCloseBtn',
                    counter: '',
                    title: h ? (h.innerText || h.textContent || '').trim() : '🎉 Complimenti!',
                    body: b ? (b.innerText || b.textContent || '').trim() : '',
                };
            }

            const modal = document.getElementById('infoModal');
            const modalOpen = !!modal && modal.classList.contains('show');

            if (modalOpen) {
                const t = document.getElementById('infoModalTitle');
                const m = document.getElementById('infoModalMessage');
                return {
                    mode: 'modal',
                    ok: 'infoModalOkBtn',
                    counter: '',
                    title: t ? t.textContent.trim() : 'Informazione',
                    // innerText salta i <br> convertiti da \n e restituisce
                    // il testo come si vede, non come è marcato.
                    body: m ? (m.innerText || m.textContent || '').trim() : '',
                };
            }

            const U = window.UI;
            const desc = document.getElementById('stepDescription');
            const cur = document.getElementById('stepCurrentNumber');
            const tot = document.getElementById('stepTotalNumber');
            const idx = U && U.currentStepIndex !== undefined ? U.currentStepIndex : -1;
            const step = U && U.tutorialSteps ? U.tutorialSteps[idx] : null;

            if (idx < 0 || !step) {
                return {
                    mode: 'idle',
                    counter: '',
                    title: 'Tutorial non avviato',
                    body: 'Questo scenario non ha un tutorial attivo. Torna alla hall per sceglierne un altro.',
                };
            }

            return {
                mode: 'step',
                counter: cur && tot ? `Passo ${cur.textContent} di ${tot.textContent}` : '',
                title: step.title || '',
                body: (desc ? desc.textContent : '').trim()
                    || step.properties?.Descrizione
                    || '',
                idx,
                last: U.tutorialSteps ? idx >= U.tutorialSteps.length - 1 : false,
            };
        },

        // =====================================================================
        // Frame
        // =====================================================================

        update: function () {
            if (!this.enabled || !this.xr.isPresenting) return;

            // Nella hall comanda la hall: fumetto e strumenti parlerebbero di
            // uno step che non è ancora stato scelto, nello stesso posto in cui
            // sta l'elenco degli scenari.
            const inHall = !!(window.XRHall && window.XRHall.isVisible && window.XRHall.isVisible());
            if (inHall !== this._inHall) {
                this._inHall = inHall;
                this.root.visible = this._visible && !inHall;
                // I bersagli cambiano: XRInput deve rifare l'elenco, o i
                // pulsanti resterebbero premibili da invisibili.
                this.version++;
            }
            if (inHall) return;

            const st = this._readState();
            const key = `${st.mode}|${st.counter}|${st.title}|${st.body}`;
            if (key !== this._stateKey) {
                this._stateKey = key;
                this._state = st;
                this._drawPanel(st);
                this._applyButtons(st);
            }

            // Il media va riletto anche a testo invariato: il video di core
            // arriva un istante dopo il messaggio, e le sue dimensioni ancora
            // dopo, quando il primo fotogramma è decodificato.
            this._syncMedia(st.mode === 'modal');
            this._syncAnimation();

            // Gli strumenti dipendono dallo scenario, che può cambiare senza
            // che cambi nulla del testo.
            this._buildTools();
            this._syncTools();

            this._place();
        },

        /**
         * Quali pulsanti hanno senso adesso.
         * Resta il solo OK, e solo con un modale aperto: è il pulsante che
         * sblocca `core/`, fermo ad aspettarne la chiusura.
         */
        _applyButtons: function (st) {
            const modal = st.mode === 'modal';

            // A fine tutorial il pulsante non chiude un avviso, prosegue: la
            // parola giusta è quella del desktop.
            const label = st.ok === 'congratulationsCloseBtn' ? 'Continua' : 'OK';
            if (this.btnOk.userData.label !== label) {
                this.btnOk.userData.label = label;
                this._drawButton(this.btnOk, false);
            }

            // Gli strumenti si scelgono solo mentre si sta facendo uno step.
            // Con un modale aperto il desktop blocca tutto ciò che sta dietro,
            // e prima dell'avvio del tutorial `StepGatingManager` blocca ogni
            // interazione: qui vale lo stesso, altrimenti la VR permetterebbe
            // cose che il resto del sistema vieta.
            const toolsOn = st.mode === 'step';

            // Il ritorno alla hall c'è sempre, tranne mentre un modale aspetta
            // risposta: lì `core/` è fermo su quella promise, e sfilarsi di
            // lato la lascerebbe appesa. Chiuso l'avviso, l'uscita ritorna.
            const hallOn = !modal;

            const changed = this.btnOk.visible !== modal
                || this.btnHall.visible !== hallOn
                || this._toolsOn !== toolsOn;

            this.btnOk.visible = modal;
            this.btnHall.visible = hallOn;
            this._toolsOn = toolsOn;
            this.tools.forEach((t) => { t.visible = toolsOn; });

            // Al lavoro il fumetto si fa da parte e sale; quando c'è un modale
            // è lui il compito, e torna in mezzo, davanti e dritto.
            this.bubble.position.set(modal ? 0 : -SIDE_X, modal ? 0 : RAISE, 0);
            this.bubble.rotation.y = modal ? 0 : SIDE_YAW * Math.PI / 180;

            // I bersagli premibili sono cambiati: XRInput deve rifare l'elenco.
            if (changed) this.version++;
        },

        /**
         * Il pannello sta davanti alla testa, un po' più in basso della linea
         * dello sguardo, e la insegue con calma.
         *
         * Solo l'imbardata: seguire anche il beccheggio significherebbe avere il
         * pannello sempre in mezzo, anche guardando in basso verso una vite. Con
         * il solo yaw resta un oggetto appoggiato nello spazio, che si ritrova
         * dove ci si aspetta.
         */
        _place: function () {
            const THREE = window.THREE;
            const S = window.Scene3D;
            const cam = S.camera;

            this._v = this._v || new THREE.Vector3();
            this._q = this._q || new THREE.Quaternion();
            this._e = this._e || new THREE.Euler();

            // La camera è figlia del rig, come il pannello: si lavora tutto in
            // coordinate del rig e non serve alcuna conversione.
            const head = cam.position;
            this._e.setFromQuaternion(cam.quaternion, 'YXZ');
            const yaw = this._e.y;
            const k = DIST / REF_DIST;

            // Scala e distanza insieme: l'angolo sotteso non cambia.
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

            // Rivolto alla testa, ma dritto: un pannello inclinato si legge male.
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
            if (!this.enabled || !this._visible || this._inHall) return null;
            return this.buttons.concat(this.tools).filter((b) => b.visible);
        },

        /**
         * Esegue l'azione di un pulsante.
         *
         * Sempre passando per le stesse strade del mouse: per il modale un
         * click vero sul pulsante vero — è quel click che risolve la promise
         * su cui `core/` è fermo, e riprodurne gli effetti a mano vorrebbe
         * dire riscriverne la chiusura.
         *
         * @returns {boolean} true se l'azione è stata riconosciuta.
         */
        activate: function (mesh) {
            const action = mesh && mesh.userData && mesh.userData.xrUiAction;
            if (!action) return false;

            // Strumento: stessa strada della legenda 2D, `toggleTool` è
            // esclusivo e idempotente.
            if (action.indexOf('tool:') === 0) {
                const id = action.slice(5);
                const TM = window.ToolsManager;
                if (TM && typeof TM.toggleTool === 'function') {
                    TM.toggleTool(id);
                    this._syncTools();
                    console.log(`[XRUI] Strumento scelto: ${id}`);
                    return true;
                }
                return false;
            }

            this._flash(mesh);

            if (action === 'hall') {
                // Stessa strada del mouse: il pulsante Home di `core/`, che è
                // l'unico a sapere che cosa va azzerato prima di tornare
                // indietro (tool, step, holdable, modelli). `goHome` diretto
                // solo se quel pulsante non c'è.
                const home = document.getElementById('homeButton');
                const U = window.UI;
                if (home) home.click();
                else if (U && typeof U.goHome === 'function') U.goHome();
                else return false;

                console.log('[XRUI] Ritorno alla hall richiesto dallo scenario.');
                return true;
            }

            if (action === 'ok') {
                // Quale modale sia aperto lo dice lo stato appena letto; il
                // DOM resta l'arbitro se lo stato non è ancora arrivato.
                const id = (this._state && this._state.ok)
                    || (document.getElementById('congratulationsCloseBtn')
                        ? 'congratulationsCloseBtn'
                        : 'infoModalOkBtn');
                const btn = document.getElementById(id);
                if (btn) { btn.click(); console.log(`[XRUI] Modale chiuso (${id}).`); }
                return true;
            }
            return false;
        },

        /** Il pulsante si illumina alla pressione: senza aptica è l'unica
         *  conferma che il dito è arrivato. */
        _flash: function (mesh) {
            this._drawButton(mesh, true);
            setTimeout(() => { if (this.enabled) this._drawButton(mesh, false); }, 180);
        },

        // =====================================================================
        // Regolazioni
        // =====================================================================

        /** Mostra o nasconde il pannello. Nascosto non è nemmeno premibile. */
        setVisible: function (on) {
            this._visible = !!on;
            if (this.root) this.root.visible = this._visible && !this._inHall;
            this.version++;
            return this._visible;
        },

        /**
         * Posa della pulsantiera degli strumenti, per tararla dal visore.
         *
         * @param {object} o
         * @param {'left'|'right'} [o.side] da che parte sta.
         * @param {number} [o.x] scostamento laterale, in metri.
         * @param {number} [o.y] altezza rispetto al centro del pannello.
         * @param {number} [o.z] quanto viene incontro all'operatore.
         * @param {number} [o.tilt] gradi: 0 in piedi, -90 sdraiata.
         * @param {number} [o.yaw] gradi di rotazione verso l'operatore.
         */
        setTools: function (o) {
            o = o || {};
            if (o.side === 'left') TOOLS_SIDE = -1;
            if (o.side === 'right') TOOLS_SIDE = 1;
            if (o.x !== undefined) TOOLS_X = Number(o.x);
            if (o.y !== undefined) TOOLS_Y = Number(o.y);
            if (o.z !== undefined) TOOLS_Z = Number(o.z);
            if (o.tilt !== undefined) TOOLS_TILT = Number(o.tilt);
            if (o.yaw !== undefined) TOOLS_YAW = Number(o.yaw);
            this._placeToolBar();
            const pose = { side: TOOLS_SIDE > 0 ? 'right' : 'left', x: TOOLS_X, y: TOOLS_Y, z: TOOLS_Z, tilt: TOOLS_TILT, yaw: TOOLS_YAW };
            console.log('[XRUI] Pulsantiera strumenti:', JSON.stringify(pose));
            return pose;
        },

        /**
         * @param {number} [distance] distanza dalla testa, in metri.
         * @param {number} [drop] quanto sotto la linea dello sguardo.
         */
        setPlacement: function (distance, drop) {
            if (distance !== undefined) DIST = Math.max(0.3, Math.min(3, Number(distance) || DIST));
            if (drop !== undefined) DROP = Math.max(-0.5, Math.min(1.2, Number(drop)));
            this._placed = false;   // riposizionamento immediato, senza inseguimento
            console.log(`[XRUI] Pannello a ${DIST.toFixed(2)} m, ${DROP.toFixed(2)} m sotto lo sguardo.`);
            return { distance: DIST, drop: DROP };
        },

        debugInfo: function () {
            const info = {
                attivo: this.enabled,
                visibile: this._visible,
                modo: this._state ? this._state.mode : '-',
                testo: this._state ? this._state.title : '-',
                pulsanti: this.buttons.filter((b) => b.visible).map((b) => b.userData.xrUiAction).join(' | ') || 'nessuno',
                posizione: `${DIST.toFixed(2)} m, ${DROP.toFixed(2)} m sotto`,
            };
            console.table(info);
            return info;
        },
    };

    window.XRUI = XRUI;
})();
