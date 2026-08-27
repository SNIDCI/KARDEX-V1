-- À exécuter dans Supabase : SQL Editor > New query > coller > Run

create table if not exists kardex_mouvements (
  id uuid primary key default gen_random_uuid(),
  article_code integer not null,
  type text not null check (type in ('entree', 'sortie')),
  quantite integer not null check (quantite > 0),
  date date not null,
  motif text,
  reference text,
  created_at timestamptz default now()
);

alter table kardex_mouvements enable row level security;

-- V1 : accès simple sans authentification (usage interne, lien non public).
-- À restreindre (ex: exiger une connexion) quand on ajoutera les utilisateurs en V4.
create policy "kardex_mouvements_all_anon"
  on kardex_mouvements
  for all
  using (true)
  with check (true);

-- Active la synchronisation temps réel utilisée par l'application
alter publication supabase_realtime add table kardex_mouvements;
