# Spec — Téléchargement HD de la sélection (phase Retouche)

## 1. Contexte

Dans l'outil de gestion de galerie photo (mono-repo `backend` / `front-admin` / `front-client`), une collection suit le cycle :

```
DRAFT → SELECTING → EDITING (= "Retouche")
```

Pendant `SELECTING`, le client marque chaque photo via le champ `status` du modèle `Photo` :

```js
status: {
  type: DataTypes.ENUM('PENDING', 'SELECTED', 'REJECTED', 'ARCHIVED'),
  defaultValue: 'PENDING'
}
```

Une fois la collection passée en `EDITING`, l'admin (Emma) doit pouvoir récupérer en un clic les fichiers **originaux (HD, non watermarkés)** des photos que le client a marquées `SELECTED`, sous forme d'un **ZIP unique généré côté serveur**.

Rappel architecture existante :
- Stockage : Scaleway Object Storage (S3-compatible)
- 2 niveaux déjà exposés : thumbnail (~400px) et preview (~1200px, watermarké)
- L'original n'est **jamais** exposé côté client — c'est le premier endpoint qui va l'exposer, donc traitement sécurité strict (voir §5)
- Auth existante : `auth.middleware` (à confirmer : rôle admin unique ou multi-rôles ?)

## 2. Objectif fonctionnel

Sur la page de détail d'une collection en statut `EDITING`, dans le `front-admin` :
- Un bouton **"Télécharger la sélection HD (.zip)"** apparaît, avec le nombre de photos sélectionnées affiché (ex: "Télécharger la sélection HD (24 photos)")
- Au clic, le serveur génère un ZIP contenant les fichiers originaux des photos `status = SELECTED` de cette collection, et le stream au navigateur
- Le bouton est désactivé (avec tooltip) si aucune photo n'a le statut `SELECTED`

## 3. Hors scope (V1)

- Génération asynchrone avec notification (V2 si les collections deviennent trop volumineuses)
- Sélection manuelle d'un sous-ensemble de photos pour le ZIP (V1 = toute la sélection du client, pas de re-filtrage)
- Téléchargement d'une seule photo HD isolée
- Historique/audit des téléchargements (utile plus tard, mentionné en §7)

## 4. Backend

### 4.1 Endpoint

```
GET /api/admin/collections/:collectionId/download-selection-hd
```

- Protégé par `auth.middleware` (admin uniquement — **à confirmer**: si le modèle multi-photographe existe déjà, vérifier que la collection appartient bien au compte de l'admin authentifié)
- Réponse : stream direct du ZIP, pas de JSON

### 4.2 Logique métier

1. Charger la collection par `collectionId`. Si absente → `404`.
2. Vérifier `collection.status === 'EDITING'`. Sinon → `409 Conflict` avec message `"La collection doit être en phase Retouche pour télécharger la sélection HD."`
3. Récupérer les photos : `Photo.findAll({ where: { collectionId, status: 'SELECTED' } })`
4. Si `photos.length === 0` → `400 Bad Request`, message `"Aucune photo sélectionnée dans cette collection."`
5. Générer le ZIP en streaming (voir §4.3) et le renvoyer avec :
   - `Content-Type: application/zip`
   - `Content-Disposition: attachment; filename="<slug-collection>-HD-<YYYYMMDD>.zip"`

### 4.3 Génération du ZIP (streaming, pas de buffer complet en mémoire)

- Utiliser le package `archiver` (mode `zip`, compression `store` ou `deflate` niveau faible — les photos sont déjà compressées, pas la peine de recompresser fort)
- Pour chaque photo sélectionnée :
  - Récupérer le stream de l'original depuis Scaleway (réutiliser la fonction existante du service de storage qui gère déjà thumbnail/preview — **à identifier dans le code existant**, probablement `storage.service.js`, et lui ajouter une méthode `getOriginalStream(photo)` si elle n'existe pas)
  - `archive.append(stream, { name: photo.originalFilename })` — utiliser le nom de fichier original de la photo, pas son UUID interne, pour que le ZIP soit lisible côté client
- Piper `archive` directement dans `res` (`archive.pipe(res)`), pas de fichier temporaire sur disque
- Gérer les erreurs de stream S3 individuelles sans faire planter tout le ZIP (logger et `archive.abort()` proprement, renvoyer une erreur claire si ça arrive avant tout envoi de données ; si le stream a déjà commencé, logger côté serveur car on ne peut plus changer le statut HTTP)

### 4.4 Erreurs à gérer explicitement

| Cas | Code | Message |
|---|---|---|
| Collection introuvable | 404 | Collection introuvable |
| Collection pas en EDITING | 409 | Collection pas encore en phase Retouche |
| Aucune photo SELECTED | 400 | Aucune photo sélectionnée |
| Admin non authentifié | 401 | (géré par auth.middleware) |
| Admin n'a pas accès à cette collection | 403 | (si multi-photographe) |
| Erreur S3 sur un fichier original | 500 (si avant streaming) / log serveur (si pendant) | Erreur lors de la génération du ZIP |

## 5. Sécurité

- L'original n'ayant jamais été exposé jusqu'ici, bien vérifier que **cet endpoint est strictement réservé à l'admin** (pas le token client opaque utilisé côté `front-client`)
- Pas d'URL presignée S3 renvoyée au client : le fichier original ne transite que server → S3 (interne) puis server → admin (stream), jamais d'accès direct navigateur → S3 pour l'original
- Vérifier qu'il n'y a pas de fuite du chemin S3 interne dans les logs d'erreur renvoyés au client

## 6. Frontend (`front-admin`)

- Sur la page collection, condition d'affichage du bouton : `collection.status === 'EDITING'`
- Composant bouton :
  - Label dynamique : `Télécharger la sélection HD (${count} photos)`
  - `count` = nombre de photos avec `status === 'SELECTED'` dans la collection (déjà normalement récupéré si la page affiche la liste des photos avec leur statut ; sinon appel API léger `GET /api/admin/collections/:id/selection-count`)
  - Désactivé si `count === 0`, avec tooltip "Aucune photo sélectionnée"
- Au clic :
  - État `loading` sur le bouton (spinner + texte "Génération du ZIP…") pendant toute la durée du téléchargement, car la réponse est streamée en synchrone (pas de retour immédiat)
  - Déclenchement du téléchargement navigateur (lien `<a href>` vers l'endpoint avec le token d'auth admin en cookie/header selon ce qui est déjà en place pour les autres appels admin — **ne pas réinventer**, réutiliser le mécanisme d'auth existant du `front-admin`)
  - En cas d'erreur HTTP (409/400/500), afficher un toast avec le message serveur

## 7. Extensions futures (à ne pas coder maintenant, juste garder en tête pour ne pas fermer de portes)

- Historique de téléchargement : table `DownloadLog` (collectionId, adminId, downloadedAt, photoCount) pour tracer qui a téléchargé quoi et quand
- Génération asynchrone (job queue + notification) si les collections deviennent volumineuses (au-delà d'un certain nombre de photos HD, le stream synchrone peut timeout)
- Téléchargement HD à la photo (endpoint unitaire), utile si Emma veut retoucher une photo en particulier sans tout retélécharger

## 8. Points à vérifier dans le code existant avant de lancer l'implémentation

- Nom exact et méthode du service de storage pour récupérer les fichiers originaux depuis Scaleway
- Existence ou non d'un système multi-photographe déjà actif (impacte le contrôle d'accès §4.1/§5)
- Mécanisme d'auth utilisé côté `front-admin` pour les téléchargements de fichiers (cookie de session vs Bearer token dans un lien `<a>`, ce qui peut nécessiter un endpoint qui accepte le token en query param plutôt qu'en header pour un téléchargement direct par navigateur)
- Convention de nommage des fichiers originaux déjà en place (`originalFilename` existe-t-il bien sur le modèle `Photo` ?)