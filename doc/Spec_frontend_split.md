# Spec — Séparation front-admin / front-client

Date : 2026-09-05
Base : `AUDIT_FRONTEND_SPLIT.md` (audit factuel du frontend existant, non modifié)
Statut : à implémenter

---

## 1. Décisions actées

| Sujet | Décision | Justification |
|---|---|---|
| Structure du repo | Monorepo avec **npm workspaces** : `backend/`, `front-admin/`, `front-client/`, `front-shared/` | Permet à `front-admin` et `front-client` de builder/déployer indépendamment tout en mutualisant `front-shared` et les versions de React/Vite/ESLint à la racine |
| Composants partagés | `Photo.jsx` et `PhotoLightbox.jsx` extraits dans `front-shared`, importés par les deux fronts | Déjà neutres (pilotés par props, aucune logique `isAdmin`/`hasToken` interne) — coût d'extraction faible, évite la duplication de bug fixes |
| Auth admin | **Conservée en session cookie** (pas de migration JWT) | Pas de nécessité fonctionnelle de migrer ; ajustements ciblés (sameSite, CORS) suffisent pour supporter deux domaines distincts |
| Domaines | `front-admin` → `montools.fr` ; `front-client` → `collection.emmamarshphotographe.com` (déjà acté précédemment) | — |

---

## 2. Correctif obligatoire côté backend : cookie cross-domaine

**Problème identifié par l'audit** : le cookie de session actuel est configuré en `sameSite: 'lax'`. `montools.fr` et `collection.emmamarshphotographe.com` sont deux domaines distincts (pas des sous-domaines d'un même domaine). Une fois `front-admin` déployé sur son propre domaine, ses appels `fetch`/XHR vers l'API seront **cross-site** — `sameSite: lax` ne couvre pas ce cas (seulement les navigations top-level), donc le cookie de session ne serait plus envoyé et l'admin ne pourrait plus s'authentifier.

**Changements requis (backend, avant ou pendant le split front)** :

- [ ] Passer le cookie de session à `sameSite: 'none'`, `secure: true` (obligatoire en HTTPS, déjà le cas en prod supposé)
- [ ] Configurer CORS avec `Access-Control-Allow-Origin` pointant explicitement sur l'origine de `montools.fr` (pas de wildcard `*` — incompatible avec `credentials`)
- [ ] `Access-Control-Allow-Credentials: true` sur les routes admin
- [ ] Ajouter une vérification de l'en-tête `Origin` sur les routes mutantes (`POST`/`PUT`/`DELETE` de `/collections`, `/photos`) pour compenser la perte de la protection CSRF native de `sameSite: lax`
- [ ] Vérifier que `publicFetch` (routes `/client/:token`) n'est pas impacté — il n'utilise pas `credentials: 'include'` aujourd'hui, donc pas de changement nécessaire côté client

---

## 3. Structure de dossiers cible

```
smile/
├── package.json                  # racine, définit les workspaces
├── backend/                      # inchangé dans sa structure interne
│   └── ...
├── front-shared/
│   ├── package.json
│   └── src/
│       ├── Photo.jsx
│       ├── PhotoLightbox.jsx
│       └── constants/
│           └── collectionStatus.js   # déplacé ici, source unique de vérité
├── front-admin/
│   ├── package.json               # dépend de front-shared en workspace
│   ├── vite.config.js
│   ├── .env / .env.production     # VITE_API_BASE_URL
│   └── src/
│       ├── main.jsx                # entrée dédiée, plus d'aiguillage regex
│       ├── App.jsx
│       ├── api/
│       │   ├── http.js             # renommé depuis client.js (cf. section 5)
│       │   └── auth.js
│       └── components/
│           ├── Login.jsx
│           ├── Gallery.jsx
│           ├── CollectionList.jsx
│           ├── CollectionCard.jsx
│           ├── CollectionColumn.jsx
│           ├── CollectionForm.jsx
│           ├── PhotoList.jsx
│           └── PhotoUploadForm.jsx
└── front-client/
    ├── package.json               # dépend de front-shared en workspace
    ├── vite.config.js
    ├── .env / .env.production     # VITE_API_BASE_URL
    └── src/
        ├── main.jsx                # entrée dédiée, route unique /gallery/:token
        ├── api/
        │   └── publicGallery.js
        └── components/
            └── PublicGallery.jsx
```

**Root `package.json` (workspaces)** :

```json
{
  "name": "smile-monorepo",
  "private": true,
  "workspaces": ["front-shared", "front-admin", "front-client"]
}
```

---

## 4. Routing

Le routing actuel (`main.jsx` avec un test regex unique décidant entre deux arbres React) disparaît de fait : chaque front a maintenant son propre point d'entrée Vite, donc plus besoin d'aiguillage.

- **`front-admin/src/main.jsx`** : monte directement `<App>`, plus de test d'URL. Aucune route interne supplémentaire nécessaire à ce stade (le "détail collection" reste un état React dans `Gallery.jsx`, inchangé).
- **`front-client/src/main.jsx`** : monte `<PublicGallery>`, en extrayant le token depuis le path (`/gallery/:token` devient probablement juste `/:token` ou reste `/gallery/:token` selon la config de déploiement du sous-chemin — à trancher selon la stack d'hébergement de `collection.emmamarshphotographe.com`).

Aucun besoin d'introduire une librairie de routeur (`react-router`) à ce stade — chaque front n'a qu'une seule route réelle.

---

## 5. Corrections de nommage et de dette identifiées par l'audit

À faire pendant le split (coût marginal vu qu'on déplace déjà les fichiers) :

- [ ] Renommer `api/client.js` (admin) → `api/http.js`, pour lever l'ambiguïté avec le vocabulaire métier "client" (client final de la photographe)
- [ ] Faire importer `collectionStatus.js` par `front-client` (actuellement `PublicGallery.jsx` réécrit `'SELECTING'`/`'READY'` en dur) — désormais trivial puisque la constante vit dans `front-shared`
- [ ] Remplacer `API_BASE_URL` codé en dur (`http://localhost:3000`) par `import.meta.env.VITE_API_BASE_URL`, avec un `.env` par front et par environnement (dev/prod)

---

## 6. Étapes de migration (ordre recommandé)

1. **Backend** : appliquer les changements de la section 2 (cookie + CORS + vérif Origin), déployer, valider que l'admin fonctionne toujours en l'état actuel (un seul front, mais avec `sameSite: none`) avant de toucher au front
2. **Créer `front-shared`** : extraire `Photo.jsx`, `PhotoLightbox.jsx`, `collectionStatus.js` dans ce package, sans encore créer les deux nouveaux fronts — le front actuel unique importe temporairement depuis `front-shared` pour valider que l'extraction ne casse rien
3. **Créer `front-admin`** : nouveau dossier, nouveau `vite.config.js`, migration des composants admin, imports depuis `front-shared`, renommage `client.js` → `http.js`, passage aux variables d'env
4. **Créer `front-client`** : même démarche pour `PublicGallery.jsx`, import de `collectionStatus.js` depuis `front-shared` (suppression des valeurs en dur)
5. **Supprimer l'ancien front unique** une fois les deux nouveaux validés en local (build + smoke test manuel des deux parcours)
6. **CI/déploiement** : deux pipelines de build distincts (un par front), chacun déployant vers son domaine respectif

---

## 7. Hors périmètre de cette spec

- Tests automatisés (l'audit note leur absence totale) — recommandé mais traité séparément, pas un prérequis bloquant du split
- Personnalisation par photographe (thème/marque) sur `front-client` — anticipée dans l'architecture (`front-shared` réutilisable pour de futurs fronts client) mais pas spécifiée ici
- Migration JWT (option B écartée pour cette itération)