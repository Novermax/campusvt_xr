/**
 * XRHold.js — oggetti impugnati, agganciati alla mano invece che alla vista.
 *
 * Sul desktop `HoldableSystem` ancora l'oggetto impugnato alla **camera**: è la
 * cosa giusta lì, dove non esistono mani e l'oggetto deve restare in un angolo
 * fisso dell'inquadratura. In VR è sbagliato due volte.
 *
 * 1. Il calcolo non torna più. `updateHeldObjectPosition`
 *    (core/js/core/HoldableSystem.js:454) somma `camera.position` trattandolo
 *    come coordinata mondo. Lo era finché la camera era figlia di Scene; da
 *    quando è figlia dell'XRRig è **locale**, e l'oggetto finisce spostato di
 *    tutta la trasformazione del rig — lontanissimo e in alto.
 *
 * 2. Anche col calcolo corretto sarebbe innaturale: in VR l'oggetto lo si
 *    prende in mano, non lo si incolla davanti agli occhi.
 *
 * Qui si sostituisce il posizionamento con un aggancio al polso, lasciando
 * intatto tutto il resto di HoldableSystem — presa, rilascio, stato degli step.
 * `core/` non viene toccato: si avvolge il metodo dall'esterno.
 */

(function () {
    'use strict';

    /**
     * Posa dell'oggetto rispetto all'ancora, in metri fisici e gradi.
     * Ancorando al palmo l'offset e' quasi nullo: l'oggetto sta gia' dove
     * dovrebbe, serve solo staccarlo un poco dalla pelle.
     * Tarabile con `XRHold.setGrip`, e persistita.
     */
    /**
     * Posa dell'oggetto in mano, tarata sul Quest 3 con `remote.glb`.
     *
     * Le rotazioni non sono deducibili: dipendono da come il modello è orientato
     * nel proprio GLB, e queste sono quelle trovate provando col pannello.
     *
     * L'offset Y di -15 cm è grande per un oggetto che sta in mano, e vale la
     * pena sapere perché: la centratura porta all'impugnatura il centro del
     * *bounding box*, che per `remote.glb` non coincide con la parte che si
     * impugna. L'offset compensa quello scarto. Se un domani il modello venisse
     * ripulito, andrà ritarato — o meglio, non servirà più.
     */
    const GRIP = { x: 0.01, y: -0.15, z: -0.04, rx: 0, ry: 90, rz: -90 };

    const GRIP_KEY = 'cvtxr.grip';

    /**
     * Giunto su cui appendere l'oggetto, in ordine di preferenza.
     * `middle-finger-metacarpal` sta al centro del palmo — l'osso che va dal
     * polso alla base del medio — ed e' il punto naturale dove appoggia un
     * telecomando. Il polso resta come ripiego.
     */
    const ANCHOR_JOINTS = ['middle-finger-metacarpal', 'wrist'];

    /**
     * Mano dell'impugnatura. **Vincolo, non preferenza**: il telecomando sta
     * nella sinistra e la destra resta libera di premere.
     *
     * Non è pignoleria. Le sorgenti XR sono indicizzate per ordine di
     * connessione, non per lateralità: se spariscono entrambe le mani e torna
     * solo la destra, questa si riconnette sull'indice che prima era della
     * sinistra. Legarsi alla "prima mano disponibile" — o all'ancora appesa a
     * quell'indice — faceva ricomparire il telecomando nella destra. Qui si
     * guarda solo `handedness`, e l'ancora è una sola, che segue la mano giusta.
     */
    let HOLD_HAND = 'left';

    const XRHold = {
        active: false,
        xr: null,
        input: null,
        anchorParentName: null,
        _orig: null,

        // =====================================================================

        /*
         * Vanno avvolti DUE metodi, non uno.
         *
         * `animatePick` è quello che conta: porta l'oggetto in posizione con una
         * TWEEN che scrive posizione e rotazione a ogni frame, e a fine corsa fa
         * `holdContainer.attach(model)`. `updateHeldObjectPosition` viene invece
         * usato solo nel ramo di ripiego senza TWEEN (HoldableSystem.js:442), che
         * non scatta mai perché tween.umd.js è sempre caricato — patcharlo da
         * solo non produce alcun effetto.
         */
        attach: function (xrSession, xrInput) {
            const H = window.HoldableSystem;
            // Le vie d'uscita vanno dette: senza, un aggancio mancato si
            // manifesta solo come "l'oggetto vola via" e non si sa perché.
            if (!H) { console.warn('[XRHold] HoldableSystem assente: aggancio non installato.'); return; }
            if (typeof H.animatePick !== 'function') { console.warn('[XRHold] animatePick assente: aggancio non installato.'); return; }
            if (this._orig) { console.warn('[XRHold] già agganciato, salto.'); return; }

            this.xr = xrSession;
            this.input = xrInput;
            this._orig = H.updateHeldObjectPosition.bind(H);
            this._origPick = H.animatePick.bind(H);

            const self = this;
            const inXR = () => self.xr && self.xr.isPresenting;

            // In VR l'oggetto scatta in mano: l'animazione serviva a farlo entrare
            // nell'inquadratura, ma se lo prendi tu il movimento è già il tuo.
            H.animatePick = function (model, config, onComplete) {
                if (!inXR()) return self._origPick(model, config, onComplete);
                self._placeInHand(model);
                model.userData.pickAnimationProgress = 1;
                console.log(`[XRHold] "${model.name}" agganciato a: ${self.anchorParentName}`);
                if (onComplete) onComplete();
            };

            H.updateHeldObjectPosition = function (model) {
                if (!inXR()) return self._orig(model);
                self._placeInHand(model);
            };

            this.active = true;
            console.log('[XRHold] Oggetti impugnati agganciati alla mano.');
        },

        detach: function () {
            const H = window.HoldableSystem;
            if (H && this._orig) H.updateHeldObjectPosition = this._orig;
            if (H && this._origPick) H.animatePick = this._origPick;
            this._orig = null;
            this._origPick = null;

            // Restituisce al grafo originale gli oggetti che avevamo spostato:
            // altrimenti alla vista desktop resterebbero appesi a un'ancora
            // rimossa insieme al rig.
            [this._anchor, this._head].forEach((a) => {
                if (!a) return;
                [...a.children].forEach((m) => this._restore(m));
                if (a.parent) a.parent.remove(a);
            });
            this._anchor = null;
            this._head = null;

            this.active = false;
        },

        // =====================================================================

        /**
         * Sorgente che regge l'oggetto: **solo** quella con `handedness` uguale
         * a {@link HOLD_HAND}. Mai "la prima disponibile": è così che il
         * telecomando finiva nella destra.
         *
         * @returns {?object} la mano dell'impugnatura, o null per il ripiego
         *          davanti alla testa quando quella mano non c'è.
         */
        _pickSource: function () {
            const src = this.input ? this.input.sources : [];
            // La lateralità arriva dall'evento di connessione, non dall'indice
            // della sorgente. Nessun ripiego "prendi quella che c'è".
            return src.find((s) => s.inputSource && s.hand === HOLD_HAND) || null;
        },

        /**
         * Ancora agganciata al polso quando la mano è tracciata, al controller
         * altrimenti. Il polso è il nodo naturale: l'oggetto segue la rotazione
         * della mano, non quella del raggio di puntamento.
         */
        _anchorFor: function (s) {
            const THREE = window.THREE;

            if (!this._anchor) {
                this._anchor = new THREE.Group();
                this._anchor.name = 'XRHoldAnchor';
            }

            const joints = s.handObj && s.handObj.joints;
            let parent = s.controller;
            let name = 'controller';
            for (const j of ANCHOR_JOINTS) {
                if (joints && joints[j] && joints[j].visible) {
                    parent = joints[j];
                    name = (j === 'wrist') ? 'polso' : 'palmo';
                    break;
                }
            }

            if (this._anchor.parent !== parent) {
                parent.add(this._anchor);
                // Cambiare giunto cambia lo spazio: la centratura va rifatta.
                [...this._anchor.children].forEach((m) => { m.userData._xrHoldCenter = null; });
            }
            this.anchorParentName = `${HOLD_HAND === 'left' ? 'sinistra' : 'destra'}, ${name}`;
            return this._anchor;
        },

        /**
         * L'oggetto resta dov'è quando la mano vincolata smette di essere
         * tracciata.
         *
         * L'ancora è appesa a un GIUNTO, e i giunti appartengono a una sorgente
         * indicizzata per ordine di connessione. Se quell'indice viene riusato
         * dall'altra mano — sparisci con entrambe, torna con la destra — il
         * telecomando comincia a seguire la destra, per giunta con la posa
         * dell'altra mano: si vede il retro. Lasciarlo appeso lì è il difetto,
         * non la soluzione.
         *
         * Si stacca quindi l'ancora dal giunto e la si appende al rig
         * conservando la posa mondo (`attach`, non `add`): l'oggetto resta
         * immobile dove la mano l'ha lasciato, non passa a nessuno, e quando la
         * mano vincolata torna se lo riprende dal palmo.
         */
        _freezeAnchor: function () {
            const rig = this.xr && this.xr.rig;
            if (!this._anchor || !this._anchor.parent || !rig) return;
            if (this._anchor.parent === rig) return;
            rig.attach(this._anchor);
            this.anchorParentName = `${HOLD_HAND} non tracciata: fermo dov'era`;
        },

        /**
         * Ancora di ripiego davanti alla testa. Vale solo per un oggetto che in
         * mano non c'è MAI stato: senza, resterebbe in balia del calcolo di
         * core, che in VR lo scaglia a metri di distanza. Un oggetto già preso
         * non passa mai di qui — verrebbe strappato dalla mano per essere
         * incollato davanti agli occhi, con la posa sbagliata.
         */
        _headAnchor: function () {
            const THREE = window.THREE;
            const S = window.Scene3D;
            if (!this._head) {
                this._head = new THREE.Group();
                this._head.name = 'XRHoldAnchorHead';
                this._head.position.set(0.18, -0.22, -0.45);   // in basso a destra
            }
            if (this._head.parent !== S.camera) S.camera.add(this._head);
            this.anchorParentName = 'testa (nessuna mano tracciata)';
            return this._head;
        },

        _placeInHand: function (model) {
            const s = this._pickSource();

            // Mano vincolata assente: l'oggetto non cambia mano e non finisce
            // davanti alla faccia. Resta immobile dove l'ha lasciato, e la posa
            // non va ricalcolata — è congelata insieme all'ancora.
            if (!s && this._anchor && model.parent === this._anchor) {
                this._freezeAnchor();
                return;
            }

            const anchor = s ? this._anchorFor(s) : this._headAnchor();
            if (!anchor) return;

            if (model.parent !== anchor) {
                if (!model.userData._xrHold) {
                    model.userData._xrHold = {
                        parent: model.parent,
                        scale: model.scale.clone(),
                    };
                }
                anchor.add(model);
                model.userData._xrHoldCenter = null;   // va ricalcolato nel nuovo spazio
            }

            // L'ancora vive sotto il rig, che è scalato di 1/scalaMondo. Senza
            // compensare, l'oggetto rimpicciolirebbe rispetto alla macchina:
            // deve conservare la sua dimensione in unità scena.
            const k = (this.xr.rig && this.xr.rig.scale.x) || 1;
            const base = model.userData._xrHold.scale;

            model.rotation.set(
                GRIP.rx * Math.PI / 180,
                GRIP.ry * Math.PI / 180,
                GRIP.rz * Math.PI / 180
            );
            model.scale.copy(base).multiplyScalar(1 / k);

            model.position.copy(this._centeringOffset(model, anchor, k));
        },

        /**
         * Posizione da dare all'ORIGINE del modello perché il suo **centro
         * visibile** cada su GRIP.
         *
         * Non è un raffinamento: l'origine di molti GLB non sta sulla geometria.
         * `remote.glb` ha il centro visibile a circa 0,85 m dalla propria origine,
         * quindi mettere l'origine al polso spedisce il telecomando visibile
         * quasi un metro più in là — fuori dal campo visivo. È lo stesso motivo
         * per cui HoldableSystem calcola `visibleCenterLocal` (core, righe
         * 380-385): ignorarlo era il vero difetto, non il calcolo sulla camera.
         *
         * Misurato invece che dedotto: si azzera la posizione, si guarda dove
         * finisce il bounding box e si corregge. Vale per qualunque modello, senza
         * sapere nulla della sua gerarchia interna. Il risultato è memorizzato,
         * perché dipende solo da rotazione e scala.
         */
        _centeringOffset: function (model, anchor, k) {
            const THREE = window.THREE;
            const cached = model.userData._xrHoldCenter;
            if (cached && cached.k === k) return cached.pos;

            model.position.set(0, 0, 0);
            model.updateWorldMatrix(true, true);

            const box = new THREE.Box3().setFromObject(model);
            const pos = new THREE.Vector3(GRIP.x, GRIP.y, GRIP.z);

            if (!box.isEmpty()) {
                const centerWorld = box.getCenter(new THREE.Vector3());
                const centerLocal = anchor.worldToLocal(centerWorld);
                pos.sub(centerLocal);
            }

            model.userData._xrHoldCenter = { k, pos };
            return pos;
        },

        _restore: function (model) {
            const saved = model.userData._xrHold;
            if (!saved) return;
            if (saved.parent) saved.parent.add(model);
            model.scale.copy(saved.scale);
            delete model.userData._xrHold;
        },

        // =====================================================================

        /**
         * Taratura dell'impugnatura, a caldo. Posizione in metri rispetto al
         * polso, rotazione in gradi. Serve perché la posa giusta si giudica solo
         * indossando il visore.
         */
        setGrip: function (x, y, z, rx, ry, rz) {
            if (x !== undefined) GRIP.x = x;
            if (y !== undefined) GRIP.y = y;
            if (z !== undefined) GRIP.z = z;
            if (rx !== undefined) GRIP.rx = rx;
            if (ry !== undefined) GRIP.ry = ry;
            if (rz !== undefined) GRIP.rz = rz;
            this._persistGrip();
            this._invalidate();
            console.log(`[XRHold] Impugnatura: pos (${GRIP.x}, ${GRIP.y}, ${GRIP.z}) rot (${GRIP.rx}, ${GRIP.ry}, ${GRIP.rz})`);
            return { ...GRIP };
        },

        /**
         * Rotazione dell'oggetto in mano, per asse. L'asse giusto dipende da come
         * il modello e' orientato nel proprio GLB e non si puo' dedurre: va
         * provato. Da qui e dal selettore sulla pagina 2D.
         * @param {'x'|'y'|'z'} axis
         * @param {number} deg
         */
        rotate: function (axis, deg) {
            const key = 'r' + axis;
            if (!(key in GRIP)) return null;
            GRIP[key] = deg;
            this._persistGrip();
            this._invalidate();
            console.log(`[XRHold] Rotazione ${axis} = ${deg}°`);
            return { ...GRIP };
        },

        getGrip: function () { return { ...GRIP }; },

        /**
         * Cambia la mano dell'impugnatura. Esiste per il mancino, non per il
         * runtime: nessuna logica deve chiamarlo per "seguire" la mano che ha
         * toccato l'oggetto — è esattamente ciò che mandava il telecomando nella
         * mano sbagliata.
         * @param {'left'|'right'} hand
         */
        setHand: function (hand) {
            if (hand !== 'left' && hand !== 'right') return HOLD_HAND;
            HOLD_HAND = hand;
            this._invalidate();
            console.log(`[XRHold] Mano dell'impugnatura: ${HOLD_HAND}`);
            return HOLD_HAND;
        },

        getHand: function () { return HOLD_HAND; },

        /**
         * Il nodo sotto cui vive l'oggetto impugnato, se c'è.
         * Serve a XRInput per sapere cosa sta in mano: i pulsanti di un oggetto
         * impugnato non devono essere premibili dalla mano che lo regge.
         */
        getAnchor: function () { return this._anchor && this._anchor.parent ? this._anchor : null; },

        /** La centratura dipende da rotazione e scala: cambiandole va rifatta. */
        _invalidate: function () {
            [this._anchor, this._head].forEach((a) => {
                if (a) [...a.children].forEach((m) => { m.userData._xrHoldCenter = null; });
            });
        },

        _persistGrip: function () {
            try { localStorage.setItem(GRIP_KEY, JSON.stringify(GRIP)); } catch (e) { /* storage negato */ }
        },

        _loadGrip: function () {
            try {
                const raw = JSON.parse(localStorage.getItem(GRIP_KEY));
                if (raw && typeof raw === 'object') Object.keys(GRIP).forEach((k) => {
                    if (typeof raw[k] === 'number') GRIP[k] = raw[k];
                });
            } catch (e) { /* niente di salvato */ }
        },

        debugInfo: function () {
            const H = window.HoldableSystem;
            const s = this._pickSource();
            const info = {
                attivo: this.active,
                manoVincolata: HOLD_HAND,
                manoUsata: s ? `${s.hand || HOLD_HAND}${s.isHand ? ' (mano)' : ' (controller)'}` : 'nessuna → testa',
                ancorataA: this.anchorParentName || '-',
                oggettiImpugnati: H && H.heldObjects ? (H.heldObjects.size ?? H.heldObjects.length ?? '?') : 'n/d',
                impugnatura: { ...GRIP },
            };
            console.table(info);
            return info;
        },
    };

    XRHold._loadGrip();
    window.XRHold = XRHold;
})();
