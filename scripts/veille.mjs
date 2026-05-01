/**
 * Agent de veille républicaine — Enfants de la République
 * 1. Publie les faits du jour dans la table `faits`
 * 2. Met à jour les fiches personnalités dans la table `personnalites`
 *
 * Variables d'environnement requises (GitHub Secrets) :
 *   ANTHROPIC_API_KEY   — clé API Anthropic
 *   SUPABASE_URL        — URL du projet Supabase
 *   SUPABASE_KEY        — clé anon publique Supabase
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;

if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Variables d\'environnement manquantes.');
  process.exit(1);
}

const today = new Date().toLocaleDateString('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});

const AXES_DESC = `- Axe A : Indivisibilité & souveraineté — unité de la République, refus du séparatisme
- Axe B : Laïcité — séparation Églises/État, neutralité des services publics
- Axe C : Démocratie & État de droit — suffrage universel, indépendance de la justice
- Axe D : Égalité — égalité devant la loi sans distinction d'origine, de sexe ou de religion
- Axe E : Liberté — liberté d'expression, de la presse, droits fondamentaux
- Axe F : Fraternité & cohésion sociale — solidarité nationale, sécurité des personnes`;

// ── Helpers ──────────────────────────────────────────────────────────────

async function supabaseGet(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function supabasePost(table, body, prefer = 'return=minimal') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': prefer,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function appelClaude(prompt, avecRecherche = true) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };
  if (avecRecherche) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Erreur API Claude : ${r.status} — ${await r.text()}`);
  const data = await r.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function extraireJson(texte) {
  const clean = texte.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = clean.match(/[\[{][\s\S]*[\]}]/);
  if (!match) throw new Error('Aucun JSON trouvé dans la réponse.');
  return JSON.parse(match[0]);
}

// ════════════════════════════════════════════════════════════════════════
// PARTIE 1 — FAITS DU JOUR
// ════════════════════════════════════════════════════════════════════════

async function getTitresExistants() {
  const il_y_a_7j = new Date();
  il_y_a_7j.setDate(il_y_a_7j.getDate() - 7);
  const dateStr = il_y_a_7j.toISOString().split('T')[0];
  try {
    const data = await supabaseGet('faits', `?select=titre&date_fait=gte.${dateStr}`);
    return data.map(f => f.titre.toLowerCase().trim());
  } catch(e) { return []; }
}

function buildPromptFaits(titresExistants) {
  const exclusions = titresExistants.length > 0
    ? `\nFaits déjà enregistrés cette semaine — NE PAS republier :\n${titresExistants.map(t => `- ${t}`).join('\n')}\n`
    : '';
  return `Tu es l'agent de veille républicaine de l'association "Enfants de la République". Aujourd'hui : ${today}.

Effectue une veille de l'actualité française des 48 dernières heures. Identifie 3 à 5 faits NOUVEAUX au regard de la Charte des droits et devoirs du citoyen français :
${AXES_DESC}
${exclusions}
RÈGLES : faits des 48h uniquement, sourcés par une URL précise, non similaires aux faits existants. Si rien de pertinent, retourne [].

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte ni balises markdown :
[{"date_fait":"YYYY-MM-DD","source":"https://...","titre":"...","description":"3-5 phrases factuelles et non partisanes","axe":"A|B|C|D|E|F","personnalite":"Prénom Nom (fonction)","positionnement":"Proche|Éloigné|Ambigu","auteur":"Claude (veille automatique)"}]`;
}

function estDoublon(titre, titresExistants) {
  const t = titre.toLowerCase().trim();
  return titresExistants.some(ex => {
    if (ex === t) return true;
    const mots = t.split(/\s+/).filter(m => m.length > 4);
    const motsEx = ex.split(/\s+/).filter(m => m.length > 4);
    if (!mots.length) return false;
    return mots.filter(m => motsEx.includes(m)).length / mots.length >= 0.7;
  });
}

async function publierFaits(faits) {
  let ok = 0, err = 0;
  for (const fait of faits) {
    try {
      await supabasePost('faits', fait);
      ok++;
      console.log(`  ✅ ${fait.titre?.slice(0, 70)}`);
    } catch(e) {
      err++;
      console.error(`  ❌ ${fait.titre?.slice(0, 40)} — ${e.message}`);
    }
  }
  return { ok, err };
}

// ════════════════════════════════════════════════════════════════════════
// PARTIE 2 — MISE À JOUR DES PERSONNALITÉS
// ════════════════════════════════════════════════════════════════════════

async function getTousLesFaitsParPersonnalite() {
  try {
    const data = await supabaseGet('faits', '?select=personnalite,titre,axe,positionnement,date_fait,description&order=date_fait.desc');
    const byP = {};
    (data || []).forEach(f => {
      if (!f.personnalite) return;
      if (!byP[f.personnalite]) byP[f.personnalite] = [];
      byP[f.personnalite].push(f);
    });
    return byP;
  } catch(e) { return {}; }
}

function buildPromptPersonnalite(nom, faits) {
  const faitsList = faits.map(f =>
    `- [Axe ${f.axe}, ${f.positionnement}] ${f.titre} (${f.date_fait}) : ${f.description}`
  ).join('\n');

  return `Tu es l'analyste de l'association "Enfants de la République".

Voici tous les faits enregistrés concernant ${nom} :
${faitsList}

Rédige une fiche d'analyse factuelle et non partisane de ${nom} au regard de la Charte des droits et devoirs du citoyen français (axes A à F).

Réponds UNIQUEMENT avec un objet JSON valide, sans texte ni balises markdown :
{
  "nom": "${nom}",
  "fonction": "sa fonction actuelle en quelques mots",
  "positionnement": "Proche|Éloigné|Ambigu",
  "analyses": [
    {
      "axe": "A|B|C|D|E|F",
      "label": "Intitulé exact de l'axe",
      "evaluation": "Proche|Éloigné|Ambigu",
      "texte": "2-3 phrases factuelles basées uniquement sur les faits fournis"
    }
  ],
  "auteur": "Claude (veille automatique)"
}

RÈGLES STRICTES :
- N'inclure que les axes pour lesquels des faits existent
- Rester strictement factuel et non partisan
- Baser l'analyse uniquement sur les faits fournis, pas sur d'autres connaissances`;
}

async function mettreAJourPersonnalite(analyse) {
  // Upsert sur le champ nom (unique)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/personnalites`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      ...analyse,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

// ════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n🗓  Veille républicaine — ${today}\n`);

  // ── 1. Faits du jour ────────────────────────────────────────────────
  console.log('═══ PARTIE 1 : Faits du jour ═══');
  try {
    const titresExistants = await getTitresExistants();
    console.log(`📚 ${titresExistants.length} fait(s) déjà en base cette semaine.`);

    const texte = await appelClaude(buildPromptFaits(titresExistants), true);
    let faits = extraireJson(texte);
    if (!Array.isArray(faits)) faits = [];

    const axes = ['A','B','C','D','E','F'];
    const positions = ['Proche','Éloigné','Ambigu'];
    faits = faits.filter(f => {
      if (!f.titre || !axes.includes(f.axe) || !positions.includes(f.positionnement)) return false;
      if (estDoublon(f.titre, titresExistants)) {
        console.warn(`⚠️  Doublon écarté : ${f.titre.slice(0,60)}`);
        return false;
      }
      return true;
    });

    if (faits.length === 0) {
      console.log('ℹ️  Aucun fait nouveau aujourd\'hui.');
    } else {
      const { ok, err } = await publierFaits(faits);
      console.log(`✔ ${ok} fait(s) publié(s), ${err} erreur(s).`);
    }
  } catch(e) {
    console.error('❌ Erreur faits :', e.message);
  }

  // ── 2. Personnalités ────────────────────────────────────────────────
  console.log('\n═══ PARTIE 2 : Mise à jour personnalités ═══');
  try {
    const faitsByPerso = await getTousLesFaitsParPersonnalite();
    const noms = Object.keys(faitsByPerso);

    if (noms.length === 0) {
      console.log('ℹ️  Aucune personnalité en base.');
    } else {
      console.log(`👤 ${noms.length} personnalité(s) à analyser (pause 12s entre chaque)…`);
      for (let i = 0; i < noms.length; i++) {
        const nom = noms[i];
        if (i > 0) await new Promise(r => setTimeout(r, 12000));
        let tentatives = 0;
        while (tentatives < 3) {
          try {
            console.log(`  → ${nom}…`);
            const texte = await appelClaude(buildPromptPersonnalite(nom, faitsByPerso[nom]), false);
            const analyse = extraireJson(texte);
            await mettreAJourPersonnalite(analyse);
            console.log(`  ✅ ${nom} (${analyse.analyses?.length || 0} axe(s) analysé(s))`);
            break;
          } catch(e) {
            tentatives++;
            if (e.message.includes('429') && tentatives < 3) {
              console.warn(`  ⏳ Rate limit, nouvelle tentative dans 30s… (${tentatives}/3)`);
              await new Promise(r => setTimeout(r, 30000));
            } else {
              console.error(`  ❌ ${nom} : ${e.message}`);
              break;
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('❌ Erreur personnalités :', e.message);
  }

  console.log('\n✔ Veille terminée.');
}

main().catch(e => {
  console.error('❌ Erreur fatale :', e.message);
  process.exit(1);
});
