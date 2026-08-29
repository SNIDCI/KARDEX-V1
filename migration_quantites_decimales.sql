-- Migration à exécuter dans Supabase (SQL Editor > New query > Run)
-- Permet des quantités décimales (ex : 0,167 carton pour une unité vendue sur un colis de 6).

alter table kardex_mouvements
  alter column quantite type numeric(10,3) using quantite::numeric(10,3);

alter table kardex_stock_cible
  alter column quantite_voulue type numeric(10,3) using quantite_voulue::numeric(10,3);
