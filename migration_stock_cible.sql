-- Migration à exécuter dans Supabase (SQL Editor > New query > Run)
-- Ajoute la table utilisée par la colonne "Qté voulue" du Catalogue

create table if not exists kardex_stock_cible (
  article_code integer primary key,
  quantite_voulue integer not null default 0,
  updated_at timestamptz default now()
);

alter table kardex_stock_cible enable row level security;

create policy "kardex_stock_cible_all_anon"
  on kardex_stock_cible
  for all
  using (true)
  with check (true);

alter publication supabase_realtime add table kardex_stock_cible;
