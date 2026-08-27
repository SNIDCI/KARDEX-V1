import { useState, useEffect, useMemo, useRef } from "react";
import { CATALOGUE_RAW } from "./data/catalogue.js";
import { supabase } from "./supabaseClient.js";

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

function fmtFCFA(n) {
  return (
    Math.round(n || 0)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " F"
  );
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

const MOTIFS_ENTREE = ["Réception fournisseur", "Retour client", "Correction inventaire", "Transfert entrant", "Autre"];
const MOTIFS_SORTIE = ["Vente", "Casse / Perte", "Correction inventaire", "Transfert sortant", "Autre"];

function rowToMouvement(row) {
  return {
    id: row.id,
    article: row.article_code,
    type: row.type,
    quantite: row.quantite,
    date: row.date,
    motif: row.motif,
    reference: row.reference,
  };
}

export default function KardexApp() {
  const [mouvements, setMouvements] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("dashboard");
  const [selectedCode, setSelectedCode] = useState(null);
  const [saveState, setSaveState] = useState("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function fetchMouvements() {
    const { data, error } = await supabase
      .from("kardex_mouvements")
      .select("*")
      .order("date", { ascending: true });
    if (error) {
      setErrorMsg("Impossible de charger les mouvements : " + error.message);
      return;
    }
    setErrorMsg("");
    setMouvements(data.map(rowToMouvement));
  }

  useEffect(() => {
    (async () => {
      await fetchMouvements();
      setLoaded(true);
    })();

    // Synchronisation en temps réel entre appareils/postes
    const channel = supabase
      .channel("kardex_mouvements_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "kardex_mouvements" }, () => {
        fetchMouvements();
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
      return sum + Math.max(0, stockByCode[code] || 0) * art.prixDetail;
    }, 0);
  }, [suiviCodes, stockByCode]);

  const ruptures = suiviCodes.filter((c) => (stockByCode[c] || 0) <= 0);
  const stockFaible = suiviCodes.filter((c) => (stockByCode[c] || 0) > 0 && (stockByCode[c] || 0) <= 5);

  const mouvementsRecents = useMemo(
    () => [...mouvements].sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 8),
    [mouvements]
  );
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
      <Sidebar view={view} setView={setView} saveState={saveState} />
      <main className="kx-main">
        {errorMsg && <div className="kx-alert">{errorMsg}</div>}
        {view === "dashboard" && (
          <Dashboard
            valeurStock={valeurStock}
            suiviCodes={suiviCodes}
            ruptures={ruptures}
            stockFaible={stockFaible}
            mouvementsRecents={mouvementsRecents}
            onOpenArticle={(code) => {
              setSelectedCode(code);
              setView("kardex");
            }}
          />
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

function Sidebar({ view, setView, saveState }) {
  const items = [
    { id: "dashboard", label: "Tableau de bord", icon: "◧" },
    { id: "kardex", label: "Kardex", icon: "▤" },
    { id: "catalogue", label: "Catalogue", icon: "▦" },
  ];
  return (
    <aside className="kx-sidebar">
      <div className="kx-brand">
        <div className="kx-brand-mark">K</div>
        <div>
          <div className="kx-brand-title">KARDEX</div>
          <div className="kx-brand-sub">Magasin Pilote — V1</div>
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
    </aside>
  );
}

function StatCard({ label, value, hint, tone }) {
  return (
    <div className={"kx-stat" + (tone ? " tone-" + tone : "")}>
      <div className="kx-stat-label">{label}</div>
      <div className="kx-stat-value">{value}</div>
      {hint && <div className="kx-stat-hint">{hint}</div>}
    </div>
  );
}

function Dashboard({ valeurStock, suiviCodes, ruptures, stockFaible, mouvementsRecents, onOpenArticle }) {
  return (
    <div>
      <header className="kx-page-header">
        <h1>Tableau de bord</h1>
        <p>Vue d'ensemble du stock du magasin, au {fmtDate(todayISO())}.</p>
      </header>

      <div className="kx-stats-grid">
        <StatCard label="Valeur du stock suivi" value={fmtFCFA(valeurStock)} hint={suiviCodes.length + " article(s) avec mouvements"} />
        <StatCard label="Ruptures de stock" value={ruptures.length} hint="stock ≤ 0" tone={ruptures.length ? "warn" : ""} />
        <StatCard label="Stock faible" value={stockFaible.length} hint="entre 1 et 5 unités" tone={stockFaible.length ? "amber" : ""} />
        <StatCard label="Catalogue total" value={ARTICLES.length.toLocaleString("fr-FR")} hint={CATEGORIES.length + " catégories"} />
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
                      <td className="num">{m.quantite}</td>
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
          )}
        </div>
      </div>
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
  const [quantite, setQuantite] = useState("");
  const [date, setDate] = useState(todayISO());
  const [motif, setMotif] = useState(MOTIFS_ENTREE[0]);
  const [reference, setReference] = useState("");

  useEffect(() => {
    setMotif(type === "entree" ? MOTIFS_ENTREE[0] : MOTIFS_SORTIE[0]);
  }, [type]);

  const historique = useMemo(() => {
    if (!art) return [];
    const cutoff = monthsAgoISO(6);
    return mouvements
      .filter((m) => m.article === art.code && m.date >= cutoff)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }, [mouvements, art]);

  let running = 0;
  const historiqueAvecSolde = historique.map((m) => {
    running += m.type === "entree" ? m.quantite : -m.quantite;
    return { ...m, solde: running };
  });

  function submit(e) {
    e.preventDefault();
    const q = parseInt(quantite, 10);
    if (!art || !q || q <= 0 || !date) return;
    addMouvement({ article: art.code, type, quantite: q, date, motif, reference: reference.trim() });
    setQuantite("");
    setReference("");
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
              <div className="kx-card-stock-value">{stockByCode[art.code] || 0}</div>
              <div className="kx-card-stock-label">unité(s) en stock</div>
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
              <label>
                Quantité
                <input type="number" min="1" value={quantite} onChange={(e) => setQuantite(e.target.value)} required />
              </label>
              <label>
                Date
                <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} required />
              </label>
            </div>
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
                  {[...historiqueAvecSolde].reverse().map((m) => (
                    <tr key={m.id}>
                      <td>{fmtDate(m.date)}</td>
                      <td>
                        <span className={"kx-pill " + (m.type === "entree" ? "in" : "out")}>{m.type === "entree" ? "Entrée" : "Sortie"}</span>
                      </td>
                      <td>{m.motif}</td>
                      <td>{m.reference || "—"}</td>
                      <td className="num">
                        {m.type === "entree" ? "+" : "−"}
                        {m.quantite}
                      </td>
                      <td className="num strong">{m.solde}</td>
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

function CatalogueView({ stockByCode, onOpenArticle }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [page, setPage] = useState(0);
  const perPage = 40;

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return ARTICLES.filter((a) => {
      if (cat && a.categorie !== cat) return false;
      if (query && !a.designation.toLowerCase().includes(query) && !String(a.code).includes(query)) return false;
      return true;
    });
  }, [q, cat]);

  useEffect(() => setPage(0), [q, cat]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice(page * perPage, page * perPage + perPage);

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
        <span className="kx-filters-count">{filtered.length.toLocaleString("fr-FR")} résultat(s)</span>
      </div>

      <table className="kx-table kx-table-cat">
        <thead>
          <tr>
            <th>Code</th>
            <th>Désignation</th>
            <th>Catégorie</th>
            <th>Fournisseur</th>
            <th className="num">Prix détail</th>
            <th className="num">Stock</th>
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
              <td className="num">{fmtFCFA(a.prixDetail)}</td>
              <td className="num">{stockByCode[a.code] || 0}</td>
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

function Style() {
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
      .kx-alert { background:#FBEFEA; border:1px solid #D79C8A; color:#8A3420; padding:10px 14px; border-radius:6px; font-size:12.5px; margin-bottom:16px; }
    `}</style>
  );
}
