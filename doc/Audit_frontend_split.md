# Audit du frontend existant — préparation au split admin / client

Date : 2026-09-05
Périmètre : `front/smile/` (seul frontend du repo). Aucun fichier n'a été modifié pour produire cet audit.

---

## 1. Structure actuelle

### Arborescence

```
front/smile/
├── index.html
├── vite.config.js
├── package.json
├── src/
│   ├── main.jsx                  # point d'entrée, routing "maison"
│   ├── App.jsx                   # shell admin (session + logout + Gallery)
│   ├── App.css / index.css
│   ├── api/
│   │   ├── client.js             # fetch admin (cookie de session)
│   │   ├── auth.js                # login/logout/me
│   │   └── publicGallery.js      # fetch client (token dans l'URL)
│   ├── components/
│   │   ├── Login.jsx              # ADMIN
│   │   ├── Gallery.jsx            # ADMIN (racine du back-office)
│   │   ├── CollectionList.jsx     # ADMIN
│   │   ├── CollectionCard.jsx     # ADMIN
│   │   ├── CollectionColumn.jsx   # ADMIN
│   │   ├── CollectionForm.jsx     # ADMIN
│   │   ├── PhotoList.jsx          # ADMIN
│   │   ├── PhotoUploadForm.jsx    # ADMIN
│   │   ├── PublicGallery.jsx      # CLIENT
│   │   ├── Photo.jsx              # PARTAGÉ
│   │   └── PhotoLightbox.jsx      # PARTAGÉ
│   ├── constants/
│   │   └── collectionStatus.js    # ADMIN (mais statuts lus aussi côté client)
│   └── utils/
│       └── concurrency.js         # ADMIN (upload)
```

Il n'y a pas de dossier de state management dédié (pas de Redux/Zustand/Context global) : tout le state vit dans `useState`/`useEffect` locaux à `App.jsx`, `Gallery.jsx` et `PublicGallery.jsx`, passés en props aux enfants.

### Framework et outils

- **React 19** (`react`, `react-dom` ^19.2.8), build avec **Vite 8**.
- Aucun routeur (`react-router` absent du `package.json`). Le "routing" est fait à la main dans [main.jsx](front/smile/src/main.jsx) : un `match` regex sur `window.location.pathname` (`/^\/gallery\/([^/]+)\/?$/`) décide au chargement de la page si on monte `<PublicGallery>` ou `<App>` (admin). C'est un aiguillage statique, pas une vraie navigation SPA — il n'y a pas d'autre route déclarée que `/` (admin) et `/gallery/:token` (client).
- Pas de librairie de state management, pas de librairie de formulaires, pas de librairie CSS (CSS "maison" dans `App.css`/`index.css`).
- Un seul `package.json`, un seul `vite.config.js`, une seule config ESLint : il n'existe **aucune séparation de build** entre admin et client aujourd'hui. Tout est compilé dans un seul bundle unique.

### Distinction visuelle dans le code

Il n'existe **aucun dossier `/admin` ou `/client`**. La distinction se fait uniquement :
- au niveau du point d'entrée (`main.jsx`, sur l'URL),
- par convention de nommage des composants (`Public*` vs les autres),
- par les fichiers d'API (`auth.js` + `client.js` pour l'admin, `publicGallery.js` pour le client — nommage à noter : `client.js` est en réalité le client HTTP *admin*, pas lié à l'espace "client final", ce qui est une source de confusion potentielle avec le vocabulaire métier du projet).

---

## 2. Inventaire des routes / pages

| Route / point d'entrée | Rôle fonctionnel | Public visé | Fichiers/composants impliqués |
|---|---|---|---|
| `/` (tout chemin ne matchant pas `/gallery/:token`) | Point d'entrée unique du back-office : écran de connexion si pas de session, sinon dashboard | ADMIN | `main.jsx`, `App.jsx`, `Login.jsx` |
| `/` après connexion — vue "liste des collections" | Tableau Kanban des collections par statut (DRAFT/SELECTING/EDITING/READY/ARCHIVED), création de collection | ADMIN | `Gallery.jsx`, `CollectionList.jsx`, `CollectionColumn.jsx`, `CollectionCard.jsx`, `CollectionForm.jsx` |
| `/` après connexion — vue "détail collection" (état interne, pas une vraie route) | Liste des photos d'une collection : upload, suppression, changement de statut, lien de partage client, révocation d'accès, marquage "prêt", téléchargement de la sélection HD, upload/suppression des livrables finaux | ADMIN | `PhotoList.jsx`, `PhotoUploadForm.jsx`, `Photo.jsx` |
| `/gallery/:token` | Galerie client accédée via token opaque dans l'URL : visualisation des photos, sélection/désélection (si statut SELECTING), validation de la sélection, téléchargement de toutes les photos livrées (si statut READY), lightbox | CLIENT | `main.jsx`, `PublicGallery.jsx`, `Photo.jsx`, `PhotoLightbox.jsx` |

Remarques :
- Il n'y a **pas de sous-routes** additionnelles (pas de `/collections/:id`, pas de deep-link vers une photo précise, etc.) : la navigation "détail collection" est un simple état React (`selectedCollection`) dans `Gallery.jsx`, pas une URL.
- Aucune page n'est réellement AMBIGUË en tant que route — la frontière ADMIN/CLIENT est nette au niveau des pages. L'ambiguïté se situe au niveau des **composants** (section 3) et de **l'API** (section 4), pas des routes elles-mêmes.

---

## 3. Composants partagés

| Composant | Utilisé par | Logique conditionnelle liée au rôle ? |
|---|---|---|
| `Photo.jsx` (+ `PhotoSelectionButtons` exporté du même fichier) | ADMIN (`PhotoList.jsx`) et CLIENT (`PublicGallery.jsx`) | Oui, mais **par les props reçues des parents**, pas par une détection interne du rôle : `onDelete`, `onUpdateStatus`, `onOpen`, `downloadUrl`, `downloadFilename`, `allowReset` sont fournis ou non selon le contexte appelant. Le composant lui-même ne fait aucun `if isAdmin`/`if hasToken` — il est agnostique et purement piloté par ses props. C'est une bonne nouvelle pour le split (voir section 6). |
| `PhotoLightbox.jsx` | ADMIN (potentiellement, mais actuellement seul `PublicGallery.jsx` l'utilise — `Gallery`/`PhotoList` admin n'a pas de lightbox) | Non — même logique : piloté par `onUpdateStatus` optionnel passé en prop. |
| `constants/collectionStatus.js` (`STATUS_OPTIONS`, `STATUS_LABELS`) | ADMIN (`CollectionForm`, `CollectionCard`, `CollectionColumn`) et implicitement CLIENT (`PublicGallery.jsx` compare `collection.status` aux mêmes valeurs `'SELECTING'`/`'READY'` mais **en dur**, sans importer la constante) | Pas de logique conditionnelle par rôle, mais une **duplication implicite** : le client réécrit les valeurs de statut en chaînes littérales au lieu d'importer `collectionStatus.js`. Risque de désynchronisation si le enum de statuts évolue. |

Il n'y a donc, en l'état, **aucun composant partagé contenant un branchement explicite par rôle** (`isAdmin`, `hasToken`, etc.) — le seul partage réel concerne `Photo.jsx`/`PhotoLightbox.jsx`, conçus de façon suffisamment neutre (pilotés par props) pour être dupliqués ou extraits en package commun sans réécriture profonde.

---

## 4. Gestion de l'authentification côté front

- **Distinction admin/client** : elle ne repose sur **aucun mécanisme applicatif côté front** — c'est uniquement l'URL au chargement (`/gallery/:token` vs le reste) qui détermine quel arbre React est monté ([main.jsx](front/smile/src/main.jsx)). Il n'y a pas de contexte d'auth unifié, pas de notion de "rôle" dans le state React.
- **Auth admin** : ce n'est **pas du JWT** côté implémentation actuelle, contrairement à ce qui était supposé dans le contexte de la tâche — c'est une **session serveur classique** (`express-session`, cookie `httpOnly`, `sameSite: lax`, 8h de durée de vie). Le front ne stocke rien lui-même : chaque requête admin passe par `apiFetch` ([client.js](front/smile/src/api/client.js)) qui force `credentials: 'include'`, et c'est le cookie de session géré par le navigateur qui porte l'authentification. L'état "photographe connecté" en mémoire React (`App.jsx`) n'est qu'un cache local de `/auth/me`, revalidé à chaque chargement de page.
- **Auth client** : le token est extrait de l'URL par regex dans `main.jsx`, puis passé en prop jusqu'à `PublicGallery`. Il n'est stocké nulle part (pas de `localStorage`/cookie) : il est simplement réinjecté dans chaque appel API via le path (`/client/:token`, `/client/:token/validate`, etc., voir [publicGallery.js](front/smile/src/api/publicGallery.js)). Le fetch client (`publicFetch`) n'envoie pas `credentials: 'include'` — les deux fonctions de fetch (`apiFetch` pour l'admin, `publicFetch` pour le client) sont bien séparées dans le code, ce qui est positif pour le split.
- **Mélange des deux mécanismes** : il n'y a **aucun appel API partagé** entre les deux mondes. Côté backend ([app.js](back/app.js)), le découpage est net : `/auth` et `/client` ne passent pas par `requireAuth`, alors que `/collections` et `/photos` l'exigent systématiquement. Aucune route API n'est appelée à la fois par le front admin et par le front client avec des payloads différents — c'est une séparation déjà propre côté API, ce qui facilite le split front.

---

## 5. State management et dépendances croisées

- **State** : entièrement local par arbre de composants — `App.jsx` gère l'état de session admin, `Gallery.jsx` gère collections/photos/sélection courante, `PublicGallery.jsx` gère son propre state (chargement, validation, téléchargement). Il n'y a **aucun state partagé** entre les deux univers : ce sont deux arbres React totalement indépendants, montés de façon exclusive par `main.jsx`. C'est donc déjà "segmenté" de fait, simplement au sein d'un seul bundle/repo.
- **Dépendances npm** : le `package.json` est minimal — seulement `react`/`react-dom` en dépendances de prod, et l'outillage Vite/ESLint en dev. **Aucune dépendance lourde spécifique à l'admin** (pas d'éditeur riche, pas de librairie de charts, pas de datepicker, pas de librairie d'UI). Le bundle est donc déjà très léger ; il n'y a pas aujourd'hui de gain de poids de bundle à attendre du split côté dépendances (mais cela pourrait changer si l'admin grossit).

---

## 6. Risques identifiés pour le split

| Risque | Piste de résolution (1 phrase) |
|---|---|
| Le routing actuel n'est pas un vrai routeur mais un test regex unique dans `main.jsx` qui décide entre deux arbres React — toute nouvelle route future (ex: mot de passe oublié, invitation) devra être ajoutée à ce même aiguillage tant que le split n'est pas fait | Introduire un routeur (ou simplement deux points d'entrée Vite distincts) dès le split plutôt que d'étendre l'aiguillage regex actuel. |
| `Photo.jsx` et `PhotoLightbox.jsx` sont partagés et devront être présents dans les deux nouveaux fronts | Soit les dupliquer volontairement (divergence assumée), soit les extraire dans un package/lib partagé (`front-shared` ou équivalent) pour éviter la duplication de bug fixes. |
| `constants/collectionStatus.js` n'est pas importé par `PublicGallery.jsx`, qui réécrit les valeurs de statut en dur (`'SELECTING'`, `'READY'`) | Faire importer cette constante par le front client dès maintenant (ou la dupliquer consciemment) pour éviter une désynchronisation silencieuse si les statuts évoluent après le split. |
| Le fichier `api/client.js` (fetch admin authentifié) porte un nom proche du vocabulaire métier "client" (le client final de la photographe), source de confusion lors du split en 2 dossiers distincts | Renommer ce fichier (ex: `api/http.js` ou `api/adminClient.js`) avant/pendant le split pour lever l'ambiguïté de nommage. |
| Auth admin par cookie de session (pas JWT) : un split en deux origines/domaines distincts (ex: `admin.domaine.com` vs `galerie.domaine.com`) peut casser le cookie `sameSite: lax` selon la configuration finale de déploiement | Valider tôt l'architecture de déploiement (sous-domaines vs domaines séparés) et ajuster `sameSite`/`domain` du cookie de session en conséquence — c'est un risque back+infra, pas seulement front. |
| Un seul `package.json`/`vite.config.js`/config ESLint aujourd'hui : aucune séparation de build n'existe, donc le split implique de dupliquer entièrement l'outillage (deux `package.json`, deux configs Vite, etc.), avec risque de divergence de versions de dépendances entre les deux fronts au fil du temps | Envisager un monorepo avec workspace partagé (npm/pnpm workspaces) pour mutualiser les versions de `react`/`vite`/ESLint entre les deux fronts. |
| `API_BASE_URL` est actuellement codé en dur (`http://localhost:3000`) dans `api/client.js`, sans variable d'environnement Vite | Passer par des variables d'environnement (`import.meta.env`) dès le split, chaque front pouvant avoir sa propre config de déploiement. |
| Aucun test automatisé n'a été trouvé dans `front/smile/` (pas de dossier `test`/`__tests__`, pas de dépendance de test dans `package.json`) — un split "à l'aveugle" sans filet de non-régression | Ajouter a minima quelques tests de fumée (rendu des deux pages principales) avant de lancer la séparation physique des dossiers. |
| `PhotoList.jsx` (admin) contient une logique métier non triviale sur les statuts de collection (`canSelect`, `canAddPhotos`, `isEditing`, `isReady`) qui recoupe partiellement celle de `PublicGallery.jsx` (`isSelecting`, `isReady`) sans être factorisée | Si un composant/hook partagé est extrait pour `Photo`/`PhotoLightbox`, envisager d'y inclure aussi ces dérivés de statut pour éviter une double maintenance des règles métier. |

---

**Non traité dans cet audit (hors périmètre demandé)** : proposition d'architecture cible, découpage de dossiers, stratégie de déploiement/CI, ou modifications du code. Ce document est un état des lieux factuel destiné à servir de base à la spécification du split.
