# Spec — Fix sécurité : fuite de l'URL S3 de l'original HD côté galerie client

## 1. Bug

`toPhotoDTO` (`photo.service.js:5-13`) génère une URL S3 présignée sur `key` (le fichier **original**, HD, non watermarké) et la place dans le champ `url` de chaque photo renvoyée.

Cette fonction est utilisée par `getAllPhotosByCollectionId`, elle-même appelée par `getClientGallery` (`client.controller.js:10`) — la route publique accessible via le token client (`/client/:token`).

## 2. Impact

Même si le front n'affiche/n'utilise que la version preview watermarkée, **l'URL signée de l'original est présente dans le payload JSON** renvoyé par l'API de la galerie client. N'importe qui inspectant la réponse réseau (devtools, ou simplement en rejouant l'appel API) peut récupérer cette URL et télécharger l'original en pleine résolution, sans watermark, sans jamais passer par le code du front.

Toute personne ayant accès à un lien de galerie client (le token n'est pas censé donner accès au HD avant livraison) peut donc aujourd'hui récupérer tous les originaux en clair.

## 3. Correctif attendu

Dans `toPhotoDTO`, pour tout usage **client-facing** (donc au minimum `getClientGallery`), présigner `previewKey` au lieu de `key` pour le champ `url` retourné.

**Point à vérifier avant de coder (`toPhotoDTO` est peut-être partagée admin/client) :**
- Si `toPhotoDTO` est aussi utilisée pour l'affichage admin (ex: page de gestion de collection côté back-office), il faut probablement **deux DTO distincts** :
  - `toClientPhotoDTO` → présigne toujours `previewKey`, jamais `key`
  - `toAdminPhotoDTO` (ou garder `toPhotoDTO` tel quel) → peut continuer à présigner `key` si l'admin en a besoin ailleurs dans l'app actuellement (à vérifier dans le code avant de trancher, ne pas supposer)
- Ne pas modifier le comportement admin sans avoir vérifié qu'aucun écran actuel de l'admin ne dépend de recevoir l'URL de l'original via ce DTO.

## 4. Critère d'acceptation

- Appel à l'endpoint de la galerie client (`/client/:token`) : le champ `url` de chaque photo pointe vers une URL présignée sur `previewKey`, jamais sur `key`.
- Aucune régression sur les écrans admin qui dépendraient de `key` via ce même DTO (vérifier avant/après).
- Ajouter un test (unitaire ou d'intégration) qui vérifie explicitement que l'URL renvoyée par la route client ne contient pas le chemin S3 de l'original (`key`), pour éviter une régression silencieuse plus tard.

## 5. Hors scope

- Le futur téléchargement HD par l'admin (fera l'objet d'une spec séparée) — celui-ci passera par un stream serveur, pas par une URL présignée exposée au front.
- Toute revue plus large des permissions du token client (scope volontairement limité à ce bug précis).