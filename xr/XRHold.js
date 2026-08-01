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

    /** Posa dell'oggetto rispetto al polso, in metri fisici. Il polso WebXR ha
     *  +Y verso le dita, +Z verso il dorso. Tarabile con `XRHold.setGrip`. */
    const GRIP = { x: 0, y: 0.055, z: -0.015, rx: -20, ry: 0, rz: 0 };

    /** Mano preferita per l'impugnatura. La destra resta libera di premere. */
    const PREFERRED_HAND = 'left';

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
            const anchors = (this.input ? this.input.sources : []).map((s) => s._holdAnchor);
            if (this._head) anchors.push(this._head);
            anchors.forEach((a) => {
                if (!a) return;
                [...a.children].forEach((m) => this._restore(m));
                if (a.parent) a.parent.remove(a);
            });
            (this.input ? this.input.sources : []).forEach((s) => { s._holdAnchor = null; });
            this._head = null;

            this.active = false;
        },

        // =====================================================================

        /** Sorgente da usare per l'impugnatura: la preferita se c'è, altrimenti l'altra. */
        _pickSource: function () {
            const src = this.input ? this.input.sources : [];
            return src.find((s) => s.inputSource && s.hand === PREFERRED_HAND)
                || src.find((s) => s.inputSource)
                || null;
        },

        /**
         * Ancora agganciata al polso quando la mano è tracciata, al controller
         * altrimenti. Il polso è il nodo naturale: l'oggetto segue la rotazione
         * della mano, non quella del raggio di puntamento.
         */
        _anchorFor: function (s) {
            const THREE = window.THREE;
            const joints = s.handObj && s.handObj.joints;
            const wrist = joints && joints.wrist;
            const parent = (wrist && wrist.visible) ? wrist : s.controller;

            if (!s._holdAnchor) {
                s._holdAnchor = new THREE.Group();
                s._holdAnchor.name = 'XRHoldAnchor';
            }
            if (s._holdAnchor.parent !== parent) parent.add(s._holdAnchor);
            this.anchorParentName = (parent === s.controller) ? 'controller' : 'polso';
            return s._holdAnchor;
        },

        /**
         * Ancora di ripiego davanti alla testa, usata quando nessuna mano è
         * tracciata. Non è una comodità: senza, l'oggetto resterebbe in balia del
         * calcolo di core, che in VR lo scaglia a metri di distanza. Meglio
         * averlo davanti agli occhi che non sapere dove sia finito.
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
            }

            // L'ancora vive sotto il rig, che è scalato di 1/scalaMondo. Senza
            // compensare, l'oggetto rimpicciolirebbe rispetto alla macchina:
            // deve conservare la sua dimensione in unità scena.
            const k = (this.xr.rig && this.xr.rig.scale.x) || 1;
            const base = model.userData._xrHold.scale;

            model.position.set(GRIP.x, GRIP.y, GRIP.z);
            model.rotation.set(
                GRIP.rx * Math.PI / 180,
                GRIP.ry * Math.PI / 180,
                GRIP.rz * Math.PI / 180
            );
            model.scale.copy(base).multiplyScalar(1 / k);
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
            console.log(`[XRHold] Impugnatura: pos (${GRIP.x}, ${GRIP.y}, ${GRIP.z}) rot (${GRIP.rx}, ${GRIP.ry}, ${GRIP.rz})`);
            return { ...GRIP };
        },

        debugInfo: function () {
            const H = window.HoldableSystem;
            const s = this._pickSource();
            const info = {
                attivo: this.active,
                manoUsata: s ? `${s.hand}${s.isHand ? ' (mano)' : ' (controller)'}` : 'nessuna',
                ancorataA: this.anchorParentName || '-',
                oggettiImpugnati: H && H.heldObjects ? (H.heldObjects.size ?? H.heldObjects.length ?? '?') : 'n/d',
                impugnatura: { ...GRIP },
            };
            console.table(info);
            return info;
        },
    };

    window.XRHold = XRHold;
})();
