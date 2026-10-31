# Spec technique : lot 1, watermark personnalisable

Statut : v1, **à relire avant implémentation**. Dérive de `doc/Spec_customization.md` (v2) et des décisions du 2026-10-31 :

- le code actuel fait foi pour les valeurs par défaut ;
- pas de preview live de la vue client (voir `doc/Spec_tech_vue_client.md`) ;
- seule la couleur de fond est personnalisable côté client.

Ce document contient aussi le **socle partagé** avec le lot 2 : table `GallerySettings`, routes `/settings`, flux d'upload de fichiers de branding. Le lot 2 s'y appuie et ne le redéfinit pas.

Règle de périmètre : tout ce qui n'est pas listé ici n'est pas fait.

## 1. Périmètre

Dans le lot :

- image du watermark (PNG uploadé par Emma), position (5 presets), opacité, taille ;
- aperçu rendu par le back sur une photo de test fixe ;
- « Revenir au watermark par défaut » ;
- avertissement « s'applique aux prochaines photos » à l'enregistrement.

Hors lot (rappel des non-objectifs du §2 de la spec) : régénération des previews existantes, choix d'une photo comme image d'aperçu, historique, rotation, mosaïque, réglage de la marge, réglage par collection.

## 2. État actuel du code (faits vérifiés)

| Sujet | Constat | Où |
|---|---|---|
| Source des réglages | Constantes de module lues dans `process.env` à l'import : `WATERMARK_ASSET_PATH`, `WATERMARK_OPACITY` (0–1, défaut 0.6), `WATERMARK_POSITION` (défaut `southeast`), `WATERMARK_MARGIN` (défaut 24). Figées jusqu'au redémarrage. | `back/src/services/image-processing.service.js:11-14` |
| Chargement de l'asset | Le PNG est relu depuis le disque à **chaque** preview (`applyOpacity(WATERMARK_ASSET_PATH, …)`). | `image-processing.service.js:63` |
| Taille | Aucun redimensionnement : le watermark est composé à sa taille native (placeholder 400×120, texte « PROOF »). | `buildPreview` |
| Positions | 9 valeurs acceptées (`north`, `south`, `east`, `west`, 4 diagonales, `center`). Valeur inconnue : repli silencieux sur `southeast`. | `computeCornerOffset` |
| Fonction de preview | `buildPreview(buffer, { watermark })` travaille sur un buffer mais **n'est pas exportée**. Seule `generateDerivedImages(key, { watermark })` l'est : elle lit l'original sur S3 et écrit miniature + preview sur S3. | `image-processing.service.js:51,75` |
| Appelant unique | `confirmPhoto` : `generateDerivedImages(key, { watermark: targetStatus !== 'DELIVERED' })`. Les `DELIVERED` n'ont pas de watermark. | `photo.service.js:182` |
| Miniatures | 400 px, jamais watermarkées. Seule la preview 1200 px l'est. | `buildThumbnail` |
| Upload existant | URL PUT présignée (300 s) puis confirmation. **Aucune** vérification du contenu, ni de taille, ni ré-encodage de l'original. `objectExists` jette le résultat du `HeadObject`. | `s3.repository.js`, `photo.service.js` |
| Montage des routes | `/auth`, `/client`, `/collections`, `/photos`. Les routes admin passent par `adminCors, requireAuth, verifyOrigin`. | `back/app.js:28-31` |
| Migrations / modèles | Umzug applique `migrations/*.js` au boot. Les modèles sont déclarés à la main dans `db.repository.js`. | `db.repository.js` |
| Compte | Compte unique par variables d'env, aucune table photographe. | `auth.controller.js:15` |

## 3. Décisions techniques

**D1. Valeurs par défaut = code actuel.** Position `southeast`, opacité 60, marge 24 px (non réglable), asset `WATERMARK_ASSET_PATH`. Le « défaut 40 % » de la spec v2 est abandonné.

**D2. Pas de ligne seedée ; une colonne nulle = valeur d'origine.** Les colonnes de réglage sont nullables ; `null` signifie « valeur d'origine » (env, puis constante). C'est ce qui garde le fallback sur les variables d'env exigé par le §3.2 de la spec : une ligne seedée à `60 / southeast` l'écraserait. Écart assumé avec le §5.1 (types non nuls). La ligne (id fixe `1`) est créée au premier `PUT /settings`.

**D3. Taille nullable, `null` = taille native.** Le comportement actuel est « pas de redimensionnement ». Aucune valeur de slider ne le reproduit : le placeholder fait 33 % d'une preview de 1200 px, et davantage sur une photo plus étroite (`withoutEnlargement`). Voir point ouvert P1.

**D4. Positions stockées avec les noms sharp.** Enum `northwest | northeast | center | southwest | southeast`. Pas de couche de mapping ; les libellés français vivent dans le front. Les 4 autres valeurs (`north`, `south`, `east`, `west`) deviennent inaccessibles par l'API ; `computeCornerOffset` n'est pas modifiée.

**D5. Upload en deux temps, clé confirmée mais non liée.** Le fichier est uploadé en brut, confirmé (validé et ré-encodé sous une clé finale), puis la clé finale n'est liée aux réglages que par `PUT /settings`. C'est ce qui permet l'aperçu d'une image pas encore enregistrée. Un fichier confirmé mais jamais enregistré reste orphelin sur S3 : accepté en v1 (compte unique, 2 Mo max).

**D6. Pas de cache des réglages.** Chaque preview générée lit la ligne et, si besoin, l'asset sur S3. Le déploiement peut avoir plusieurs instances : un cache en mémoire ne serait pas invalidable de façon fiable. Le coût (une lecture DB et un `getObject` ≤ 2 Mo par photo, en plus de la lecture de l'original) est négligeable devant le traitement `sharp`.

**D7. Mise à jour partielle, schéma fermé.** `PUT /settings` ne modifie que les clés présentes. Une clé inconnue est rejetée (400). Un `null` explicite remet la valeur d'origine.

## 4. Modèle et migration

Table `GallerySettings`, nouvelle migration (nom indicatif : `20261101000001-create-gallery-settings.js`).

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | INTEGER, PK | `CHECK (id = 1)` : une seule ligne possible |
| `watermarkKey` | STRING, nullable | clé S3 du PNG final, `null` = asset par défaut |
| `watermarkPosition` | ENUM des 5 presets, nullable | `null` = env / `southeast` |
| `watermarkOpacity` | INTEGER, nullable | 10 à 80, `null` = env / 60 |
| `watermarkSize` | INTEGER, nullable | 10 à 50, `null` = taille native |
| `updatedAt` | DATE | |

Pas de `createdAt`. `down()` supprime la table **et** le type enum Postgres (`enum_GallerySettings_watermarkPosition`) : sans cela, un `up` ultérieur échoue.

Le lot 2 ajoutera ses colonnes par une seconde migration, sans toucher à celle-ci.

Modèle : `back/src/model/gallery-settings.model.js`, même forme que les modèles existants, enregistré dans `db.repository.js` (ajouté à l'objet `db`). Aucune association.

## 5. API

Toutes les routes sont montées sous `app.use('/settings', adminCors, requireAuth, verifyOrigin, settingsRouter)`. `verifyOrigin` couvre donc d'office les méthodes mutantes. Erreurs au format existant `{ error: message }`, messages en français lisibles par Emma.

### 5.1 `GET /settings` → 200

```
{ watermarkKey: string|null,
  watermarkPosition: 'southeast',      // valeur effective
  watermarkOpacity: 60,                // valeur effective, entier
  watermarkSize: number|null,          // null = taille native
  updatedAt: ISO|null }                // null tant que la ligne n'existe pas
```

Position et opacité sont renvoyées **résolues** (ligne, sinon env, sinon constante), pour que le front n'ait pas à connaître les défauts. L'opacité d'env (0–1) est convertie en entier ×100.

### 5.2 `PUT /settings` → 200 (même forme que le GET)

Clés acceptées au lot 1 : `watermarkKey`, `watermarkPosition`, `watermarkOpacity`, `watermarkSize`. Le lot 2 en ajoute d'autres.

| Clé | Règle |
|---|---|
| `watermarkKey` | `null`, ou chaîne `^branding/watermark/<uuid>\.png$` dont l'objet existe (`objectExists`). |
| `watermarkPosition` | `null` ou l'un des 5 presets. |
| `watermarkOpacity` | `null` ou entier de 10 à 80, multiple de 5. |
| `watermarkSize` | `null` ou entier de 10 à 50, multiple de 5. |

Quand `watermarkKey` change (ou passe à `null`), l'ancien objet S3 est supprimé **après** l'écriture en base, en best-effort (erreur loguée, pas de 500). Création de la ligne si absente.

### 5.3 Upload du fichier (deux routes)

**`POST /settings/assets/:kind/upload-url`**, corps `{ contentType }` → 200 `{ url, key }`
- `:kind` : au lot 1 uniquement `watermark` (sinon 400). Le lot 2 ajoute `logo`.
- `contentType` doit être exactement `image/png` pour `watermark` (sinon 400). Rejet précoce, non fiable seul.
- Clé brute générée par le serveur : `branding/watermark/raw/<uuid>`. Aucun nom de fichier client n'entre dans la clé.

**`POST /settings/assets/:kind/confirm`**, corps `{ key }` → 201 `{ key: <clé finale> }`
1. `key` doit correspondre à `^branding/<kind>/raw/<uuid>$`. **Obligatoire** : sans cette contrainte, la route permettrait de lire, ré-encoder ou supprimer n'importe quel objet du bucket (originaux compris).
2. `headObject(key)` : absent → 400 ; taille > 2 Mo (2 097 152 octets) → 400, objet brut supprimé. La taille est contrôlée **avant** `getObject` (qui charge tout en mémoire).
3. `getObject`, puis `sharp(buffer).metadata()` : `format` doit valoir `png` (type réel lu dans le contenu, pas l'extension ni le mimetype) ; largeur et hauteur ≤ 2000 px (valeur proposée, point ouvert P2).
4. Ré-encodage : `sharp(buffer, { limitInputPixels: 2000*2000 }).png().toBuffer()` (supprime les métadonnées).
5. `putObject('branding/watermark/<uuid>.png', buffer, 'image/png')`, puis `deleteObject(rawKey)`. Tout échec aux étapes 2-3 supprime aussi l'objet brut.
6. Messages : « Le fichier doit être un PNG », « Fichier trop lourd (2 Mo maximum) », « Image trop grande (2000 × 2000 px maximum) », « Fichier illisible ».

La transparence n'est pas exigée (le §3.2 de la spec ne la pose pas en règle) ; `applyOpacity` fait déjà `ensureAlpha()`.

### 5.4 `POST /settings/watermark/preview` → 200 `image/jpeg`

Corps : les 4 champs du §5.2 (`watermarkKey`, `watermarkPosition`, `watermarkOpacity`, `watermarkSize`). Le front envoie toujours les quatre ; un champ absent vaut `null` (valeur d'origine). Mêmes validations que le `PUT`. Rien n'est écrit en base ni sur S3.

Le corps de réponse est le JPEG binaire (`Cache-Control: no-store`), pas une URL. Le rendu part de la photo de test (§6) via la **même** `buildPreview` que l'upload.

### 5.5 `DELETE /settings/watermark` → 200 (même forme que le GET)

Met les 4 colonnes à `null` et supprime l'objet S3 de l'ancienne clé (best-effort). Idempotent : sans ligne, renvoie simplement les valeurs d'origine.

## 6. Modifications back, fichier par fichier

**`back/src/repository/s3.repository.js`**
- Extraire un helper privé `getSignedPutUrl(key, contentType)` (expiration 300 s) utilisé par `getSignedUploadUrl` et `getSignedAttachmentUploadUrl`. Comportement et clés inchangés.
- Ajouter `getSignedBrandingUploadUrl(kind, contentType)` → `{ url, key }`, préfixe `branding/<kind>/raw/`.
- Ajouter `headObject(key)` → `{ size, contentType }` ou `null` si 404.
- **Ne pas modifier `objectExists`** : les tests de `photo.service` le mockent avec cette signature.

**`back/src/services/settings.constants.js`** (nouveau)
- `WATERMARK_POSITIONS`, bornes d'opacité et de taille, pas (5), `MAX_BRANDING_FILE_BYTES`, `MAX_BRANDING_DIMENSION`.
- Les quatre valeurs d'origine lues dans l'env (`WATERMARK_ASSET_PATH`, `WATERMARK_OPACITY`, `WATERMARK_POSITION`, `WATERMARK_MARGIN`), déplacées depuis `image-processing.service.js` avec les mêmes défauts.

**`back/src/services/settings.service.js`** (nouveau)
- `getSettings()`, `updateSettings(partial)`, `resetWatermark()`.
- `validateWatermarkValues(values)` : fonction unique de validation, partagée par `PUT` et `preview`.
- `getUploadUrl(kind, contentType)`, `confirmUpload(kind, key)`.
- `loadSavedWatermarkValues()` et `buildWatermarkConfig(values)` → `{ image, position, opacity (0–1), size, margin }`. `image` est un `Buffer` (S3) si une clé est posée, sinon le chemin `WATERMARK_ASSET_PATH`.
- Ne doit **rien** importer depuis `image-processing.service.js` (évite le cycle) et ne rien exécuter sur `db.GallerySettings` à l'import (`cors.test.js` mocke `db` sans ce modèle).

**`back/src/services/image-processing.service.js`**
- Exporter `buildPreview(imageBuffer, { watermark })` où `watermark` vaut `false` ou une config `buildWatermarkConfig`.
- `generateDerivedImages(key, { watermark = true })` : **signature publique inchangée**. Si `watermark` est vrai, il appelle `buildWatermarkConfig(await loadSavedWatermarkValues())`. Les tests de `photo.service` et `collection.service`, qui mockent ce module, ne sont donc pas touchés.
- Dans `buildPreview`, après chargement de l'asset : si `size` n'est pas `null`, redimensionner le watermark à `Math.max(1, Math.round(info.width * size / 100))` de large (`info.width` est la largeur réelle de la preview, après `resize`), puis appliquer l'opacité.
- Garde-fou : si le watermark (taille native ou redimensionné) dépasse la preview en largeur ou en hauteur, le réduire avec `fit: 'inside'`. Aujourd'hui `composite` lève une erreur dans ce cas ; ce garde-fou n'agit que là où le code échoue déjà.
- Ajouter `generateWatermarkSample(values)` : valide, construit la config, lit la photo de test, appelle `buildPreview`, retourne le buffer JPEG. La photo de test est lue une fois, paresseusement, puis gardée en mémoire (fichier fixe, pas de problème d'invalidation).

**`back/src/controller/settings.controller.js`, `back/src/router/settings.router.js`** (nouveaux) : mêmes conventions que `photo.controller.js` (`error.status` sinon 500 générique).

**`back/app.js`** : monter `/settings` comme indiqué au §5.

**`back/src/repository/db.repository.js`** : charger `GallerySettingsModel` et l'ajouter à `db`.

**`back/assets/watermark-test-photo.jpg`** (à fournir) : image paysage d'au moins 1200 px de large, libre de droits, qui contraste avec un watermark clair et un foncé. Vérifier que `back/.dockerignore` n'exclut pas `assets/` (le `Dockerfile` fait `COPY . .`).

## 7. Front-admin

Pas de routeur dans `front-admin` (`App.jsx` affiche `Gallery` directement). Le moins invasif : un état `view` (`'gallery' | 'settings'`) dans `App.jsx` et un bouton « Réglages » / « Retour » dans la topbar.

- `front-admin/src/api/settings.js` (nouveau), via `apiFetch` : `getSettings`, `updateSettings`, `requestUploadUrl`, `confirmUpload`, `previewWatermark` (renvoie un `Blob`), `resetWatermark`. L'envoi du fichier à l'URL présignée se fait comme dans `Gallery.jsx:107` (PUT avec `Content-Type`).
- `front-admin/src/components/WatermarkSettings.jsx` (nouveau) :
  - sélecteur de fichier (`accept="image/png"`) ; contrôle de type et de poids côté front à titre d'aide uniquement, le back fait foi ;
  - 5 choix de position (libellés : haut-gauche, haut-droite, centre, bas-gauche, bas-droite) ;
  - slider d'opacité 10–80 pas 5, slider de taille 10–50 pas 5, avec l'état « taille d'origine » (voir P1) ;
  - aperçu : `<img>` alimenté par l'URL d'objet du blob retourné par `preview`, régénéré à chaque changement avec un debounce d'environ 300 ms ; seule la dernière requête compte (`AbortController`), l'URL précédente est révoquée ;
  - bouton « Enregistrer », avec **en permanence à côté** le texte « S'applique aux prochaines photos uploadées, pas à celles déjà dans des collections » ;
  - bouton « Revenir au watermark par défaut » (`window.confirm`, comme la suppression de photo) → `DELETE /settings/watermark`.
- Réutiliser les classes existantes (`collection-form`, `button-primary`, `button-outline`, `form-error`) ; les ajouts de CSS vont dans `front-admin/src/App.css`.
- Erreurs d'upload (type, poids, dimensions) : afficher le message renvoyé par le back.

## 8. Sécurité

- Validation côté back uniquement faisant foi (enum, bornes, pas, regex de clé).
- Fichier : type lu dans le contenu par `sharp`, taille contrôlée par `HeadObject` avant lecture, dimensions plafonnées, ré-encodage. Pas de SVG, rejeté d'office (le format n'est pas `png`).
- Les clés S3 acceptées par `confirm` et `PUT` sont contraintes par regex de préfixe : aucune clé arbitraire du bucket n'est lisible ou supprimable via ces routes.
- Le watermark n'est jamais exposé hors du pipeline : aucune route `/client` ne le mentionne.
- `verifyOrigin` couvre toutes les routes mutantes (montage unique).
- `express.json` garde sa limite par défaut : aucun fichier ne transite par le back en JSON (upload direct vers S3).

## 9. Tests

À adapter :
- `back/test/cors.test.js` : ajouter `/settings` à `ADMIN_PATHS` (le montage `requireAuth` renvoie 401 sans session).

À ajouter (mêmes conventions : `node:test`, `mock.module`) :
- `back/test/settings.service.test.js` :
  - validation : opacité 5 / 85 / 62 / chaîne, taille 5 / 55, position `north`, clé hors préfixe, clé inconnue dans le corps → refusés ; `null` accepté ;
  - `confirmUpload` : JPEG déguisé en `.png` refusé ; SVG refusé ; > 2 Mo refusé et brut supprimé ; image 3000 px refusée ; PNG valide → `putObject` appelé avec un PNG ré-encodé, brut supprimé ; clé hors `branding/watermark/raw/` refusée sans toucher S3 ;
  - résolution des valeurs d'origine : sans ligne, `getSettings` renvoie 60 / `southeast` / `null` ; avec `WATERMARK_OPACITY=0.5` en env, renvoie 50.
- `back/test/image-processing.service.test.js` (aucun test n'existe aujourd'hui sur ce module ; `sharp` réel, S3 et settings mockés) :
  - sur un fond uni avec un watermark d'une couleur unie, la largeur du watermark vaut `round(largeur preview × size / 100)` ;
  - pour chacun des 5 presets, le pixel attendu (coin ou centre, marge 24) a la couleur du watermark ;
  - `size = null` : largeur native conservée (non-régression) ;
  - watermark plus grand que l'image : pas d'exception ;
  - `watermark: false` : aucun appel à la config.

Inchangés : `photo.service.test.js` et `collection.service.test.js` (le module d'image est mocké, la signature publique est stable).

## 10. Critères d'acceptation (reprise du §9 de la spec, lot 1)

| Critère | Comment le vérifier |
|---|---|
| Upload, réglages, aperçu, enregistrement | Manuel dans l'admin ; l'aperçu et une photo uploadée ensuite doivent être visuellement identiques à réglages égaux. |
| Photo uploadée après : nouveau watermark ; anciennes inchangées ; avertissement affiché | Uploader une photo avant puis une après le changement ; comparer les previews. |
| Sans réglage, rendu identique à aujourd'hui | Sans ligne en base, comparer au pixel une preview générée avant et après le changement de code (mêmes réglages d'env). Tests §9 (`size = null`, défauts). |
| Fichier invalide refusé avec message clair | Tests `confirmUpload` ; essai manuel d'un JPEG renommé en PNG et d'un fichier > 2 Mo. |

## 11. Ordre d'implémentation

1. Migration, modèle, enregistrement dans `db.repository.js`.
2. `s3.repository.js` (helper, `getSignedBrandingUploadUrl`, `headObject`), avec les tests existants relancés.
3. `settings.constants.js`, `settings.service.js` et ses tests.
4. `image-processing.service.js` (taille, garde-fou, export, `generateWatermarkSample`) et ses tests.
5. Contrôleur, routeur, montage dans `app.js`, entrée `cors.test.js`.
6. Photo de test.
7. Front-admin.

Timebox du §10 de la spec : si ce lot dépasse un week-end ou deux, on s'arrête et on réévalue.

## 12. Points ouverts

- **P1. Taille d'origine.** Recommandation retenue : `watermarkSize` nullable, `null` = taille native, avec une case « taille d'origine » dans l'admin (slider désactivé quand elle est cochée). Alternative : pas de `null`, défaut 35 % ; le rendu des nouvelles photos change alors légèrement par rapport à aujourd'hui, contrairement au critère « identique sans réglage ».
- **P2. Dimensions max.** 2000 × 2000 px proposé pour le watermark (et le logo au lot 2). À confirmer.
- **P3. Hors périmètre, constaté.** `back/.env.example` référence `./assets/watermark.png`, absent du dépôt (seul `watermark-placeholder.png` existe). Recopié tel quel, il fait échouer chaque upload non `DELIVERED`. Non traité ici.
