-- Migration à exécuter dans Supabase (SQL Editor > New query > Run)
-- Étape 1/2 du système de connexion : profils + sécurisation des données existantes.
-- Ce script peut être relancé sans risque même s'il a déjà été exécuté partiellement.

-- 1) Table des profils (nom du magasin + photo), une ligne par utilisateur connecté
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  magasin_nom text,
  photo_url text,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles for update using (auth.uid() = id);

-- 2) Rattacher chaque mouvement et chaque quantité voulue à l'utilisateur qui l'a créé
alter table kardex_mouvements add column if not exists user_id uuid references auth.users(id) default auth.uid();
alter table kardex_stock_cible add column if not exists user_id uuid references auth.users(id) default auth.uid();

-- 3) Nettoyer les quantités voulues de test saisies avant la mise en place de la connexion
--    (aucun utilisateur ne peut leur être associé rétroactivement ; à ressaisir une fois connecté)
delete from kardex_stock_cible where user_id is null;

-- 4) La quantité voulue est désormais unique par article ET par magasin (utilisateur)
alter table kardex_stock_cible drop constraint if exists kardex_stock_cible_pkey;
alter table kardex_stock_cible add primary key (article_code, user_id);

-- 5) Remplacer les anciennes règles ouvertes par des règles restreintes au propriétaire
drop policy if exists "kardex_mouvements_all_anon" on kardex_mouvements;
drop policy if exists "kardex_mouvements_own" on kardex_mouvements;
create policy "kardex_mouvements_own" on kardex_mouvements
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "kardex_stock_cible_all_anon" on kardex_stock_cible;
drop policy if exists "kardex_stock_cible_own" on kardex_stock_cible;
create policy "kardex_stock_cible_own" on kardex_stock_cible
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ⚠️ Les mouvements (kardex_mouvements) déjà saisis avant cette migration ont user_id = NULL
-- et ne seront plus visibles une fois connecté (eux ne sont PAS supprimés par ce script).
-- Une fois ton compte créé (étape suivante), récupère ton user_id dans Authentication > Users,
-- puis exécute :
--   update kardex_mouvements set user_id = 'TON-USER-ID' where user_id is null;
