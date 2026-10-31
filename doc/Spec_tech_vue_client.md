# Spec technique : lot 2, vue client personnalisable

Statut : v1, **à relire avant implémentation**. Dérive de `doc/Spec_customization.md` (v2) et des décisions du 2026-10-31 :

- le code actuel fait foi pour les valeurs par défaut ;
- **pas de preview live** : Emma garde une page client ouverte et la rafraîchit ;
- **seule la couleur de fond est personnalisable** (plus de couleur de texte ni d'accent).

Prérequis : lot 1 livré (`doc/Spec_tech_watermark.md`). Ce document réutilise sa table `GallerySettings`, ses routes `/settings` et son flux d'upload, et n'en redéfinit que les extensions.

Règle de périmètre : tout ce qui n'est pas listé ici n'est pas personnalisable.

## 1. Périmètre

Dans le lot :

- **logo** (remplace le nom en texte dans l'en-tête) ;
- **textes** : nom affiché, sous-titre de l'en-tête, message d'accueil ;
- **police** : un choix dans une liste fermée, polices embarquées ;
- **couleur de fond** ;
- « Restaurer les valeurs par défaut ».

Hors lot : aperçu live, couleur de texte ou d'accent, couleurs des états de sélection (vert/rouge), réordonnancement, CSS/HTML libre, réglages par collection, messages de statut générés par l'app, mode sombre géré par le client.

## 2. État actuel du code (faits vérifiés)

| Sujet | Constat | Où |
|---|---|---|
| Payload client | `GET /client/:token` renvoie `{ collection: req.collection, photos, photographerName }`. `photographerName` vient de `PHOTOGRAPHER_DISPLAY_NAME`. Tout le `try/catch` renvoie un 500 unique. | `back/src/controller/client.controller.js:13` |
| En-tête | JSX codé en dur dans `front-client` (pas dans `front-shared`) : nom (`photographerName`), séparateur, libellé littéral « Photographe » mis en majuscules par le CSS. Tout le bloc est conditionné à `photographerName &&`. | `front-client/src/components/PublicGallery.jsx:125-133` |
| Sous-titre sous le titre | Message de statut généré par l'app (non personnalisable, §2 de la spec). Aucun emplacement libre pour un message d'accueil. | `PublicGallery.jsx:134-140` |
| Couleurs | Valeurs `oklch(...)` en dur dans `.client-gallery*` : fond `97.5% .006 80`, texte `18% .005 80`, texte secondaire `45% .01 80`, séparateur `85% .01 80`, étiquette `60% .07 235`, bouton `85% .05 235`, sélectionné vert `65% .14 145`, rejeté rouge `60% .14 25`. Aucune variable CSS pour la vue client. | `front-client/src/App.css` (à partir de la ligne 916) |
| Variables existantes | `--text`, `--text-h`, `--bg`, `--accent` (violet), `--heading`, `--sans`… dans `index.css`, avec mode sombre. Variables d'admin, non utilisées par `.client-gallery`. | `front-client/src/index.css` |
| Polices | « Cormorant Garamond » (500) chargée depuis **Google Fonts** dans `index.html`, utilisée pour le nom, le titre et le bouton « Valider ». « Work Sans » est déclarée en police du texte courant mais **n'est chargée nulle part** : le rendu réel est `var(--sans)`, soit `system-ui`. | `front-client/index.html:7-9`, `App.css` |
| `front-shared` | Aucun CSS ; `Photo.jsx` et `PhotoLightbox.jsx` ne portent que des classes. Les couleurs de ces composants sont dans les `App.css` des deux fronts. Aucun `dangerouslySetInnerHTML` dans le dépôt. | `front-shared/src` |
| `App.css` | Identique octet pour octet dans `front-admin` et `front-client`. Les règles `.client-gallery*` de la copie d'admin ne sont jamais utilisées. | |
| Workspaces | `front-shared`, `front-admin`, `front-client` sont des workspaces npm. `back` n'en fait pas partie : il ne peut pas importer `front-shared`. | `package.json` |

## 3. Décisions techniques

**D1. Défauts = CSS actuel, réglage absent = ne rien poser.** Chaque variable CSS a sa valeur par défaut dans `App.css` ; un champ `null` ne produit aucune surcharge. Un déploiement sans réglage est donc identique par construction, sans conversion `oklch → hex`.

**D2. Le fond par défaut n'est pas stocké.** `colorBg` à `null` = `oklch(97.5% 0.006 80)` (environ `#F8F6F2` ; la valeur hex exacte du sélecteur de couleur de l'admin est à calculer à l'implémentation).

**D3. L'API renvoie des valeurs brutes, le front résout les replis.** `branding` contient les champs nullables tels qu'enregistrés ; les replis (`photographerName`, « Photographe », police par défaut) sont dans le front, où se trouvent déjà les littéraux. Le champ `photographerName` du payload reste inchangé.

**D4. La police est choisie par identifiant ; les familles CSS vivent dans le code.** L'API ne renvoie qu'un `fontId`. Le front le traduit par une table fermée ; un identifiant inconnu est ignoré (police par défaut). Aucune chaîne `font-family` ne vient de l'API.

**D5. Le logo remplace le nom, pas le reste du bloc.** Quand un logo existe, il prend la place du nom (`client-gallery-brand-name`) ; séparateur et sous-titre restent. Lecture littérale de « (a) nom affiché, utilisé si pas de logo » et de « (b) sous-titre de l'en-tête ». Voir point ouvert P2.

**D6. Message d'accueil juste sous le titre.** Nouvel élément entre le `<h1>` et le sous-titre de statut, visible uniquement en `SELECTING`, uniquement s'il est non vide.

**D7. Les réglages indisponibles ne cassent pas la galerie.** La lecture de `branding` est isolée : en cas d'erreur, `branding: null`, erreur loguée, la galerie se charge avec les défauts.

## 4. Modèle et migration

Seconde migration (nom indicatif : `20261101000002-add-client-branding-to-gallery-settings.js`) : ajoute des colonnes à `GallerySettings`, toutes nullables, `null` = défaut.

| Colonne | Type | Contrainte |
|---|---|---|
| `logoKey` | STRING | clé S3 finale du logo |
| `displayName` | STRING(40) | |
| `tagline` | STRING(40) | |
| `welcomeMessage` | STRING(280) | |
| `fontId` | STRING | validé par la liste fermée (§6), pas d'enum Postgres : ajouter une police ne doit pas demander de migration |
| `colorBg` | STRING(7) | `#rrggbb` en minuscules |

Il n'y a **pas** de `colorText` ni de `colorAccent` (le §5.1 de la spec v2 est amendé). `down()` retire les colonnes. Le modèle `gallery-settings.model.js` reçoit les mêmes champs.

## 5. API

Extension des routes du lot 1 ; mêmes règles de montage et de sécurité (`requireAuth`, `verifyOrigin`).

### 5.1 `GET /settings` et `PUT /settings`

Les réponses ajoutent les 6 champs, valeurs **brutes** (`null` = défaut) :
`logoKey`, `displayName`, `tagline`, `welcomeMessage`, `fontId`, `colorBg`.

Règles de `PUT` (mise à jour partielle, clé inconnue rejetée, `null` = défaut, comme au lot 1) :

| Clé | Règle |
|---|---|
| `logoKey` | `null`, ou `^branding/logo/<uuid>\.(png|jpg|webp)$` dont l'objet existe. |
| `displayName`, `tagline` | chaîne, `trim`, 1 à 40 caractères (comptés en points de code, pas en unités UTF-16) ; chaîne vide normalisée en `null`. |
| `welcomeMessage` | idem, 280 caractères maximum. |
| `fontId` | `null` ou identifiant de la liste fermée (§6). |
| `colorBg` | `null` ou `^#[0-9a-fA-F]{6}$`, stocké en minuscules. |

Pour les trois textes : refuser les caractères de contrôle (NUL compris, que Postgres rejette) ; stockage en texte brut, sans nettoyage HTML (l'échappement est fait au rendu).

Quand `logoKey` change ou passe à `null`, l'ancien objet S3 est supprimé après l'écriture en base, en best-effort (comme au lot 1).

### 5.2 Upload du logo

Mêmes deux routes que le lot 1, avec `:kind = logo` :

- `POST /settings/assets/logo/upload-url` : `contentType` ∈ `image/png`, `image/jpeg`, `image/webp`. Clé brute `branding/logo/raw/<uuid>`.
- `POST /settings/assets/logo/confirm` : mêmes étapes que le watermark (préfixe de clé, `HeadObject` ≤ 2 Mo, type réel lu par `sharp`, dimensions ≤ 2000 × 2000 px, ré-encodage) avec une différence : `format` accepté ∈ `png`, `jpeg`, `webp`, et le ré-encodage **conserve le format détecté** (clé finale `branding/logo/<uuid>.<png|jpg|webp>`). Pas de redimensionnement.

Seule modification de code partagé : la liste des `kind` valides et la table de formats acceptés par `kind` dans `settings.constants.js` / `settings.service.js`.

### 5.3 `DELETE /settings/logo` → 200

Met `logoKey` à `null` et supprime l'objet S3 (best-effort).

### 5.4 Restaurer les valeurs par défaut

Pas de nouvelle route : le bouton envoie `PUT /settings` avec les 6 champs du lot 2 à `null`. L'objet logo est supprimé par la règle du §5.1.

### 5.5 `GET /client/:token` : bloc `branding`

La réponse devient :

```
{ collection, photos, photographerName,
  branding: {
    logoUrl: string|null,          // URL présignée, 300 s, comme les previews
    displayName: string|null,
    tagline: string|null,
    welcomeMessage: string|null,
    fontId: string|null,
    colorBg: string|null
  } | null }
```

- Sans ligne en base : un `branding` avec tous les champs à `null`.
- `branding` ne contient **jamais** `logoKey`, ni aucun champ `watermark*`.
- Un `branding` à `null` (lecture en échec, D7) est traité par le front comme « tout par défaut ».
- Ajout en une clé : le front actuel l'ignore, aucune régression pour un front pas encore redéployé.

## 6. Modifications back

- **`settings.service.js`** : étendre `validate…` aux 6 champs ; ajouter `getClientBranding()` (lecture de la ligne, présignature de `logoKey` via `s3Repository.getSignedDownloadUrl`).
- **`client.controller.js`** (`getClientGallery`) : appeler `getClientBranding()` dans son propre `try/catch` (D7), l'ajouter à `res.json`. Le reste du contrôleur ne change pas.
- **Liste des polices** : `FONT_IDS` dans `settings.constants.js`. La même liste d'identifiants existe côté front (§7) ; la duplication est assumée (`back` n'est pas un workspace), la maintenir à deux endroits et le noter en commentaire des deux fichiers.
- Aucune modification de `toClientPhotoDTO`.

## 7. Front-client

### 7.1 Polices embarquées (supprime l'appel à Google Fonts)

- Retirer les trois `<link>` Google Fonts de `front-client/index.html`.
- Embarquer les polices par paquets npm `@fontsource/*` (licence OFL, fichiers `woff2` émis par Vite dans le bundle), **sous-ensemble latin uniquement**, graisses 400 et 500 : les accents français et « œ » y sont. Le navigateur ne télécharge que la police effectivement utilisée.
- Liste fermée proposée (point ouvert P3), `fontId` → titre / texte courant :

| `fontId` | Police des titres (`--font-heading`) | Texte courant (`--font-body`) |
|---|---|---|
| `cormorant` (**défaut**) | Cormorant Garamond 500 | pile actuelle `'Work Sans', var(--sans)` |
| `playfair` | Playfair Display 500 | Source Sans 3 |
| `lora` | Lora 500 | Source Sans 3 |
| `montserrat` | Montserrat 500 | Montserrat 400 |
| `dm-sans` | DM Sans 500 | DM Sans 400 |

- Le défaut garde la déclaration actuelle du texte courant à l'identique, y compris « Work Sans » non chargée (retomber sur `system-ui` est le rendu d'aujourd'hui). Seule « Cormorant Garamond » passe de Google Fonts à l'embarqué, avec les mêmes graisses.
- La table `fontId → { heading, body }` vit dans `front-shared/src/constants/fonts.js` (déjà consommé par les deux fronts, comme `collectionStatus.js`) : `front-client` s'en sert pour les familles CSS, `front-admin` pour les libellés du sélecteur.

### 7.2 Variables CSS

Dans `front-client/src/App.css`, sur `.client-gallery`, définir les défauts :

- `--color-bg: oklch(97.5% 0.006 80)` → `background: var(--color-bg)` ;
- `--font-heading: 'Cormorant Garamond', serif` → utilisée par `.client-gallery-brand-name`, `.client-gallery-title`, `.client-validate-button` à la place des littéraux actuels ;
- `--font-body: 'Work Sans', var(--sans)` → `font-family` de `.client-gallery`.

Les autres couleurs (texte, séparateur, étiquette, bouton, états de sélection) **ne changent pas** : elles restent en `oklch` dans le CSS. Seul `App.css` de `front-client` est modifié ; la copie d'`front-admin` ne sert pas à la vue client et n'est pas touchée (elle va donc diverger, sans effet).

### 7.3 Application des réglages

- `galleryLoadedState` conserve `branding` (`data.branding ?? null`). Les états chargement, erreur et lien invalide n'en ont pas : ils s'affichent avec les défauts.
- Sur le `<div className="client-gallery">` du rendu principal, poser en `style` les variables **uniquement pour les valeurs présentes** : `--color-bg` si `colorBg` respecte `^#[0-9a-f]{6}$` (revalidé côté front par précaution), `--font-heading` et `--font-body` depuis la table de `fonts.js` si `fontId` est connu. Aucune valeur du réseau n'est injectée telle quelle dans un style.
- La lightbox est rendue à l'intérieur de ce `div` : elle hérite des variables.

### 7.4 En-tête et message d'accueil (`PublicGallery.jsx`)

Nom effectif = `branding.displayName ?? photographerName`. Sous-titre effectif = `branding.tagline ?? 'Photographe'`.

| Cas | Rendu du bloc `client-gallery-brand` |
|---|---|
| `logoUrl` présent | `<img>` (alt = nom effectif, ou vide si aucun) à la place du nom ; séparateur et sous-titre conservés. |
| pas de logo, nom effectif présent | nom, séparateur, sous-titre (comme aujourd'hui). |
| ni logo ni nom effectif | pas de bloc (comme aujourd'hui sans `photographerName`). |

- Condition d'affichage du bloc : `logoUrl || nomEffectif` (aujourd'hui : `photographerName`).
- Hauteur maximale du logo fixée en CSS (classe dédiée, valeur de départ 80 px à ajuster visuellement), `max-width: 100%`. Pas réglable.
- Message d'accueil : `<p className="client-gallery-welcome">{welcomeMessage}</p>` entre le `<h1>` et le sous-titre de statut, si `collection.status === STATUS.SELECTING` et `welcomeMessage` non vide. Rendu en texte JSX (échappé par React).
- Tous les textes sont rendus en JSX texte ; aucun `dangerouslySetInnerHTML`.

Limite connue : les réglages arrivent avec le payload, donc fond et police par défaut sont visibles pendant le « Chargement… » avant de basculer sur les valeurs personnalisées. Non traité en v1.

## 8. Front-admin

Dans la page « Réglages » créée au lot 1, ajouter une section « Vue client » (composant `ClientBrandingSettings.jsx`) :

- logo : sélecteur de fichier (`accept="image/png,image/jpeg,image/webp"`), mêmes appels `upload-url` / `confirm` que le watermark, avec `kind = logo` ; bouton de retrait (`DELETE /settings/logo`) ;
- trois champs texte avec compteur de longueur (40 / 40 / 280, `maxLength` en aide, le back fait foi) ;
- sélecteur de police (libellés issus de `front-shared/src/constants/fonts.js`, rendus en texte simple) ;
- sélecteur de couleur de fond (`<input type="color">`, valeur initiale = fond par défaut en hex) ;
- avertissement non bloquant de contraste (ci-dessous) ;
- « Restaurer les valeurs par défaut » (`window.confirm`, puis `PUT` des 6 champs à `null`) ;
- bouton « Enregistrer ».

Pas d'aperçu : un rappel textuel après enregistrement n'est pas requis ; Emma rafraîchit sa page client.

**Avertissement de contraste (WCAG AA, 4,5:1).** Le texte étant fixe, le contraste est calculé entre le fond choisi et les deux couleurs de texte du corps de la page : texte principal `oklch(18% 0.005 80)` et texte secondaire `oklch(45% 0.01 80)`. Avertir si l'un des deux passe sous 4,5. Les deux équivalents hex sont des constantes dans `front-shared/src/constants/` (à calculer à l'implémentation à partir de `App.css`). Non bloquant : l'enregistrement reste possible.

## 9. Sécurité

- Validation côté back (regex, longueurs, liste fermée, préfixes de clé) ; le front la répète en aide mais ne fait pas foi.
- Les textes ne sont jamais interprétés : rendu JSX texte, pas de HTML ni de Markdown.
- Aucune valeur saisie n'atteint un style sans validation : `colorBg` par regex (back et front), police par identifiant et table de code.
- Logo : mêmes contrôles que le watermark (type réel, taille, dimensions, ré-encodage) ; bucket privé, servi par URL présignée ; jamais de SVG.
- Le payload client n'expose ni `logoKey` ni donnée de watermark.
- Aucun appel réseau à un service de polices externe après le retrait des `<link>`.

## 10. Tests

À ajouter :
- `back/test/settings.service.test.js` (complète celui du lot 1) :
  - validation : `displayName` à 41 caractères, `welcomeMessage` à 281, texte contenant `\u0000`, `colorBg` = `red` / `#fff` / `#GGGGGG` / `javascript:…`, `fontId` inconnu, `logoKey` hors préfixe → refusés ; `#ABCDEF` accepté et stocké en minuscules ; chaîne vide → `null` ;
  - `confirmUpload('logo', …)` : PNG, JPEG et WebP acceptés avec le format conservé ; GIF et SVG refusés ; > 2 Mo refusé ;
  - `getClientBranding` : sans ligne, tous les champs à `null` ; avec `logoKey`, `logoUrl` présignée ; le résultat ne contient ni `logoKey` ni clé `watermark*`.
- Test du contrôleur client (ou du service appelé) : si `getClientBranding` lève, `getClientGallery` répond 200 avec `branding: null`. Aucun test de contrôleur n'existe aujourd'hui ; la construction suit celle de `cors.test.js` (app réelle, `db` et `s3` mockés).

Inchangés : `cors.test.js` (hors ajout du lot 1), `photo.service.test.js`, `collection.service.test.js`.

Le front n'a pas de tests automatisés (`front-client` n'a que `eslint`) : la vérification est manuelle (§11).

## 11. Critères d'acceptation (reprise du §9 de la spec, lot 2)

| Critère | Comment le vérifier |
|---|---|
| Sans réglage, page identique à la référence | Avant toute modification, capturer la page client dans les trois états `SELECTING`, `EDITING` (validée) et `READY`, plus la lightbox ; refaire les captures après le lot sans réglage en base et comparer. |
| Logo, textes, police, fond visibles sur toutes les collections et tous les statuts | Enregistrer des réglages, rafraîchir une page client dans chacun des trois statuts. Le message d'accueil n'apparaît qu'en `SELECTING`. |
| Texte avec HTML affiché littéralement | Nom, sous-titre et message d'accueil contenant `<b>x</b><script>`. |
| Couleur invalide rejetée par le back | Test `settings.service` ; `PUT` direct avec `colorBg: "red"` → 400. |
| Aucun appel réseau vers un service de polices externe | Onglet Réseau du navigateur sur la page client : aucune requête vers `fonts.googleapis.com` / `fonts.gstatic.com`. Chaque police choisie se charge depuis le domaine du front. |
| Défaut du fond hex ≈ fond actuel | Comparer visuellement la couleur par défaut du sélecteur et la page. |

## 12. Ordre d'implémentation

1. Captures de référence (§11), avant tout changement.
2. Migration et modèle.
3. Validation et `getClientBranding` dans `settings.service.js`, extension de `confirmUpload` au logo, tests.
4. `client.controller.js` (bloc `branding`, D7) et son test.
5. Polices embarquées et retrait de Google Fonts ; variables CSS à valeurs par défaut identiques ; **vérifier à ce stade que la page est inchangée** avant d'ajouter les réglages.
6. `PublicGallery.jsx` : en-tête, logo, message d'accueil, application des variables.
7. Front-admin (section « Vue client »).

## 13. Points ouverts

- **P1. Fond par défaut.** `colorBg = null` (rien posé) est recommandé. Alternative : stocker la valeur hex approchée comme défaut, au prix d'un écart de rendu minime avec l'`oklch` actuel.
- **P2. Logo et sous-titre.** D5 garde séparateur et sous-titre sous le logo. Si Emma préfère que le logo remplace tout le bloc (nom, séparateur, sous-titre), c'est une condition de rendu à changer, sans effet sur l'API.
- **P3. Liste des polices.** Les 5 options du §7.1 sont une proposition à valider (pairings et noms). L'ajout d'une police ne demande ni migration ni changement d'API : un identifiant dans les deux listes, un paquet `@fontsource`.
- **P4. Hors périmètre, constaté.** `GET /client/:token` renvoie `req.collection` en entier, donc `clientEmail` et `accessToken` sont dans le payload client. Non traité ici.
- **P5. Hors périmètre, constaté.** `front-admin/index.html` charge aussi Google Fonts alors que l'admin n'utilise pas Cormorant. Le critère d'acceptation ne concerne que la vue client ; non traité ici.
