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

    const XRButton = {
        el: null,
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

            document.body.appendChild(el);

            xrSession.on('enter', () => this._setState(true));
            xrSession.on('exit', () => this._setState(false));
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
