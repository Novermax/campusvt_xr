/**
 * XRCover.js — la copertina, e il perché di un gesto in più.
 *
 * La versione WebXR si apre su un quadro a tutta pagina con un solo pulsante:
 * **Entra**. Premutolo, si scopre il login di sempre e da lì si prosegue.
 *
 * Sembra un passaggio in più, e lo è: serve a comprare un gesto dell'utente.
 * Due cose, nel browser del visore, non si possono fare da sole al caricamento
 * della pagina, per regola dei browser e non per scelta nostra:
 *
 *  - **entrare in una sessione immersiva** richiede una *user activation*, cioè
 *    un tocco vero. Senza, `requestSession` viene rifiutata;
 *  - **l'audio** non parte finché non c'è stata un'interazione.
 *
 * Con l'ingresso diretto sul login quel gesto è la pressione di «Accedi», che
 * arriva quando la sessione non è ancora pronta e non si può ancora usare. La
 * copertina lo sposta all'inizio, dove non dà fastidio a nessuno.
 *
 * L'altro motivo è che il visore non è un desktop: la pagina si apre dentro un
 * browser che galleggia in aria, spesso mentre ci si sta ancora sistemando le
 * cinghie. Una schermata unica e ferma, con un solo bersaglio grande, è molto
 * più facile da centrare di un modulo con due campi di testo.
 *
 * Non tocca `core/`: la copertina è un velo sopra la pagina, e quando si toglie
 * sotto c'è esattamente ciò che ci sarebbe stato comunque.
 */

(function () {
    'use strict';

    const XRCover = {
        el: null,

        init: function () {
            const el = document.getElementById('xrCover');
            if (!el) return;
            this.el = el;

            const btn = document.getElementById('xrCoverEnter');
            if (btn) btn.addEventListener('click', () => this.enter());

            // La copertina non deve poter diventare una trappola: se l'immagine
            // non arriva — cache vuota, rete lenta, file rinominato a monte —
            // resta comunque il pulsante su fondo pieno. Meglio una copertina
            // spoglia che una pagina che non si supera.
            const art = document.getElementById('xrCoverArt');
            if (art) art.addEventListener('error', () => {
                art.style.display = 'none';
                console.warn('[XRCover] Copertina non caricata: resta il solo pulsante.');
            });

            // Con la tastiera: Invio o Spazio su qualunque punto del velo.
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.enter(); }
            });
            if (btn) btn.focus();

            console.log('[XRCover] Copertina mostrata.');
        },

        /** Toglie il velo. Una volta sola: non c'è modo di tornare indietro,
         *  e non deve esserci — dietro c'è il login, che ha già il suo. */
        enter: function () {
            if (!this.el || this.el.classList.contains('xr-cover--gone')) return;
            this.el.classList.add('xr-cover--gone');
            // Rimosso dopo la dissolvenza: lasciarlo, anche invisibile,
            // significherebbe un elemento a tutto schermo sopra la pagina che
            // continua a intercettare i tocchi.
            setTimeout(() => {
                if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
                this.el = null;
            }, 450);
            console.log('[XRCover] Ingresso: si passa al login.');
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => XRCover.init());
    } else {
        XRCover.init();
    }

    window.XRCover = XRCover;
})();
