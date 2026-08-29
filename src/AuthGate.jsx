import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient.js";
import { Style } from "./KardexApp.jsx";
import KardexApp from "./KardexApp.jsx";

export default function AuthGate() {
  const [session, setSession] = useState(undefined); // undefined = pas encore vérifié
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setProfileLoaded(false);
      setProfile(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfileLoaded(true);
      return;
    }
    (async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
      setProfile(data);
      setProfileLoaded(true);
    })();
  }, [session]);

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  if (session === undefined || !profileLoaded) {
    return (
      <div className="kx-auth-wrap">
        <Style />
        Chargement…
      </div>
    );
  }

  if (!session) return <Login />;

  if (!profile || !profile.magasin_nom) {
    return <Onboarding userId={session.user.id} existing={profile} onDone={(p) => setProfile(p)} />;
  }

  return <KardexApp profile={profile} onLogout={handleLogout} />;
}

function Login() {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email, password: code });
      if (error) setError(traduireErreur(error.message));
    } else {
      const { error } = await supabase.auth.signUp({ email, password: code });
      if (error) setError(traduireErreur(error.message));
      else setInfo("Compte créé. Si la confirmation par e-mail est activée, vérifie ta boîte mail avant de te connecter.");
    }
    setBusy(false);
  }

  return (
    <div className="kx-auth-wrap">
      <Style />
      <div className="kx-auth-card">
        <h1>Kardex</h1>
        <p className="kx-auth-sub">{mode === "login" ? "Connecte-toi à ton magasin." : "Crée le compte de ton magasin."}</p>
        {error && <div className="kx-auth-error">{error}</div>}
        {info && <div className="kx-auth-error" style={{ background: "#E1EEE9", borderColor: "#3B7D6E", color: "#2F6F62" }}>{info}</div>}
        <form onSubmit={submit}>
          <div className="kx-auth-field">
            <label>Adresse e-mail</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="kx-auth-field">
            <label>Code (mot de passe, 6 caractères minimum)</label>
            <input type="password" required minLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <button className="kx-auth-btn" disabled={busy} type="submit">
            {busy ? "Veuillez patienter…" : mode === "login" ? "Se connecter" : "Créer le compte"}
          </button>
        </form>
        <div className="kx-auth-switch">
          {mode === "login" ? (
            <>
              Pas encore de compte ?{" "}
              <button onClick={() => { setMode("signup"); setError(""); setInfo(""); }}>Créer un compte</button>
            </>
          ) : (
            <>
              Déjà un compte ?{" "}
              <button onClick={() => { setMode("login"); setError(""); setInfo(""); }}>Se connecter</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Onboarding({ userId, existing, onDone }) {
  const [magasinNom, setMagasinNom] = useState((existing && existing.magasin_nom) || "");
  const [photoFile, setPhotoFile] = useState(null);
  const [preview, setPreview] = useState((existing && existing.photo_url) || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function onPickPhoto(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setPhotoFile(file);
    setPreview(URL.createObjectURL(file));
  }

  async function submit(e) {
    e.preventDefault();
    if (!magasinNom.trim()) return;
    setBusy(true);
    setError("");
    try {
      let photoUrl = (existing && existing.photo_url) || null;
      if (photoFile) {
        const ext = photoFile.name.split(".").pop();
        const path = `${userId}/avatar.${ext}`;
        const { error: upErr } = await supabase.storage.from("avatars").upload(path, photoFile, { upsert: true });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
        photoUrl = pub.publicUrl;
      }
      const { data, error: upsertErr } = await supabase
        .from("profiles")
        .upsert({ id: userId, magasin_nom: magasinNom.trim(), photo_url: photoUrl })
        .select()
        .single();
      if (upsertErr) throw upsertErr;
      onDone(data);
    } catch (err) {
      setError("Une erreur est survenue : " + err.message);
    }
    setBusy(false);
  }

  return (
    <div className="kx-auth-wrap">
      <Style />
      <div className="kx-auth-card">
        <h1>Configurer ton magasin</h1>
        <p className="kx-auth-sub">Dernière étape avant d'accéder au Kardex.</p>
        {error && <div className="kx-auth-error">{error}</div>}
        <form onSubmit={submit}>
          <div className="kx-auth-photo-row">
            {preview ? <img src={preview} alt="" className="kx-auth-photo-preview" /> : <div className="kx-auth-photo-placeholder">Photo</div>}
            <label style={{ fontSize: 12, color: "#2F6F62", cursor: "pointer", fontWeight: 600 }}>
              Choisir une photo
              <input type="file" accept="image/*" onChange={onPickPhoto} style={{ display: "none" }} />
            </label>
          </div>
          <div className="kx-auth-field">
            <label>Nom du magasin</label>
            <input type="text" required value={magasinNom} onChange={(e) => setMagasinNom(e.target.value)} placeholder="Ex : Magasin Zone 4" />
          </div>
          <button className="kx-auth-btn" disabled={busy} type="submit">
            {busy ? "Enregistrement…" : "Continuer"}
          </button>
        </form>
      </div>
    </div>
  );
}

function traduireErreur(msg) {
  if (/Invalid login credentials/i.test(msg)) return "Adresse e-mail ou code incorrect.";
  if (/already registered/i.test(msg)) return "Un compte existe déjà avec cette adresse e-mail.";
  if (/Password should be/i.test(msg)) return "Le code doit contenir au moins 6 caractères.";
  return msg;
}
