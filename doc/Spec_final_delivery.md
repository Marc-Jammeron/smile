# Spec — Livraison finale : réupload des retouches (Emma) + vue client READY

## 1. Rappel du parcours (contexte)

```
DRAFT → SELECTING → EDITING (Retouche) → READY → ARCHIVED
```

- `SELECTING` : le client marque des photos `SELECTED` dans sa galerie (`/client/:token`)
- `EDITING` : Emma télécharge la sélection en HD (feature déjà livrée) et retouche les photos en dehors de l'outil
- **Cette spec** : une fois les retouches faites, Emma réuploade les photos finales dans l'outil, puis passe la collection en `READY`. Le client accède alors à une galerie de livraison finale pour visualiser et télécharger ses photos retouchées.

## 2. Décisions actées avant rédaction

- **Pas de nouvelle table.** Réutilisation du modèle `Photo` existant : ajout d'un statut `DELIVERED` à l'enum. Chaque photo retouchée réuploadée crée une **nouvelle ligne `Photo`** (pas de modification d'une ligne existante), `status = 'DELIVERED'`.
- **Réutilisation des endpoints d'upload existants** (`POST /photos/batch` pour le presign, `POST /photos/confirm/batch` pour la confirmation) plutôt que de créer de nouvelles routes dédiées. Un paramètre optionnel `targetStatus` (défaut `'PENDING'`) permet de cibler `'DELIVERED'` pour ce nouveau flux. Choisi pour économiser la duplication du mécanisme d'upload presigné déjà en place et testé (voir §4).
- **Pas de matching 1-to-1** entre une photo `SELECTED` originale et une photo `DELIVERED` réuploadée.
- **Suppression des anciennes photos au passage en `READY`.** Au clic sur "Marquer comme prêt", toutes les photos de la collection dont le statut n'est PAS `DELIVERED` (`PENDING`, `SELECTED`, `REJECTED`) sont **définitivement supprimées** (lignes en base ET fichiers S3). Irréversible.
- **Confirmation obligatoire à chaque fois** avant ce passage en `READY` (pas seulement en cas d'écart de comptage entre photos uploadées et photos sélectionnées), puisque la suppression a lieu systématiquement.
- Le passage en `READY` reste **manuel** (bouton "Marquer comme prêt").
- Côté client en `READY` : galerie des photos `DELIVERED`, téléchargement individuel ET bouton "Télécharger tout" (ZIP).
- Génération d'une preview/thumbnail pour les photos `DELIVERED`, **sans watermark** sur la preview (contrairement aux photos `SELECTED`/`PENDING`).
- Une fois en `READY`, la galerie client montre uniquement les photos `DELIVERED`.

## 3. Modèle de données

Pas de nouvelle table. Modification du modèle `Photo` existant (migration sur le pattern déjà utilisé pour `ARCHIVED`, cf. `20260807000003-add-archived-status-to-photos.js` — `ALTER TYPE ... ADD VALUE IF NOT EXISTS`) :

```js
status: {
  type: DataTypes.ENUM('PENDING', 'SELECTED', 'REJECTED', 'ARCHIVED', 'DELIVERED'),
  defaultValue: 'PENDING'
}
```

Aucune relation technique entre une ligne `DELIVERED` et la ligne `SELECTED`/`PENDING`/`REJECTED` qu'elle remplace fonctionnellement. Toutes les requêtes existantes qui filtrent par statut le font par liste d'inclusion explicite (`photo.service.js:34` et `:49`) — `DELIVERED` n'apparaîtra donc dans aucun résultat existant tant qu'on ne l'ajoute pas explicitement aux listes voulues (pas de risque de régression côté filtre).

## 4. Backend — upload des photos finales (Emma)

**Réutilisation des endpoints existants**, pas de nouvelles routes d'upload :

- `POST /photos/batch` (presign, `photo.controller.js:27` → `createPhotosBatch`, `photo.service.js:69`)
- `POST /photos/confirm/batch` (confirm, `photo.controller.js` → `confirmPhotosBatch`, `photo.service.js:81-116`)

Modification à apporter : ajouter un paramètre optionnel `targetStatus` au body (défaut `'PENDING'`), threadé jusqu'à `db.Photo.create({..., status: targetStatus })` dans `confirmPhoto`. Le `filename` continue d'être threadé vers `originalFilename` exactement comme aujourd'hui (`confirmPhoto`, `photo.service.js:94`) — mécanisme déjà stable, rien à changer là-dessus.

Validation à ajouter dans `confirmPhotosBatch`/`createPhotosBatch` : si `targetStatus === 'DELIVERED'`, vérifier `collection.status === 'EDITING'` (sinon `409`) plutôt que la validation actuelle liée à l'upload initial.

Génération thumbnail/preview sans watermark : `generateDerivedImages(key)` (`image-processing.service.js:69-86`) n'a aujourd'hui qu'un seul paramètre. Lui ajouter un second paramètre optionnel, ex. `generateDerivedImages(key, { watermark = true } = {})`, et le faire remonter jusqu'à `buildPreview()` (`image-processing.service.js:51-67`) pour conditionner l'application du watermark. Appeler avec `{ watermark: false }` quand `targetStatus === 'DELIVERED'`. Le traitement reste **synchrone** dans la requête de confirmation, comme c'est déjà le cas aujourd'hui (`await generateDerivedImages(key)` dans `confirmPhoto`, `photo.service.js:92`) — pas de job/queue à introduire. Réutiliser aussi le chunking déjà en place côté front (`CONFIRM_CHUNK_SIZE`, `Gallery.jsx:113-115`) pour lisser la latence, comme pour l'upload initial.

Liste des photos `DELIVERED` déjà uploadées (pour l'écran de review admin) : à priori pas besoin de nouvel endpoint si l'admin charge déjà la liste complète des photos de la collection avec leur statut pour l'affichage courant — filtrer côté front sur `status === 'DELIVERED'`. **À vérifier** que c'est bien le cas avant de trancher un éventuel nouvel endpoint dédié.

Suppression d'une photo `DELIVERED` mal uploadée avant validation finale — nouvel endpoint, code entièrement nouveau (il n'existe aujourd'hui aucune suppression réelle : `softDeletePhoto`, `photo.service.js:207-217`, ne fait qu'un soft-delete, `status = 'ARCHIVED'`, sans toucher S3 ni supprimer la ligne) :

```
DELETE /photos/delivered/:id
```

- Vérifie `photo.status === 'DELIVERED'` (sinon `403` — ne s'applique qu'aux photos de livraison, pas de détournement possible vers une suppression dure d'une photo `SELECTED`/`PENDING`)
- Supprime la ligne DB et les objets S3 associés (`key`, `thumbnailKey`, `previewKey`) via `s3Repository.deleteObject(key)` (existant, `s3.repository.js:94-107`), un appel par clé (pas de suppression en lot native — `DeleteObjectCommand` uniquement, pas `DeleteObjectsCommand`)

## 5. Backend — passage en READY

```
PATCH /collections/:id/mark-ready
```

1. Vérifie `collection.status === 'EDITING'`, sinon `409`
2. Vérifie qu'au moins une photo `DELIVERED` existe pour la collection, sinon `400`
3. Dans une **transaction** Sequelize (`db.sequelize.transaction(...)` — code entièrement nouveau, aucun pattern de transaction n'existe ailleurs dans le repo à ce jour) :
   - Récupère toutes les photos de la collection avec `status != 'DELIVERED'`
   - Supprime ces lignes en DB
   - Passe `collection.status` à `READY`
4. Après le commit de la transaction, supprime les objets S3 correspondants (boucle d'appels à `s3Repository.deleteObject(key/thumbnailKey/previewKey)`), en loggant les échecs sans bloquer — la transition en `READY` est déjà actée à ce stade.

Pas de risque de verrou notable identifié : le modèle `Photo` n'a pas de hooks Sequelize (`beforeDestroy`/`afterUpdate`), la transaction reste courte et localisée sur `WHERE collectionId = :id`.

## 6. Backend — vue et téléchargement client

`getClientGallery` (`client.controller.js:5-15`) est aujourd'hui **inconditionnel** : il appelle toujours `getAllClientPhotosByCollectionId`, qui filtre en dur sur `status IN ('PENDING','SELECTED','REJECTED')` (`photo.service.js:44-57`). Il n'existe aucune branche conditionnelle sur `collection.status` à ce jour — à ajouter (code nouveau, mais simple) :

- Si `collection.status === 'READY'` → nouvelle fonction service `getDeliveredPhotosByCollectionId` (même forme que l'existante, filtrant sur `status = 'DELIVERED'`)
- Sinon → comportement actuel inchangé

Téléchargement individuel : URL presignée sur `key` (le fichier complet) incluse dans le payload de chaque photo `DELIVERED` — présigner `key` ici est intentionnel (contrairement au fix de sécurité précédent sur les photos `SELECTED`/`PENDING`), puisque c'est la livraison finale que le client doit recevoir en pleine résolution.

Téléchargement global (nouveau) :

```
GET /client/:token/download-all
```

- Ajouter `loadGalleryByToken` (middleware existant, `client.middleware.js:3-21`, déjà monté sur les autres routes `/client/:token`, gère les cas token révoqué/expiré/ARCHIVED → 404) à la chaîne de middlewares de cette nouvelle route — réutilisable à l'identique.
- Vérifie `collection.status === 'READY'`, sinon `409`
- Stream un ZIP de toutes les photos `DELIVERED` (`Photo.key`) en reprenant le pattern `archiver` déjà construit pour le téléchargement HD admin
- **Point à surveiller** : le rate-limiter global `clientRateLimiter` (100 req/15min, `client.router.js:8-15`) s'applique à toutes les routes `/client/*`. Vérifier que la génération du ZIP (potentiellement lente, avec retries possibles côté front en cas d'échec réseau) ne s'y heurte pas en usage normal.

## 7. Frontend admin

Sur la page collection, en statut `EDITING`, nouvelle section "Livraison finale" (le bouton existant de téléchargement HD reste inchangé) :

- Zone d'upload (drag & drop / sélection multiple), réutilisant le composant d'upload existant, avec `targetStatus: 'DELIVERED'` dans les appels à `/photos/batch` et `/photos/confirm/batch`
- Liste des photos `DELIVERED` déjà uploadées (vignette + suppression via `DELETE /photos/delivered/:id`)
- Compteur double : "X photos uploadées / Y photos sélectionnées par le client"
- Bouton "Marquer comme prêt" :
  - Désactivé si aucune photo `DELIVERED` uploadée
  - **Affiche systématiquement une modale de confirmation** au clic : "Cette action est définitive : les X photos non retenues (sélection, rejetées) seront supprimées et ne pourront pas être récupérées." + mention de l'écart de comptage si les nombres diffèrent
  - Appel à `PATCH /collections/:id/mark-ready` uniquement après confirmation explicite

## 8. Frontend client

Sur `/client/:token`, quand `collection.status === 'READY'` :

- Grille des photos `DELIVERED` (thumbnails) à la place de l'affichage de sélection
- Clic sur une photo → vue agrandie via `previewKey` (non watermarkée)
- Téléchargement individuel par photo (URL presignée sur `key`)
- Bouton "Télécharger tout" → `GET /client/:token/download-all`, en `fetch` + blob (pas `<a href>`, pour pouvoir afficher une erreur en cas de 409/500), avec état de chargement pendant la génération

## 9. Points à vérifier dans le code existant avant implémentation

- Confirmer que l'admin charge déjà la liste complète des photos d'une collection (avec statut) pour l'écran courant, pour éviter un endpoint de liste dédié aux `DELIVERED` (§4)
- Vérifier que `clientRateLimiter` ne pose pas de souci pratique sur `download-all` (§6)

## 10. Hors scope

- Notification email au client au passage en `READY`
- Retour arrière `READY` → `EDITING` (les originaux étant supprimés, ce ne serait pas une simple annulation)
- Récupération/restauration des photos supprimées — suppression définitive, pas de corbeille
- Watermark configurable par collection — fixe : jamais sur les `DELIVERED`
- Suppression S3 en lot optimisée (`DeleteObjectsCommand`) — boucle simple sur `deleteObject` pour cette V1, à optimiser plus tard si le volume le justifie