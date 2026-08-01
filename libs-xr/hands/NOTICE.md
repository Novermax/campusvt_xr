# Modelli di mano — attribuzione

`left.glb` e `right.glb` provengono dal profilo `generic-hand` di
**WebXR Input Profiles**, progetto del W3C Immersive Web Working Group:

<https://github.com/immersive-web/webxr-input-profiles>
`packages/assets/profiles/generic-hand/`

Licenza: **W3C Software and Document License**
<https://www.w3.org/Consortium/Legal/copyright-software>

## Perché stanno qui

Sono gli stessi asset che `XRHandModelFactory` di Three.js scarica da
`cdn.jsdelivr.net` quando lo si usa col profilo `mesh`. Vendorizzarli li rende
serviti dalla nostra stessa origin: nessuna dipendenza da CDN esterni a runtime,
coerente con il resto del progetto, che tiene in locale anche Three.js.

## Struttura, per chi dovrà metterci mano

Mesh skinnata singola, rigata su **25 ossa i cui nomi coincidono esattamente con
i giunti WebXR** (`wrist`, `index-finger-tip`, …). Le ossa sono tutte figlie
dirette di `Armature`, che è a identità: la posa di ogni giunto si copia
sull'osso omonimo senza composizioni gerarchiche.

L'aggiornamento sta in `xr/XRInput.js`, `_updateHandBones`.
