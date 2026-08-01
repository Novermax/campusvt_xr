/**
 * XRButton.js — pulsante di ingresso/uscita dalla sessione immersiva.
 *
 * Scritto a mano invece di usare l'addon `VRButton.js` di Three.js: sono ~40
 * righe utili, e così non aggiungiamo un file da tenere allineato alla r155 né
 * dipendenze da CDN esterne (che la pipeline offline di CVT non gradirebbe).
 *
 * Compare solo quando la scena 3D esiste, cioè dentro uno scenario: prima non
 * ci sarebbe niente da vedere in VR.
 */

(function () {
    'use strict';

    /** Altezze occhi selezionabili, in metri. null = statura reale dell'operatore. */
    const EYE_HEIGHTS = [
        { label: 'Altezza reale', value: null },
        { label: '150 cm', value: 1.50 },
        { label: '160 cm', value: 1.60 },
        { label: '165 cm', value: 1.65 },
        { label: '170 cm', value: 1.70 },
        { label: '175 cm', value: 1.75 },
        { label: '180 cm', value: 1.80 },
    ];

    const XRButton = {
        el: null,
        bar: null,
        xr: null,

        /**
         * @param {object} xrSession istanza di window.XRSession
         * @param {{supported:boolean, reason:string}} probe esito della sonda capability
         */
        mount: function (xrSession, probe) {
            if (this.el) return;
            this.xr = xrSession;

            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'xr-enter-btn';
            this.el = el;

            if (!probe.supported) {
                el.classList.add('xr-enter-btn--disabled');
                el.disabled = true;
                el.textContent = '🥽 VR non disponibile';
                el.title = probe.reason;
            } else {
                el.textContent = '🥽 Entra in VR';
                el.title = 'Avvia la sessione immersiva sul visore';
                el.addEventListener('click', () => this._toggle());
            }

            const bar = document.createElement('div');
            bar.className = 'xr-bar';
            bar.appendChild(el);
            // Sempre presenti, anche dove immersive-vr manca: le impostazioni sono
            // persistite, quindi si preparano da desktop e poi si indossa il visore.
            bar.appendChild(this._buildScaleSlider(xrSession));
            bar.appendChild(this._buildHeightPicker(xrSession));
            bar.appendChild(this._buildGripPicker());
            document.body.appendChild(bar);
            this.bar = bar;

            // Il log va letto uscendo dalla sessione, quindi vive qui sulla 2D.
            if (window.XRLog) window.XRLog.mount(bar);

            xrSession.on('enter', () => this._setState(true));
            xrSession.on('exit', () => {
                this._setState(false);
                // Si apre da solo appena si torna alla 2D: è l'unico momento in
                // cui il log si può leggere comodamente, e cercarlo a mano dentro
                // il visore è scomodo.
                if (window.XRLog) window.XRLog.toggle(true);
            });
            // La scala si può tarare col thumbstick dentro la sessione: al ritorno
            // lo slider deve mostrare il valore effettivamente raggiunto.
            xrSession.on('scale', () => this._syncScale());
        },

        /**
         * Scala del mondo. Slider e non menu a tendina: serve per fare prove, e il
         * valore giusto si trova per tentativi.
         */
        _buildScaleSlider: function (xrSession) {
            const wrap = document.createElement('label');
            wrap.className = 'xr-scale';
            wrap.title = 'Quanto appare grande la macchina.\n'
                + 'Regolabile anche dentro la sessione, col thumbstick destro su/giù.';

            const txt = document.createElement('span');
            txt.textContent = 'Scala mondo';
            wrap.appendChild(txt);

            const input = document.createElement('input');
            input.type = 'range';
            input.min = '0.5';
            input.max = '2.5';
            input.step = '0.05';
            input.value = String(xrSession.getWorldScale());
            wrap.appendChild(input);

            const out = document.createElement('output');
            out.textContent = (+input.value).toFixed(2) + '×';
            wrap.appendChild(out);

            input.addEventListener('input', () => {
                out.textContent = (+input.value).toFixed(2) + '×';
                xrSession.setWorldScale(parseFloat(input.value));
            });

            this._scaleInput = input;
            this._scaleOutput = out;
            return wrap;
        },

        /**
         * Rotazione dell'oggetto impugnato. Due controlli, asse e angolo, perché
         * quale asse produca la rotazione voluta dipende da come il modello è
         * orientato nel proprio GLB: non è deducibile, va provato. Meglio poterlo
         * fare qui che aspettare una nuova pubblicazione a ogni tentativo.
         */
        _buildGripPicker: function () {
            const XH = window.XRHold;
            const wrap = document.createElement('label');
            wrap.className = 'xr-height';
            wrap.title = 'Come sta ruotato in mano l\'oggetto impugnato.\n'
                + 'Se l\'asse scelto non lo gira come vuoi, provane un altro.';

            const txt = document.createElement('span');
            txt.textContent = 'Rotazione in mano';
            wrap.appendChild(txt);

            const grip = XH ? XH.getGrip() : { rx: 0, ry: 0, rz: 90 };
            const axisSel = document.createElement('select');
            [['z', 'asse Z'], ['x', 'asse X'], ['y', 'asse Y']].forEach(([v, label]) => {
                const o = document.createElement('option');
                o.value = v; o.textContent = label;
                axisSel.appendChild(o);
            });

            const degSel = document.createElement('select');
            [0, 90, 180, 270].forEach((d) => {
                const o = document.createElement('option');
                o.value = String(d); o.textContent = d + '°';
                if (grip.rz === d) o.selected = true;
                degSel.appendChild(o);
            });

            const apply = () => {
                if (!window.XRHold) return;
                window.XRHold.rotate(axisSel.value, parseInt(degSel.value, 10));
            };
            axisSel.addEventListener('change', () => {
                // Cambiando asse si azzerano gli altri, altrimenti le rotazioni
                // si sommano e diventa impossibile capire cosa sta agendo.
                ['x', 'y', 'z'].forEach((a) => { if (a !== axisSel.value) window.XRHold?.rotate(a, 0); });
                apply();
            });
            degSel.addEventListener('change', apply);

            wrap.appendChild(axisSel);
            wrap.appendChild(degSel);
            return wrap;
        },

        /** Riallinea lo slider al valore corrente, dopo la taratura col thumbstick. */
        _syncScale: function () {
            if (!this._scaleInput) return;
            const s = this.xr.getWorldScale();
            this._scaleInput.value = String(s);
            this._scaleOutput.textContent = s.toFixed(2) + '×';
        },

        /**
         * Selettore dell'altezza occhi. Sta qui, sulla pagina 2D, perché in VR non
         * c'è ancora modo di interagire: i controller arrivano con la milestone 3.
         * La scelta è persistita, quindi si imposta una volta sola.
         */
        _buildHeightPicker: function (xrSession) {
            const wrap = document.createElement('label');
            wrap.className = 'xr-height';
            wrap.title = 'Altezza degli occhi dell\'operatore sopra il pavimento.\n'
                + 'Utile se la calibrazione del pavimento del visore è imprecisa, '
                + 'o per far vedere la macchina a tutti dalla stessa altezza.';

            const txt = document.createElement('span');
            txt.textContent = 'Altezza occhi';
            wrap.appendChild(txt);

            const sel = document.createElement('select');
            const current = xrSession.getEyeHeight();
            EYE_HEIGHTS.forEach((o) => {
                const opt = document.createElement('option');
                opt.textContent = o.label;
                opt.value = o.value === null ? 'auto' : String(o.value);
                if ((current === null && o.value === null) || current === o.value) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => {
                xrSession.setEyeHeight(sel.value === 'auto' ? null : parseFloat(sel.value));
            });
            wrap.appendChild(sel);
            return wrap;
        },

        _toggle: async function () {
            const el = this.el;
            el.disabled = true;
            try {
                if (this.xr.isPresenting) {
                    await this.xr.exitVR();
                } else {
                    el.textContent = '🥽 Avvio…';
                    const ok = await this.xr.enterVR();
                    if (!ok) {
                        el.textContent = '🥽 Avvio fallito — riprova';
                        setTimeout(() => this._setState(false), 2500);
                    }
                }
            } finally {
                el.disabled = false;
            }
        },

        _setState: function (presenting) {
            if (!this.el) return;
            this.el.textContent = presenting ? '🥽 Esci dalla VR' : '🥽 Entra in VR';
            this.el.classList.toggle('xr-enter-btn--active', presenting);
        },
    };

    window.XRButton = XRButton;
})();
