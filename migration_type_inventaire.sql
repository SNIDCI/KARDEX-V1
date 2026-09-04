-- Migration à exécuter dans Supabase (SQL Editor > New query > Run)
-- Autorise le type de mouvement "inventaire" (en plus de "entree" et "sortie").

alter table kardex_mouvements drop constraint if exists kardex_mouvements_type_check;
alter table kardex_mouvements add constraint kardex_mouvements_type_check
  check (type in ('entree', 'sortie', 'inventaire'));
