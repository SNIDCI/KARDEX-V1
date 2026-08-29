import { useState, useEffect, useMemo, useRef } from "react";
import { CATALOGUE_RAW } from "./data/catalogue.js";
import { supabase } from "./supabaseClient.js";
import * as XLSX from "xlsx";

const CATEGORIES_META = {
  "BIERES": { label: "Bières", color: "#B8862B" },
  "S/ALCOOL": { label: "Sans-alcool", color: "#3B7D6E" },
  "ENERGIES": { label: "Énergisants", color: "#A6432A" },
  "LIQUEUR BTL": { label: "Liqueurs (bouteille)", color: "#6E4A9E" },
  "LIQUEUR DOZ": { label: "Liqueurs (douzaine)", color: "#6E4A9E" },
  "VIN BOUCHET": { label: "Vins", color: "#7A2E3A" },
  "VIN BRIQUE": { label: "Vins (brique)", color: "#7A2E3A" },
  "ALIMENTAIRE": { label: "Alimentaire", color: "#2F6F62" },
};

function catMeta(cat) {
  return CATEGORIES_META[cat] || { label: cat, color: "#5B6472" };
}

const ARTICLES = CATALOGUE_RAW.map((a) => ({
  code: a[0],
  designation: a[1],
  categorie: a[2],
  sousFamille: a[3],
  colisage: a[4],
  contenance: a[5],
  fournisseur: a[6],
  barcode: a[7],
  prixDetail: a[8],
  prixCarton: a[9],
  prixUnitaire: a[10],
}));

const ARTICLES_BY_CODE = Object.fromEntries(ARTICLES.map((a) => [a.code, a]));
const CATEGORIES = [...new Set(ARTICLES.map((a) => a.categorie))].sort();
const FOURNISSEURS = [...new Set(ARTICLES.map((a) => a.fournisseur))].sort();

function fmtFCFA(n) {
  return (
    Math.round(n || 0)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " F"
  );
}

// Affiche une quantité (en cartons) avec jusqu'à 3 décimales, sans zéros inutiles.
function fmtQty(n) {
  const v = Number((n || 0).toFixed(3));
  return v.toLocaleString("fr-FR", { maximumFractionDigits: 3 });
}

// Convertit un nombre d'unités vendues/reçues en équivalent-cartons, selon le colisage.
// Ex : colisage 6 → 1 unité = 0,167 carton, 2 unités = 0,334, ... 6 unités = 1 carton.
function unitesEnCartons(unites, colisage) {
  if (!colisage || colisage <= 1) return unites;
  if (unites % colisage === 0) return unites / colisage;
  const fractionUnitaire = Math.round((1 / colisage) * 1000) / 1000;
  return Math.round(fractionUnitaire * unites * 1000) / 1000;
}

function fmtDate(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthsAgoISO(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

const MOTIFS_ENTREE = ["Livraison Dépôt Zone 4", "Réception fournisseur", "Retour client", "Correction inventaire", "Autre"];
const MOTIFS_SORTIE = ["Vente", "Défaut/Casse", "Retour Dépôt Zone 4", "Correction inventaire", "Autre"];

function rowToMouvement(row) {
  return {
    id: row.id,
    article: row.article_code,
    type: row.type,
    quantite: row.quantite,
    date: row.date,
    motif: row.motif,
    reference: row.reference,
    createdAt: row.created_at,
  };
}

// Tri du plus récent au plus ancien : d'abord la date de mouvement saisie,
// puis l'heure de saisie réelle pour départager les mouvements du même jour.
function compareMvtDesc(a, b) {
  if (a.date !== b.date) return b.date.localeCompare(a.date);
  return String(b.createdAt).localeCompare(String(a.createdAt));
}

export default function KardexApp({ profile, onLogout }) {
  const [mouvements, setMouvements] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("dashboard");
  const [selectedCode, setSelectedCode] = useState(null);
  const [saveState, setSaveState] = useState("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const [objectifsByCode, setObjectifsByCode] = useState({});

  async function fetchMouvements() {
    const { data, error } = await supabase
      .from("kardex_mouvements")
      .select("*")
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      setErrorMsg("Impossible de charger les mouvements : " + error.message);
      return;
    }
    setErrorMsg("");
    setMouvements(data.map(rowToMouvement));
  }

  async function fetchObjectifs() {
    const { data, error } = await supabase.from("kardex_stock_cible").select("*");
    if (error) return;
    const map = {};
    for (const row of data) map[row.article_code] = row.quantite_voulue;
    setObjectifsByCode(map);
  }

  async function setObjectif(code, quantite) {
    setObjectifsByCode((prev) => ({ ...prev, [code]: quantite }));
    await supabase.from("kardex_stock_cible").upsert({ article_code: code, quantite_voulue: quantite });
  }

  useEffect(() => {
    (async () => {
      await Promise.all([fetchMouvements(), fetchObjectifs()]);
      setLoaded(true);
    })();

    // Synchronisation en temps réel entre appareils/postes
    const channel = supabase
      .channel("kardex_mouvements_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "kardex_mouvements" }, () => {
        fetchMouvements();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "kardex_stock_cible" }, () => {
        fetchObjectifs();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function addMouvement(m) {
    setSaveState("saving");
    const { error } = await supabase.from("kardex_mouvements").insert({
      article_code: m.article,
      type: m.type,
      quantite: m.quantite,
      date: m.date,
      motif: m.motif,
      reference: m.reference || null,
    });
    if (error) {
      setSaveState("error");
      setErrorMsg("Échec de l'enregistrement : " + error.message);
      return;
    }
    await fetchMouvements();
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1200);
  }

  const stockByCode = useMemo(() => {
    const map = {};
    for (const m of mouvements) {
      const delta = m.type === "entree" ? m.quantite : -m.quantite;
      map[m.article] = (map[m.article] || 0) + delta;
    }
    return map;
  }, [mouvements]);

  const suiviCodes = useMemo(() => [...new Set(mouvements.map((m) => m.article))], [mouvements]);

  const valeurStock = useMemo(() => {
    return suiviCodes.reduce((sum, code) => {
      const art = ARTICLES_BY_CODE[code];
      if (!art) return sum;
      return sum + Math.max(0, stockByCode[code] || 0) * art.prixCarton;
    }, 0);
  }, [suiviCodes, stockByCode]);

  const ruptures = suiviCodes.filter((c) => (stockByCode[c] || 0) <= 0);
  const stockFaible = useMemo(() => {
    return suiviCodes.filter((c) => {
      const stock = stockByCode[c] || 0;
      if (stock <= 0) return false;
      const objectif = objectifsByCode[c] || 0;
      return objectif > 0 ? stock < objectif : stock <= 5;
    });
  }, [suiviCodes, stockByCode, objectifsByCode]);

  const articlesActifs6Mois = useMemo(() => {
    const cutoff = monthsAgoISO(6);
    return new Set(mouvements.filter((m) => m.date >= cutoff).map((m) => m.article)).size;
  }, [mouvements]);

  const mouvementsRecents = useMemo(() => [...mouvements].sort(compareMvtDesc).slice(0, 8), [mouvements]);
  if (!loaded) {
    return (
      <div style={{ minHeight: 500, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, sans-serif", color: "#8A8272" }}>
        <Style />
        Chargement du kardex…
      </div>
    );
  }

  return (
    <div className="kx-root">
      <Style />
      <Sidebar view={view} setView={setView} saveState={saveState} profile={profile} onLogout={onLogout} />
      <main className="kx-main">
        {errorMsg && <div className="kx-alert">{errorMsg}</div>}
        {view === "dashboard" && (
          <Dashboard
            valeurStock={valeurStock}
            suiviCodes={suiviCodes}
            ruptures={ruptures}
            stockFaible={stockFaible}
            articlesActifs6Mois={articlesActifs6Mois}
            objectifsByCode={objectifsByCode}
            stockByCode={stockByCode}
            mouvementsRecents={mouvementsRecents}
            onOpenArticle={(code) => {
              setSelectedCode(code);
              setView("kardex");
            }}
            onOpenCommande={() => setView("commande")}
          />
        )}
        {view === "commande" && (
          <CommandeView ruptures={ruptures} objectifsByCode={objectifsByCode} stockByCode={stockByCode} onBack={() => setView("dashboard")} />
        )}
        {view === "kardex" && (
          <KardexView
            mouvements={mouvements}
            stockByCode={stockByCode}
            selectedCode={selectedCode}
            setSelectedCode={setSelectedCode}
            addMouvement={addMouvement}
          />
        )}
        {view === "catalogue" && (
          <CatalogueView
            stockByCode={stockByCode}
            objectifsByCode={objectifsByCode}
            setObjectif={setObjectif}
            onOpenArticle={(code) => {
              setSelectedCode(code);
              setView("kardex");
            }}
          />
        )}
      </main>
    </div>
  );
}

function Sidebar({ view, setView, saveState, profile, onLogout }) {
  const items = [
    { id: "dashboard", label: "Tableau de bord", icon: "◧" },
    { id: "kardex", label: "Kardex", icon: "▤" },
    { id: "catalogue", label: "Catalogue", icon: "▦" },
  ];
  const magasinNom = (profile && profile.magasin_nom) || "Mon Magasin";
  const photoUrl = profile && profile.photo_url;
  return (
    <aside className="kx-sidebar">
      <div className="kx-brand">
        {photoUrl ? (
          <img src={photoUrl} alt="" className="kx-brand-photo" />
        ) : (
          <div className="kx-brand-mark">{magasinNom.charAt(0).toUpperCase()}</div>
        )}
        <div>
          <div className="kx-brand-title">{magasinNom.toUpperCase()}</div>
          <div className="kx-brand-sub">Kardex — V1</div>
        </div>
      </div>
      <nav className="kx-nav">
        {items.map((it) => (
          <button key={it.id} className={"kx-nav-item" + (view === it.id ? " active" : "")} onClick={() => setView(it.id)}>
            <span className="kx-nav-icon">{it.icon}</span>
            {it.label}
          </button>
        ))}
      </nav>
      <div className="kx-sidebar-footer">
        <div className={"kx-save-dot " + saveState} />
        <span>
          {saveState === "saving" && "Enregistrement…"}
          {saveState === "saved" && "Enregistré"}
          {saveState === "error" && "Erreur d'enregistrement"}
          {saveState === "idle" && "1 584 articles chargés"}
        </span>
      </div>
      {onLogout && (
        <button className="kx-logout" onClick={onLogout}>
          Déconnexion
        </button>
      )}
    </aside>
  );
}

function StatCard({ label, value, hint, tone, title }) {
  return (
    <div className={"kx-stat" + (tone ? " tone-" + tone : "")} title={title}>
      <div className="kx-stat-label">{label}</div>
      <div className="kx-stat-value">{value}</div>
      {hint && <div className="kx-stat-hint">{hint}</div>}
    </div>
  );
}

function Dashboard({ valeurStock, suiviCodes, ruptures, stockFaible, articlesActifs6Mois, mouvementsRecents, onOpenArticle, onOpenCommande }) {
  return (
    <div>
      <header className="kx-page-header">
        <h1>Tableau de bord</h1>
        <p>Vue d'ensemble du stock du magasin, au {fmtDate(todayISO())}.</p>
      </header>

      <div className="kx-stats-grid">
        <StatCard
          label="Valeur du stock suivi"
          value={fmtFCFA(valeurStock)}
          hint={suiviCodes.length + " article(s) avec mouvements"}
          title="Somme, pour chaque article ayant déjà eu un mouvement, de (stock actuel × prix carton). Les articles jamais mouvementés ne sont pas comptés."
        />
        <StatCard label="Ruptures de stock" value={ruptures.length} hint="stock ≤ 0" tone={ruptures.length ? "warn" : ""} />
        <StatCard
          label="Stock faible"
          value={stockFaible.length}
          hint="sous la Qté voulue (ou ≤ 5 si non définie)"
          tone={stockFaible.length ? "amber" : ""}
        />
        <StatCard
          label="Articles actifs (6 mois)"
          value={articlesActifs6Mois.toLocaleString("fr-FR")}
          hint={"sur " + ARTICLES.length.toLocaleString("fr-FR") + " au catalogue"}
        />
      </div>

      <div className="kx-two-col">
        <div className="kx-panel">
          <h2>Mouvements récents</h2>
          {mouvementsRecents.length === 0 ? (
            <p className="kx-empty">Aucun mouvement enregistré pour l'instant. Rendez-vous dans l'onglet Kardex pour saisir une entrée ou une sortie.</p>
          ) : (
            <table className="kx-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Article</th>
                  <th>Type</th>
                  <th className="num">Qté</th>
                </tr>
              </thead>
              <tbody>
                {mouvementsRecents.map((m) => {
                  const art = ARTICLES_BY_CODE[m.article];
                  return (
                    <tr key={m.id} onClick={() => onOpenArticle(m.article)} className="clickable">
                      <td>{fmtDate(m.date)}</td>
                      <td>{art ? art.designation : m.article}</td>
                      <td>
                        <span className={"kx-pill " + (m.type === "entree" ? "in" : "out")}>{m.type === "entree" ? "Entrée" : "Sortie"}</span>
                      </td>
                      <td className="num">{fmtQty(m.quantite)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="kx-panel">
          <h2>Articles en rupture</h2>
          {ruptures.length === 0 ? (
            <p className="kx-empty">Aucune rupture parmi les articles suivis.</p>
          ) : (
            <>
              <ul className="kx-list">
                {ruptures.slice(0, 8).map((code) => {
                  const art = ARTICLES_BY_CODE[code];
                  if (!art) return null;
                  return (
                    <li key={code} onClick={() => onOpenArticle(code)} className="clickable">
                      <span className="kx-tab" style={{ background: catMeta(art.categorie).color }} />
                      {art.designation}
                      <span className="kx-list-meta">{art.code}</span>
                    </li>
                  );
                })}
              </ul>
              {ruptures.length > 8 && <p className="kx-list-more">+ {ruptures.length - 8} autre(s) article(s) en rupture</p>}
              <button className="kx-btn-ghost kx-commande-btn" onClick={onOpenCommande}>
                Générer la fiche de commande ({ruptures.length})
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CommandeView({ ruptures, objectifsByCode, stockByCode, onBack }) {
  const lignes = useMemo(() => {
    return ruptures
      .map((code) => ARTICLES_BY_CODE[code])
      .filter(Boolean)
      .map((art) => {
        const objectif = objectifsByCode[art.code] || 0;
        const stock = stockByCode[art.code] || 0;
        return { art, stock, objectif, aCommander: objectif > 0 ? Math.max(0, Math.round((objectif - stock) * 1000) / 1000) : null };
      })
      .sort((a, b) => a.art.designation.localeCompare(b.art.designation));
  }, [ruptures, objectifsByCode, stockByCode]);

  const sansObjectif = lignes.filter((l) => l.objectif <= 0).length;

  function telecharger() {
    const rows = lignes.map((l) => ({
      Code: l.art.code,
      Désignation: l.art.designation,
      "Qté actuelle": l.stock,
      "Qté voulue": l.objectif > 0 ? l.objectif : "",
      "Qté à commander": l.aCommander !== null ? l.aCommander : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 10 }, { wch: 45 }, { wch: 13 }, { wch: 13 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Commande");
    XLSX.writeFile(wb, `fiche-commande-${todayISO()}.xlsx`);
  }

  return (
    <div>
      <header className="kx-page-header kx-commande-header">
        <div>
          <h1>Fiche de commande</h1>
          <p>Articles en rupture — quantité à commander pour atteindre la Qté voulue, au {fmtDate(todayISO())}.</p>
        </div>
        <div className="kx-commande-actions">
          <button className="kx-btn-ghost" onClick={onBack}>
            ← Retour au tableau de bord
          </button>
          <button className="kx-btn-ghost" onClick={telecharger}>
            Télécharger (Excel)
          </button>
          <button className="kx-btn btn-in" onClick={() => window.print()}>
            Imprimer
          </button>
        </div>
      </header>

      {sansObjectif > 0 && (
        <p className="kx-warning-inline">
          {sansObjectif} article(s) n'ont pas de Qté voulue définie dans le Catalogue — la quantité à commander ne peut pas être calculée pour eux.
        </p>
      )}

      <table className="kx-table kx-table-cat">
        <thead>
          <tr>
            <th>Code</th>
            <th>Désignation</th>
            <th className="num">Qté actuelle</th>
            <th className="num">Qté voulue</th>
            <th className="num">Qté à commander</th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.art.code}>
              <td className="mono">{l.art.code}</td>
              <td>{l.art.designation}</td>
              <td className="num">{fmtQty(l.stock)}</td>
              <td className="num">{l.objectif > 0 ? fmtQty(l.objectif) : "—"}</td>
              <td className="num strong">{l.aCommander !== null ? fmtQty(l.aCommander) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArticleAutocomplete({ onSelect }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return ARTICLES.filter((a) => a.designation.toLowerCase().includes(q) || String(a.code).includes(q)).slice(0, 8);
  }, [query]);

  useEffect(() => {
    function onClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="kx-autocomplete" ref={wrapRef}>
      <input
        type="text"
        placeholder="Rechercher un article par nom ou code…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="kx-autocomplete-list">
          {results.map((a) => (
            <div
              key={a.code}
              className="kx-autocomplete-item"
              onClick={() => {
                onSelect(a.code);
                setQuery("");
                setOpen(false);
              }}
            >
              <span className="kx-tab" style={{ background: catMeta(a.categorie).color }} />
              <div>
                <div className="ac-name">{a.designation}</div>
                <div className="ac-meta">
                  {a.code} · {catMeta(a.categorie).label} · {a.fournisseur}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KardexView({ mouvements, stockByCode, selectedCode, setSelectedCode, addMouvement }) {
  const art = selectedCode ? ARTICLES_BY_CODE[selectedCode] : null;
  const [type, setType] = useState("entree");
  const [uniteSaisie, setUniteSaisie] = useState("carton"); // "carton" | "unite"
  const [quantite, setQuantite] = useState("");
  const [date, setDate] = useState(todayISO());
  const [motif, setMotif] = useState(MOTIFS_ENTREE[0]);
  const [reference, setReference] = useState("");

  useEffect(() => {
    setMotif(type === "entree" ? MOTIFS_ENTREE[0] : MOTIFS_SORTIE[0]);
  }, [type]);

  useEffect(() => {
    setUniteSaisie("carton");
    setQuantite("");
  }, [selectedCode]);

  const [pending, setPending] = useState(null);

  useEffect(() => {
    setPending(null);
  }, [selectedCode]);

  const historique = useMemo(() => {
    if (!art) return [];
    const cutoff = monthsAgoISO(6);
    return mouvements
      .filter((m) => m.article === art.code && m.date >= cutoff)
      .sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : String(a.createdAt).localeCompare(String(b.createdAt))));
  }, [mouvements, art]);

  let running = 0;
  const historiqueAvecSolde = historique.map((m) => {
    running += m.type === "entree" ? m.quantite : -m.quantite;
    return { ...m, solde: running };
  });
  // Le plus récent en premier (date, puis heure de saisie pour les mouvements du même jour)
  const historiqueRecentDabord = [...historiqueAvecSolde].sort((a, b) => compareMvtDesc(a, b));

  const colisage = art ? art.colisage : 1;
  const peutSaisirEnUnite = colisage > 1;
  const quantiteSaisie = parseFloat(quantite);
  const quantiteEnCartons =
    !isNaN(quantiteSaisie) && quantiteSaisie > 0
      ? uniteSaisie === "unite"
        ? unitesEnCartons(quantiteSaisie, colisage)
        : Math.round(quantiteSaisie * 1000) / 1000
      : null;

  function doSubmit(payload) {
    addMouvement(payload);
    setQuantite("");
    setReference("");
    setPending(null);
  }

  function submit(e) {
    e.preventDefault();
    if (!art || quantiteEnCartons === null || !date) return;
    const payload = { article: art.code, type, quantite: quantiteEnCartons, date, motif, reference: reference.trim() };
    const dispo = stockByCode[art.code] || 0;
    if (type === "sortie" && quantiteEnCartons > dispo) {
      setPending(payload);
      return;
    }
    doSubmit(payload);
  }

  return (
    <div>
      <header className="kx-page-header">
        <h1>Kardex</h1>
        <p>Sélectionnez un article pour consulter sa fiche et enregistrer un mouvement.</p>
      </header>

      <ArticleAutocomplete onSelect={setSelectedCode} />

      {!art ? (
        <p className="kx-empty" style={{ marginTop: 24 }}>
          Aucun article sélectionné. Utilisez la recherche ci-dessus, ou ouvrez un article depuis le Catalogue.
        </p>
      ) : (
        <div className="kx-card" style={{ marginTop: 24 }}>
          <div className="kx-card-top" style={{ borderColor: catMeta(art.categorie).color }}>
            <div className="kx-punch" />
            <div className="kx-punch" />
            <div className="kx-card-title">
              <div className="kx-card-cat" style={{ color: catMeta(art.categorie).color }}>
                {catMeta(art.categorie).label} · Fiche N° {art.code}
              </div>
              <h2>{art.designation}</h2>
            </div>
            <div className="kx-card-stock">
              <div className="kx-card-stock-value">{fmtQty(stockByCode[art.code] || 0)}</div>
              <div className="kx-card-stock-label">carton(s) en stock</div>
            </div>
          </div>

          <div className="kx-card-meta">
            <div>
              <span>Fournisseur</span>
              <strong>{art.fournisseur}</strong>
            </div>
            <div>
              <span>Conditionnement</span>
              <strong>
                {art.contenance} · colis de {art.colisage}
              </strong>
            </div>
            <div>
              <span>Prix détail</span>
              <strong>{fmtFCFA(art.prixDetail)}</strong>
            </div>
            <div>
              <span>Prix carton</span>
              <strong>{fmtFCFA(art.prixCarton)}</strong>
            </div>
          </div>

          <form className="kx-form" onSubmit={submit}>
            <div className="kx-form-row">
              <label>
                Mouvement
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="entree">Entrée</option>
                  <option value="sortie">Sortie</option>
                </select>
              </label>
              {peutSaisirEnUnite && (
                <label>
                  Saisie en
                  <select value={uniteSaisie} onChange={(e) => setUniteSaisie(e.target.value)}>
                    <option value="carton">Cartons</option>
                    <option value="unite">Unités</option>
                  </select>
                </label>
              )}
              <label>
                Quantité {uniteSaisie === "unite" ? "(unités)" : "(cartons)"}
                <input
                  type="number"
                  min={uniteSaisie === "unite" ? "1" : "0.001"}
                  step={uniteSaisie === "unite" ? "1" : "0.001"}
                  value={quantite}
                  onChange={(e) => setQuantite(e.target.value)}
                  required
                />
              </label>
              <label>
                Date
                <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} required />
              </label>
            </div>
            {uniteSaisie === "unite" && quantiteEnCartons !== null && (
              <p className="kx-conversion-hint">
                {quantite} unité(s) sur un colis de {colisage} = <strong>{fmtQty(quantiteEnCartons)} carton(s)</strong> — c'est cette valeur qui sera
                enregistrée.
              </p>
            )}
            <div className="kx-form-row">
              <label>
                Motif
                <select value={motif} onChange={(e) => setMotif(e.target.value)}>
                  {(type === "entree" ? MOTIFS_ENTREE : MOTIFS_SORTIE).map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label>
                Référence (n° BL, facture…)
                <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optionnel" />
              </label>
              <button type="submit" className={"kx-btn " + (type === "entree" ? "btn-in" : "btn-out")}>
                Enregistrer {type === "entree" ? "l'entrée" : "la sortie"}
              </button>
            </div>
            {pending && (
              <div className="kx-warning">
                <p>
                  La quantité saisie ({fmtQty(pending.quantite)} carton(s)) est supérieure au stock disponible ({fmtQty(stockByCode[art.code] || 0)} carton(s)).
                  Voulez-vous poursuivre quand même ?
                </p>
                <div className="kx-warning-actions">
                  <button type="button" className="kx-btn btn-out" onClick={() => doSubmit(pending)}>
                    Poursuivre quand même
                  </button>
                  <button type="button" className="kx-btn-ghost" onClick={() => setPending(null)}>
                    Annuler
                  </button>
                </div>
              </div>
            )}
          </form>

          <div className="kx-hist">
            <h3>Historique — 6 derniers mois</h3>
            {historiqueAvecSolde.length === 0 ? (
              <p className="kx-empty">Aucun mouvement enregistré pour cet article sur la période.</p>
            ) : (
              <table className="kx-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Motif</th>
                    <th>Référence</th>
                    <th className="num">Qté</th>
                    <th className="num">Solde</th>
                  </tr>
                </thead>
                <tbody>
                  {historiqueRecentDabord.map((m) => (
                    <tr key={m.id}>
                      <td>{fmtDate(m.date)}</td>
                      <td>
                        <span className={"kx-pill " + (m.type === "entree" ? "in" : "out")}>{m.type === "entree" ? "Entrée" : "Sortie"}</span>
                      </td>
                      <td>{m.motif}</td>
                      <td>{m.reference || "—"}</td>
                      <td className="num">
                        {m.type === "entree" ? "+" : "−"}
                        {fmtQty(m.quantite)}
                      </td>
                      <td className="num strong">{fmtQty(m.solde)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QteVoulueCell({ code, value, setObjectif }) {
  const [local, setLocal] = useState(value ?? "");

  useEffect(() => {
    setLocal(value ?? "");
  }, [value]);

  function commit() {
    const n = parseFloat(local);
    const safe = isNaN(n) || n < 0 ? 0 : Math.round(n * 1000) / 1000;
    if (safe !== (value || 0)) setObjectif(code, safe);
    setLocal(safe);
  }

  return (
    <input
      type="number"
      min="0"
      step="0.001"
      className="kx-qte-input"
      value={local}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function CatalogueView({ stockByCode, objectifsByCode, setObjectif, onOpenArticle }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [page, setPage] = useState(0);
  const perPage = 40;

  const [showFilters, setShowFilters] = useState(false);
  const [fournisseur, setFournisseur] = useState("");
  const [prixMin, setPrixMin] = useState("");
  const [prixMax, setPrixMax] = useState("");
  const [stockFiltre, setStockFiltre] = useState("");
  const [qvFiltre, setQvFiltre] = useState("");

  const qvValeurs = useMemo(() => {
    return [...new Set(Object.values(objectifsByCode).filter((v) => v > 0))].sort((a, b) => a - b);
  }, [objectifsByCode]);

  function estFaible(code) {
    const stock = stockByCode[code] || 0;
    if (stock <= 0) return false;
    const objectif = objectifsByCode[code] || 0;
    return objectif > 0 ? stock < objectif : stock <= 5;
  }

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const min = prixMin !== "" ? parseFloat(prixMin) : null;
    const max = prixMax !== "" ? parseFloat(prixMax) : null;
    return ARTICLES.filter((a) => {
      if (cat && a.categorie !== cat) return false;
      if (query && !a.designation.toLowerCase().includes(query) && !String(a.code).includes(query)) return false;
      if (fournisseur && a.fournisseur !== fournisseur) return false;
      if (min !== null && a.prixCarton < min) return false;
      if (max !== null && a.prixCarton > max) return false;
      const stock = stockByCode[a.code] || 0;
      if (stockFiltre === "rupture" && stock > 0) return false;
      if (stockFiltre === "faible" && !estFaible(a.code)) return false;
      if (stockFiltre === "enstock" && (stock <= 0 || estFaible(a.code))) return false;
      const objectif = objectifsByCode[a.code] || 0;
      if (qvFiltre === "0" && objectif > 0) return false;
      if (qvFiltre !== "" && qvFiltre !== "0" && objectif !== parseFloat(qvFiltre)) return false;
      return true;
    });
  }, [q, cat, fournisseur, prixMin, prixMax, stockFiltre, qvFiltre, stockByCode, objectifsByCode]);

  useEffect(() => setPage(0), [q, cat, fournisseur, prixMin, prixMax, stockFiltre, qvFiltre]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice(page * perPage, page * perPage + perPage);

  const filtresActifs = [fournisseur, prixMin, prixMax, stockFiltre, qvFiltre].filter(Boolean).length;

  function resetFiltresAvances() {
    setFournisseur("");
    setPrixMin("");
    setPrixMax("");
    setStockFiltre("");
    setQvFiltre("");
  }

  return (
    <div>
      <header className="kx-page-header">
        <h1>Catalogue</h1>
        <p>{ARTICLES.length.toLocaleString("fr-FR")} articles importés de la base existante.</p>
      </header>

      <div className="kx-filters">
        <input type="text" placeholder="Rechercher par nom ou code…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Toutes catégories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {catMeta(c).label}
            </option>
          ))}
        </select>
        <button className={"kx-btn-ghost" + (filtresActifs ? " active" : "")} onClick={() => setShowFilters((s) => !s)} type="button">
          Filtres{filtresActifs ? ` (${filtresActifs})` : ""}
        </button>
        <span className="kx-filters-count">{filtered.length.toLocaleString("fr-FR")} résultat(s)</span>
      </div>

      {showFilters && (
        <div className="kx-filters-advanced">
          <label>
            Fournisseur
            <select value={fournisseur} onChange={(e) => setFournisseur(e.target.value)}>
              <option value="">Tous</option>
              {FOURNISSEURS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prix carton min
            <input type="number" min="0" value={prixMin} onChange={(e) => setPrixMin(e.target.value)} placeholder="0" />
          </label>
          <label>
            Prix carton max
            <input type="number" min="0" value={prixMax} onChange={(e) => setPrixMax(e.target.value)} placeholder="—" />
          </label>
          <label>
            Stock
            <select value={stockFiltre} onChange={(e) => setStockFiltre(e.target.value)}>
              <option value="">Tous</option>
              <option value="rupture">En rupture</option>
              <option value="faible">Stock faible</option>
              <option value="enstock">En stock</option>
            </select>
          </label>
          <label>
            Qté voulue
            <select value={qvFiltre} onChange={(e) => setQvFiltre(e.target.value)}>
              <option value="">Toutes</option>
              <option value="0">Non définie</option>
              {qvValeurs.map((v) => (
                <option key={v} value={v}>
                  {fmtQty(v)}
                </option>
              ))}
            </select>
          </label>
          <button className="kx-btn-ghost" type="button" onClick={resetFiltresAvances}>
            Réinitialiser
          </button>
        </div>
      )}

      <table className="kx-table kx-table-cat">
        <thead>
          <tr>
            <th>Code</th>
            <th>Désignation</th>
            <th>Catégorie</th>
            <th>Fournisseur</th>
            <th className="num">Prix carton</th>
            <th className="num">Stock</th>
            <th className="num">Qté voulue</th>
          </tr>
        </thead>
        <tbody>
          {pageItems.map((a) => (
            <tr key={a.code} className="clickable" onClick={() => onOpenArticle(a.code)}>
              <td className="mono">{a.code}</td>
              <td>{a.designation}</td>
              <td>
                <span className="kx-tab" style={{ background: catMeta(a.categorie).color }} />
                {catMeta(a.categorie).label}
              </td>
              <td>{a.fournisseur}</td>
              <td className="num">{fmtFCFA(a.prixCarton)}</td>
              <td className="num">{fmtQty(stockByCode[a.code] || 0)}</td>
              <td className="num">
                <QteVoulueCell code={a.code} value={objectifsByCode[a.code]} setObjectif={setObjectif} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="kx-pagination">
        <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          ← Précédent
        </button>
        <span>
          Page {page + 1} / {pageCount}
        </span>
        <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>
          Suivant →
        </button>
      </div>
    </div>
  );
}

export function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Spectral:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

      .kx-root { display:flex; min-height:640px; background:#EDE9DD; font-family:'Inter',sans-serif; color:#242018; border-radius:8px; overflow:hidden; }
      .kx-root * { box-sizing:border-box; }

      .kx-sidebar { width:220px; flex-shrink:0; background:#1B2430; color:#E9E6DC; display:flex; flex-direction:column; padding:22px 16px; }
      .kx-brand { display:flex; align-items:center; gap:10px; margin-bottom:28px; padding:0 4px; }
      .kx-brand-mark { width:34px; height:34px; border-radius:6px; background:#2F6F62; display:flex; align-items:center; justify-content:center; font-family:'Spectral',serif; font-weight:700; font-size:17px; }
      .kx-brand-title { font-family:'Spectral',serif; font-weight:700; font-size:15px; letter-spacing:1px; }
      .kx-brand-sub { font-size:11px; color:#9098A6; margin-top:2px; }
      .kx-nav { display:flex; flex-direction:column; gap:4px; flex:1; }
      .kx-nav-item { display:flex; align-items:center; gap:10px; background:transparent; border:none; color:#C7CBD3; padding:10px 12px; border-radius:6px; font-size:13.5px; text-align:left; cursor:pointer; font-family:inherit; }
      .kx-nav-item:hover { background:#26313F; }
      .kx-nav-item.active { background:#2F6F62; color:#fff; }
      .kx-nav-icon { width:16px; text-align:center; opacity:0.85; }
      .kx-sidebar-footer { display:flex; align-items:center; gap:8px; font-size:11px; color:#8A93A2; border-top:1px solid #2A3543; padding-top:14px; }
      .kx-save-dot { width:7px; height:7px; border-radius:50%; background:#5B6472; }
      .kx-save-dot.saving { background:#B8862B; }
      .kx-save-dot.saved { background:#3B7D6E; }
      .kx-save-dot.error { background:#A6432A; }

      .kx-main { flex:1; padding:28px 34px; overflow:auto; max-height:820px; }
      .kx-page-header h1 { font-family:'Spectral',serif; font-size:23px; margin:0 0 4px; }
      .kx-page-header p { margin:0 0 22px; font-size:13px; color:#7A7264; }

      .kx-stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:24px; }
      .kx-stat { background:#F7F5EE; border:1px solid #DCD6C4; border-radius:8px; padding:14px 16px; }
      .kx-stat.tone-warn { border-color:#D79C8A; background:#FBEFEA; }
      .kx-stat.tone-amber { border-color:#E0C48C; background:#FBF3E1; }
      .kx-stat-label { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#8A8272; margin-bottom:6px; }
      .kx-stat-value { font-family:'IBM Plex Mono',monospace; font-size:24px; font-weight:600; }
      .kx-stat-hint { font-size:11px; color:#9A927F; margin-top:4px; }

      .kx-two-col { display:grid; grid-template-columns:1.4fr 1fr; gap:18px; }
      .kx-panel { background:#F7F5EE; border:1px solid #DCD6C4; border-radius:8px; padding:18px 20px; }
      .kx-panel h2 { font-family:'Spectral',serif; font-size:15px; margin:0 0 12px; }
      .kx-empty { font-size:12.5px; color:#9A927F; line-height:1.6; }

      .kx-table { width:100%; border-collapse:collapse; font-size:12.5px; }
      .kx-table th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:0.4px; color:#9A927F; padding:6px 8px; border-bottom:1px solid #DCD6C4; }
      .kx-table td { padding:8px; border-bottom:1px solid #E7E2D4; }
      .kx-table td.num, .kx-table th.num { text-align:right; font-family:'IBM Plex Mono',monospace; }
      .kx-table td.mono { font-family:'IBM Plex Mono',monospace; }
      .kx-table td.strong { font-weight:600; }
      .kx-table tr.clickable { cursor:pointer; }
      .kx-table tr.clickable:hover td { background:#EFEADA; }

      .kx-pill { font-size:10.5px; padding:2px 8px; border-radius:10px; font-weight:600; }
      .kx-pill.in { background:#E1EEE9; color:#2F6F62; }
      .kx-pill.out { background:#F3E1DC; color:#A6432A; }

      .kx-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
      .kx-list li { display:flex; align-items:center; gap:8px; padding:9px 6px; font-size:12.5px; border-bottom:1px solid #E7E2D4; }
      .kx-list li.clickable { cursor:pointer; }
      .kx-list li.clickable:hover { background:#EFEADA; }
      .kx-list-meta { margin-left:auto; font-family:'IBM Plex Mono',monospace; color:#9A927F; font-size:11px; }

      .kx-tab { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:7px; flex-shrink:0; }

      .kx-autocomplete { position:relative; max-width:440px; }
      .kx-autocomplete input { width:100%; padding:10px 12px; border:1px solid #CFC8B2; border-radius:6px; font-size:13px; font-family:inherit; background:#F7F5EE; }
      .kx-autocomplete-list { position:absolute; top:calc(100% + 4px); left:0; right:0; background:#fff; border:1px solid #DCD6C4; border-radius:6px; box-shadow:0 8px 20px rgba(27,36,48,0.12); z-index:10; max-height:320px; overflow:auto; }
      .kx-autocomplete-item { display:flex; align-items:center; padding:9px 12px; cursor:pointer; font-size:12.5px; border-bottom:1px solid #F0EDE2; }
      .kx-autocomplete-item:hover { background:#F3F0E4; }
      .ac-name { font-weight:500; }
      .ac-meta { font-size:11px; color:#9A927F; margin-top:2px; }

      .kx-card { background:#FBFAF5; border:1px solid #DCD6C4; border-radius:10px; overflow:hidden; }
      .kx-card-top { position:relative; display:flex; align-items:center; justify-content:space-between; padding:20px 24px; border-bottom:3px solid; background:#F3F0E4; }
      .kx-punch { position:absolute; top:10px; width:9px; height:9px; border-radius:50%; background:#EDE9DD; box-shadow:inset 0 1px 3px rgba(0,0,0,0.25); }
      .kx-punch:nth-child(1) { left:24px; }
      .kx-punch:nth-child(2) { left:44px; }
      .kx-card-cat { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600; margin-bottom:4px; }
      .kx-card-title h2 { font-family:'Spectral',serif; font-size:19px; margin:0; }
      .kx-card-stock { text-align:right; }
      .kx-card-stock-value { font-family:'IBM Plex Mono',monospace; font-size:28px; font-weight:600; }
      .kx-card-stock-label { font-size:10.5px; color:#9A927F; }

      .kx-card-meta { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; padding:18px 24px; border-bottom:1px solid #E7E2D4; }
      .kx-card-meta span { display:block; font-size:10.5px; text-transform:uppercase; color:#9A927F; margin-bottom:3px; }
      .kx-card-meta strong { font-size:13px; font-weight:600; }

      .kx-form { padding:18px 24px; border-bottom:1px solid #E7E2D4; }
      .kx-form-row { display:flex; gap:14px; margin-bottom:12px; align-items:end; }
      .kx-form-row:last-child { margin-bottom:0; }
      .kx-form label { display:flex; flex-direction:column; font-size:11px; color:#7A7264; gap:5px; flex:1; }
      .kx-form input, .kx-form select { padding:8px 10px; border:1px solid #CFC8B2; border-radius:6px; font-size:13px; font-family:inherit; background:#fff; }
      .kx-btn { border:none; border-radius:6px; padding:10px 18px; font-size:13px; font-weight:600; color:#fff; cursor:pointer; align-self:end; white-space:nowrap; }
      .btn-in { background:#2F6F62; }
      .btn-out { background:#A6432A; }

      .kx-hist { padding:18px 24px; }
      .kx-hist h3 { font-family:'Spectral',serif; font-size:14px; margin:0 0 12px; }

      .kx-filters { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
      .kx-filters input { flex:1; max-width:340px; padding:9px 12px; border:1px solid #CFC8B2; border-radius:6px; font-size:13px; font-family:inherit; background:#F7F5EE; }
      .kx-filters select { padding:9px 12px; border:1px solid #CFC8B2; border-radius:6px; font-size:13px; font-family:inherit; background:#F7F5EE; }
      .kx-filters-count { font-size:12px; color:#9A927F; margin-left:auto; }

      .kx-table-cat { background:#F7F5EE; border:1px solid #DCD6C4; border-radius:8px; overflow:hidden; }
      .kx-table-cat th { background:#F0ECDD; }
      .kx-table-cat td, .kx-table-cat th { padding:9px 12px; }

      .kx-pagination { display:flex; align-items:center; justify-content:center; gap:16px; margin-top:16px; font-size:12.5px; }
      .kx-pagination button { border:1px solid #CFC8B2; background:#F7F5EE; padding:7px 14px; border-radius:6px; cursor:pointer; font-family:inherit; font-size:12.5px; }
      .kx-pagination button:disabled { opacity:0.4; cursor:default; }
      .kx-conversion-hint { font-size:11.5px; color:#2F6F62; background:#E1EEE9; border-radius:6px; padding:8px 12px; margin:-4px 0 12px; }
      .kx-warning { margin-top:14px; background:#FBF3E1; border:1px solid #E0C48C; border-radius:6px; padding:12px 14px; }
      .kx-warning p { margin:0 0 10px; font-size:12.5px; color:#7A5A18; line-height:1.5; }
      .kx-warning-actions { display:flex; gap:10px; }
      .kx-btn-ghost { border:1px solid #CFC8B2; background:#fff; color:#5B5342; padding:9px 16px; border-radius:6px; font-size:12.5px; font-weight:600; cursor:pointer; font-family:inherit; }
      .kx-qte-input { width:70px; padding:6px 8px; border:1px solid #CFC8B2; border-radius:5px; font-family:'IBM Plex Mono',monospace; font-size:12.5px; text-align:right; background:#fff; }
      .kx-brand-photo { width:34px; height:34px; border-radius:6px; object-fit:cover; flex-shrink:0; }
      .kx-logout { margin-top:12px; background:transparent; border:1px solid #2A3543; color:#9098A6; padding:8px 12px; border-radius:6px; font-size:11.5px; cursor:pointer; font-family:inherit; }
      .kx-logout:hover { background:#26313F; color:#E9E6DC; }

      .kx-auth-wrap { min-height:640px; display:flex; align-items:center; justify-content:center; background:#EDE9DD; border-radius:8px; font-family:'Inter',sans-serif; color:#242018; }
      .kx-auth-card { width:380px; background:#FBFAF5; border:1px solid #DCD6C4; border-radius:10px; padding:30px 32px; }
      .kx-auth-card h1 { font-family:'Spectral',serif; font-size:20px; margin:0 0 4px; }
      .kx-auth-card p.kx-auth-sub { font-size:12.5px; color:#9A927F; margin:0 0 22px; }
      .kx-auth-field { display:flex; flex-direction:column; gap:5px; margin-bottom:14px; font-size:11px; color:#7A7264; }
      .kx-auth-field input { padding:10px 12px; border:1px solid #CFC8B2; border-radius:6px; font-size:13px; font-family:inherit; background:#fff; }
      .kx-auth-btn { width:100%; border:none; border-radius:6px; padding:11px; font-size:13px; font-weight:600; color:#fff; background:#2F6F62; cursor:pointer; margin-top:6px; }
      .kx-auth-btn:disabled { opacity:0.6; cursor:default; }
      .kx-auth-switch { text-align:center; font-size:12px; color:#7A7264; margin-top:16px; }
      .kx-auth-switch button { background:none; border:none; color:#2F6F62; font-weight:600; cursor:pointer; font-family:inherit; font-size:12px; padding:0; }
      .kx-auth-error { background:#FBEFEA; border:1px solid #D79C8A; color:#8A3420; padding:9px 12px; border-radius:6px; font-size:12px; margin-bottom:14px; }
      .kx-auth-photo-row { display:flex; align-items:center; gap:14px; margin-bottom:18px; }
      .kx-auth-photo-preview { width:56px; height:56px; border-radius:50%; object-fit:cover; background:#EDE9DD; border:1px solid #DCD6C4; flex-shrink:0; }
      .kx-auth-photo-placeholder { width:56px; height:56px; border-radius:50%; background:#EDE9DD; border:1px solid #DCD6C4; flex-shrink:0; display:flex; align-items:center; justify-content:center; color:#9A927F; font-size:11px; }
      .kx-list-more { font-size:11px; color:#9A927F; margin:6px 0 0; }
      .kx-commande-btn { width:100%; margin-top:14px; }
      .kx-commande-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
      .kx-commande-actions { display:flex; gap:10px; flex-shrink:0; }
      .kx-warning-inline { background:#FBF3E1; border:1px solid #E0C48C; color:#7A5A18; padding:10px 14px; border-radius:6px; font-size:12.5px; margin-bottom:16px; }
      .kx-filters button.kx-btn-ghost.active { background:#2F6F62; color:#fff; border-color:#2F6F62; }
      .kx-filters-advanced { display:flex; flex-wrap:wrap; align-items:end; gap:14px; background:#F7F5EE; border:1px solid #DCD6C4; border-radius:8px; padding:14px 16px; margin-bottom:16px; }
      .kx-filters-advanced label { display:flex; flex-direction:column; gap:5px; font-size:11px; color:#7A7264; }
      .kx-filters-advanced select, .kx-filters-advanced input { padding:8px 10px; border:1px solid #CFC8B2; border-radius:6px; font-size:12.5px; font-family:inherit; background:#fff; min-width:120px; }
      .kx-filters-advanced input[type=number] { min-width:90px; }
      @media print {
        .kx-sidebar, .kx-commande-actions { display:none !important; }
        .kx-main { max-height:none !important; overflow:visible !important; }
        .kx-root { display:block !important; }
      }
      .kx-alert { background:#FBEFEA; border:1px solid #D79C8A; color:#8A3420; padding:10px 14px; border-radius:6px; font-size:12.5px; margin-bottom:16px; }
    `}</style>
  );
}
