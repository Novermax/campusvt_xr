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
            // Sempre presente, anche dove immersive-vr manca: l'impostazione è
            // persistita, quindi si può preparare da desktop e poi indossare il visore.
            bar.appendChild(this._buildHeightPicker(xrSession));
            document.body.appendChild(bar);
            this.bar = bar;

            xrSession.on('enter', () => this._setState(true));
            xrSession.on('exit', () => this._setState(false));
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
