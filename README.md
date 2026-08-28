# Kardex — Magasin Pilote (V1)

Application React + Supabase pour le suivi de stock d'un magasin (module Stock du futur ERP).

## Démarrage local

```bash
npm install
cp .env.example .env.local   # puis renseigner VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm run dev
```

## Base de données

Exécuter le contenu de `supabase_setup.sql` dans l'éditeur SQL du projet Supabase avant le premier lancement.

## Déploiement

Voir le guide fourni : GitHub → Vercel, avec les mêmes variables d'environnement ajoutées dans les réglages du projet Vercel.
