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
 * mouse (`UI.nextStep()`, `UI.prevStep()`, il click sul vero `#infoModalOkBtn`).
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

    /** Distanza e altezza del pannello rispetto alla testa, in metri. */
    let DIST = 1.0;
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

            this.panel = this._makeQuad(PANEL_W, PANEL_H, TEX_W, TEX_H);
            this.root.add(this.panel);

            this.btnPrev = this._makeButton('◀  Indietro', 'prev');
            this.btnNext = this._makeButton('Avanti  ▶', 'next');
            this.btnOk = this._makeButton('OK', 'ok');
            this.buttons = [this.btnPrev, this.btnNext, this.btnOk];

            const y = -PANEL_H / 2 - BTN_H / 2 - BTN_GAP;
            this.btnPrev.position.set(-(BTN_W + BTN_GAP) / 2, y, 0);
            this.btnNext.position.set((BTN_W + BTN_GAP) / 2, y, 0);
            this.btnOk.position.set(0, y, 0);
            this.buttons.forEach((b) => this.root.add(b));

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
            this.panel = null;
            this.buttons = [];
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
            g.fillText(mesh.userData.label, c.width / 2, c.height / 2 + 2);

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
            const modal = document.getElementById('infoModal');
            const modalOpen = !!modal && modal.classList.contains('show');

            if (modalOpen) {
                const t = document.getElementById('infoModalTitle');
                const m = document.getElementById('infoModalMessage');
                return {
                    mode: 'modal',
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
                    body: 'Esci dalla VR e scegli un tutorial dalla pagina, poi rientra.',
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

            const st = this._readState();
            const key = `${st.mode}|${st.counter}|${st.title}|${st.body}`;
            if (key !== this._stateKey) {
                this._stateKey = key;
                this._state = st;
                this._drawPanel(st);
                this._applyButtons(st);
            }

            this._place();
        },

        /**
         * Quali pulsanti hanno senso adesso.
         * Con un modale aperto esiste solo OK: offrire "Avanti" mentre `core/`
         * aspetta la chiusura del modale porterebbe a due navigazioni in volo.
         */
        _applyButtons: function (st) {
            const modal = st.mode === 'modal';
            const prev = !modal && st.mode === 'step' && st.idx > 0;
            const next = !modal && st.mode === 'step';

            const changed = this.btnOk.visible !== modal
                || this.btnPrev.visible !== prev
                || this.btnNext.visible !== next;

            this.btnOk.visible = modal;
            this.btnPrev.visible = prev;
            this.btnNext.visible = next;

            // Con una freccia sola, al centro: due pulsanti asimmetrici ai lati
            // si prendono a caso.
            this.btnNext.position.x = prev ? (BTN_W + BTN_GAP) / 2 : 0;

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

            this._v.set(
                head.x - Math.sin(yaw) * DIST,
                head.y - DROP,
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
            if (!this.enabled || !this._visible) return null;
            return this.buttons.filter((b) => b.visible);
        },

        /**
         * Esegue l'azione di un pulsante.
         *
         * Sempre passando per le stesse strade del mouse: `UI.nextStep()`,
         * `UI.prevStep()`, e per il modale un click vero sul pulsante vero —
         * è quel click che risolve la promise su cui `core/` è fermo, e
         * riprodurne gli effetti a mano vorrebbe dire riscriverne la chiusura.
         *
         * @returns {boolean} true se l'azione è stata riconosciuta.
         */
        activate: function (mesh) {
            const action = mesh && mesh.userData && mesh.userData.xrUiAction;
            if (!action) return false;

            this._flash(mesh);

            if (action === 'ok') {
                const btn = document.getElementById('infoModalOkBtn');
                if (btn) { btn.click(); console.log('[XRUI] Modale chiuso.'); }
                return true;
            }
            const U = window.UI;
            if (action === 'next' && U && typeof U.nextStep === 'function') {
                U.nextStep();
                console.log('[XRUI] Avanti.');
                return true;
            }
            if (action === 'prev' && U && typeof U.prevStep === 'function') {
                U.prevStep();
                console.log('[XRUI] Indietro.');
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
            if (this.root) this.root.visible = this._visible;
            this.version++;
            return this._visible;
        },

        /**
         * @param {number} [distance] distanza dalla testa, in metri.
         * @param {number} [drop] quanto sotto la linea dello sguardo.
         */
        setPlacement: function (distance, drop) {
            if (distance !== undefined) DIST = Math.max(0.4, Math.min(3, Number(distance) || DIST));
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
