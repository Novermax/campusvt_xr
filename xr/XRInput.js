/**
 * XRInput.js — input dai controller del Meta Quest 3.
 *
 * MILESTONE 3. Cambia una sola cosa rispetto al desktop: **da dove nasce il ray**.
 * Sul desktop parte dal mouse attraverso la camera
 * (`raycaster.setFromCamera(mouse, camera)`, 15 punti in core); qui parte dal
 * controller. Da lì in poi il dispatch è identico e passa per la stessa API
 * basata su mesh già usata dal layer touch:
 *
 *   window.InteractiveObject3D.handleClick(mesh, opts)
 *   window.Scene3D.handleModelAction(rootModel)
 *   window.StepController.triggerStep('physical', triggerId)
 *
 * L'ordine di priorità replica quello di `core/js/scene3d-modular.js`
 * handleModelClick, compreso il ripiego sui pulsanti evidenziati: con un
 * puntatore laser i bersagli piccoli come `pulpito.Pulsante_mdi` restano
 * difficili, e quel ripiego è ciò che li rende raggiungibili.
 *
 * Non tocca `core/`.
 */

(function () {
    'use strict';

    /** Lunghezza del raggio quando non colpisce nulla, in unità scena. */
    const RAY_DEFAULT_LENGTH = 5;

    const COLOR_IDLE = 0x9fb4c7;   // grigio-azzurro: non c'è nulla da premere
    const COLOR_HOT = 0xffd21e;    // giallo: bersaglio interattivo sotto il raggio
    const COLOR_FIRED = 0xffffff;  // lampo bianco: comando andato a segno

    /** Durata del lampo di conferma, in ms. */
    const FLASH_MS = 160;

    const XRInput = {
        enabled: false,
        xr: null,
        controllers: [],
        hovered: null,
        lastHit: null,

        _raycaster: null,
        _tmpMatrix: null,

        // =====================================================================
        // Ciclo di vita
        // =====================================================================

        /** @param {object} xrSession istanza di window.XRSession */
        init: function (xrSession) {
            if (this.enabled) return;
            const S = window.Scene3D;
            const THREE = window.THREE;
            if (!S || !S.renderer || !xrSession.rig) return;

            this.xr = xrSession;
            this._raycaster = new THREE.Raycaster();
            this._tmpMatrix = new THREE.Matrix4();

            for (let i = 0; i < 2; i++) this.controllers.push(this._buildController(i));

            this.enabled = true;
            console.log('[XRInput] Controller attivi. Trigger per interagire.');
        },

        dispose: function () {
            const S = window.Scene3D;
            this.controllers.forEach((c) => {
                c.controller.removeEventListener('selectstart', c.onSelectStart);
                c.controller.removeEventListener('connected', c.onConnected);
                c.controller.removeEventListener('disconnected', c.onDisconnected);
                if (c.controller.parent) c.controller.parent.remove(c.controller);
                c.ray.geometry.dispose();
                c.ray.material.dispose();
            });
            this.controllers = [];
            this.hovered = null;
            this.enabled = false;
            if (window.InteractiveObject3D) window.InteractiveObject3D.handleHover(null);
        },

        /**
         * I controller vanno appesi al RIG, non alla scena: devono seguire
         * l'operatore quando si sposta e subire la stessa scala del mondo, come
         * la testa. Appesi alla scena resterebbero a terra e di misura sbagliata.
         */
        _buildController: function (index) {
            const S = window.Scene3D;
            const THREE = window.THREE;
            const rig = this.xr.rig;

            const controller = S.renderer.xr.getController(index);

            // Raggio: segmento unitario lungo -Z, allungato ogni frame fino al bersaglio.
            const geom = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -1),
            ]);
            const ray = new THREE.Line(geom, new THREE.LineBasicMaterial({
                color: COLOR_IDLE,
                transparent: true,
                opacity: 0.8,
                depthTest: false,   // resta visibile anche dentro la geometria
            }));
            ray.renderOrder = 999;
            ray.scale.z = RAY_DEFAULT_LENGTH;
            controller.add(ray);

            // Nessuna geometria sullo spazio grip. Un proxy disegnato da noi si
            // sovrappone alla mano tracciata e la nasconde: il visore le disegna
            // già, e meglio. Vale anche per i controller, per cui non usiamo
            // nemmeno XRControllerModelFactory — che oltretutto scaricherebbe i
            // profili da un CDN esterno, mentre qui si vendorizza tutto in locale.
            const entry = { index, controller, ray, hand: null, isHand: false, inputSource: null, flashUntil: 0 };

            entry.onConnected = (e) => {
                entry.inputSource = e.data;
                entry.hand = e.data.handedness;
                // Mani tracciate: stesso target ray, ma il pinch sostituisce il
                // trigger, non esistono aptica né thumbstick, e non c'è gripSpace
                // — quindi il corpo del controller resta giustamente invisibile.
                entry.isHand = !!e.data.hand;
                console.log(`[XRInput] ${entry.hand || '?'}: ${entry.isHand ? 'mano tracciata (pinch)' : 'controller (trigger)'}`);
            };
            entry.onDisconnected = () => { entry.inputSource = null; entry.hand = null; entry.isHand = false; };
            entry.onSelectStart = () => this._onSelect(entry);

            controller.addEventListener('connected', entry.onConnected);
            controller.addEventListener('disconnected', entry.onDisconnected);
            controller.addEventListener('selectstart', entry.onSelectStart);

            rig.add(controller);
            return entry;
        },

        // =====================================================================
        // Frame
        // =====================================================================

        /** Chiamato a ogni frame XR da XRSession. Aggiorna hover e lunghezza raggio. */
        update: function () {
            if (!this.enabled) return;

            let best = null;
            let bestCtrl = null;

            const now = performance.now();
            for (const c of this.controllers) {
                const hit = this._firstActionableHit(c);
                this._stretchRay(c, hit ? hit.distance : null);
                // Il lampo di conferma vince sul colore di hover finché dura.
                c.ray.material.color.setHex(
                    now < c.flashUntil ? COLOR_FIRED : (hit ? COLOR_HOT : COLOR_IDLE)
                );
                if (hit && (!best || hit.distance < best.distance)) { best = hit; bestCtrl = c; }
            }

            const mesh = best ? best.object : null;
            if (mesh !== this.hovered) {
                this.hovered = mesh;
                // Riusa il feedback visivo già esistente per l'hover del mouse.
                if (window.InteractiveObject3D) window.InteractiveObject3D.handleHover(mesh);
                if (mesh && bestCtrl) this._pulse(bestCtrl, 0.15, 12);
            }
            this.lastHit = best;
        },

        /**
         * Il raggio è figlio del controller, quindi la sua scala è in unità locali:
         * la distanza dell'intersezione è in unità mondo e va divisa per la scala
         * del rig, altrimenti con scala mondo diversa da 1 il raggio si ferma corto.
         */
        _stretchRay: function (c, worldDistance) {
            const rigScale = (this.xr.rig && this.xr.rig.scale.x) || 1;
            const d = worldDistance === null ? RAY_DEFAULT_LENGTH : worldDistance;
            c.ray.scale.z = Math.max(0.01, d / rigScale);
        },

        // =====================================================================
        // Raycast
        // =====================================================================

        /** Costruisce il ray dalla posa del controller. Sostituisce setFromCamera. */
        _aimFrom: function (c) {
            this._tmpMatrix.identity().extractRotation(c.controller.matrixWorld);
            this._raycaster.ray.origin.setFromMatrixPosition(c.controller.matrixWorld);
            this._raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tmpMatrix).normalize();
            return this._raycaster;
        },

        /** @returns {?THREE.Intersection} primo bersaglio su cui il trigger farebbe qualcosa. */
        _firstActionableHit: function (c) {
            const S = window.Scene3D;
            if (!S || !S.loadedModels || !S.loadedModels.length) return null;
            if (S.tutorialTracker && S.tutorialTracker.interactionsBlocked) return null;

            const ray = this._aimFrom(c);
            const hits = ray.intersectObjects(S.loadedModels, true);

            for (const h of hits) {
                if (h.object.userData && h.object.userData.interactive) return h;
            }

            // Ripiego sui pulsanti evidenziati: bersagli piccoli o coperti da altra
            // geometria. Stessa logica del desktop (scene3d-modular.js:1707).
            const hl = window.InteractiveObject3D && window.InteractiveObject3D.highlightedButtons;
            if (hl && hl.size) {
                for (const [, mesh] of hl) {
                    const direct = ray.intersectObject(mesh, true);
                    if (direct.length) return direct[0];
                }
            }

            // Modello selezionabile: elemento dello step corrente.
            if (hits.length) {
                const root = S.findRootModel(hits[0].object);
                if (root && S.isModelSelectable(root)) return hits[0];
            }
            return null;
        },

        // =====================================================================
        // Trigger
        // =====================================================================

        /**
         * Replica l'ordine di priorità di handleModelClick del desktop:
         * figlio interattivo, poi ripiego sui pulsanti evidenziati, poi azione
         * sul modello radice.
         */
        _onSelect: function (c) {
            if (!this.enabled) return;
            const S = window.Scene3D;
            if (!S) return;

            if (S.tutorialTracker && S.tutorialTracker.interactionsBlocked) {
                console.log('[XRInput] Interazioni bloccate: tutorial completato.');
                return;
            }

            const ray = this._aimFrom(c);
            const hits = ray.intersectObjects(S.loadedModels, true);
            const IO = window.InteractiveObject3D;

            // 1. figlio interattivo colpito direttamente
            if (IO) {
                for (const h of hits) {
                    if (!h.object.userData || !h.object.userData.interactive) continue;
                    if (IO.handleClick(h.object, { isXR: true, point: h.point })) {
                        this._confirm(c);
                        console.log(`[XRInput] ✅ ${h.object.name} gestito da InteractiveObject3D`);
                        return;
                    }
                }

                // 2. ripiego sui pulsanti evidenziati (piccoli o occlusi)
                const hl = IO.highlightedButtons;
                if (hl && hl.size) {
                    for (const [, mesh] of hl) {
                        if (!ray.intersectObject(mesh, true).length) continue;

                        if (IO.handleClick(mesh, { isXR: true })) {
                            this._confirm(c);
                            console.log(`[XRInput] ✅ ripiego evidenziato: ${mesh.name}`);
                            return;
                        }
                        // Mesh evidenziata ma non registrata come InteractiveChild
                        // (es. a500.porta): si passa dall'azione sul modello radice.
                        const root = S.findRootModel(mesh);
                        if (root && S.isModelSelectable(root) && this._modelAction(root, c)) return;
                    }
                }
            }

            // 3. azione sul modello radice
            if (hits.length) {
                const root = S.findRootModel(hits[0].object);
                if (root && S.isModelSelectable(root) && this._modelAction(root, c)) return;
            }

            console.log('[XRInput] Trigger a vuoto: nessun bersaglio.');
        },

        _modelAction: function (root, c) {
            const S = window.Scene3D;
            // Come sul desktop: se il DragDropSystem è attivo gestisce lui.
            if (S.dragDropSystem && S.dragDropSystem.enabled) return false;
            S.handleModelAction(root);
            this._confirm(c);
            console.log(`[XRInput] ✅ azione su modello: ${root.name}`);
            return true;
        },

        // =====================================================================
        // Aptica
        // =====================================================================

        _pulse: function (c, intensity, ms) {
            const gp = c.inputSource && c.inputSource.gamepad;
            const act = gp && gp.hapticActuators && gp.hapticActuators[0];
            if (act && act.pulse) { try { act.pulse(intensity, ms); } catch (e) { /* non supportato */ } }
        },

        /**
         * Conferma di comando eseguito: vibrazione più lampo bianco del raggio.
         * Il lampo non è ridondante — con le mani tracciate non esiste aptica, e
         * senza di esso resterebbe zero conferma dell'azione andata a segno.
         */
        _confirm: function (c) {
            this._pulse(c, 0.5, 30);
            c.flashUntil = performance.now() + FLASH_MS;
            c.ray.material.color.setHex(COLOR_FIRED);
        },

        // =====================================================================
        // Debug
        // =====================================================================

        debugInfo: function () {
            const info = {
                attivo: this.enabled,
                sorgenti: this.controllers
                    .map((c) => c.inputSource ? `${c.hand} = ${c.isHand ? 'mano (pinch)' : 'controller (trigger)'}` : `#${c.index} non connesso`)
                    .join('  |  ') || 'nessuna',
                aptica: this.controllers.some((c) => c.inputSource && !c.isHand) ? 'disponibile' : 'no (mani tracciate)',
                sottoIlRaggio: this.hovered ? this.hovered.name : 'niente',
                distanza: this.lastHit ? +this.lastHit.distance.toFixed(2) : null,
                pulsantiEvidenziati: window.InteractiveObject3D && window.InteractiveObject3D.highlightedButtons
                    ? [...window.InteractiveObject3D.highlightedButtons.keys()] : [],
            };
            console.table(info);
            return info;
        },
    };

    window.XRInput = XRInput;
})();
