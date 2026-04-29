/**
 * Agent de veille républicaine — Enfants de la République
 * Appelle Claude via l'API Anthropic, récupère le JSON de la veille,
 * et injecte les faits dans Supabase.
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

const PROMPT = `Tu es l'agent de veille républicaine de l'association "Enfants de la République".

Aujourd'hui nous sommes le ${today}.

Ta mission : effectuer une veille de l'actualité française des 48 dernières heures et identifier 3 à 5 faits significatifs au regard de la Charte des droits et devoirs du citoyen français, qui définit 6 axes :

- Axe A : Indivisibilité & souveraineté — unité de la République, refus du séparatisme
- Axe B : Laïcité — séparation Églises/État, neutralité des services publics
- Axe C : Démocratie & État de droit — suffrage universel, indépendance de la justice
- Axe D : Égalité — égalité devant la loi sans distinction d'origine, de sexe ou de religion
- Axe E : Liberté — liberté d'expression, de la presse, droits fondamentaux
- Axe F : Fraternité & cohésion sociale — solidarité nationale, sécurité des personnes

Pour chaque fait, évalue le positionnement de la personnalité ou institution concernée :
- "Proche" : conforme aux valeurs de la charte
- "Éloigné" : en contradiction avec la charte
- "Ambigu" : position mixte ou contradictoire

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ni après, sans balises markdown, sans commentaires. Format exact :

[
  {
    "date_fait": "YYYY-MM-DD",
    "source": "https://url-de-la-source.fr",
    "titre": "Titre court et factuel du fait",
    "description": "Description factuelle et analyse argumentée en 3-5 phrases, non partisane, citant les éléments concrets.",
    "axe": "A|B|C|D|E|F",
    "personnalite": "Prénom Nom (fonction)",
    "positionnement": "Proche|Éloigné|Ambigu",
    "auteur": "Claude (veille automatique)"
  }
]`;

// ── 1. Appel à l'API Claude ──────────────────────────────────────────────
async function appelClaude() {
  console.log('🔍 Lancement de la veille via Claude…');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Erreur API Claude : ${response.status} — ${err}`);
  }

  const data = await response.json();

  // Extraire le texte de la réponse (ignorer les blocs tool_use/tool_result)
  const texte = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  console.log('📝 Réponse Claude reçue.');
  return texte;
}

// ── 2. Parser le JSON ────────────────────────────────────────────────────
function parserJson(texte) {
  // Nettoyer les éventuelles balises markdown résiduelles
  const clean = texte
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Extraire le tableau JSON (chercher [ ... ])
  const match = clean.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Aucun tableau JSON trouvé dans la réponse.');

  const faits = JSON.parse(match[0]);
  if (!Array.isArray(faits) || faits.length === 0) {
    throw new Error('Le JSON parsé n\'est pas un tableau valide.');
  }

  // Validation basique de chaque fait
  const axes = ['A', 'B', 'C', 'D', 'E', 'F'];
  const positions = ['Proche', 'Éloigné', 'Ambigu'];

  return faits.filter(f => {
    if (!f.titre || !f.axe || !f.positionnement) {
      console.warn('⚠️ Fait ignoré (champs manquants) :', f.titre || '?');
      return false;
    }
    if (!axes.includes(f.axe)) {
      console.warn(`⚠️ Axe invalide "${f.axe}" pour : ${f.titre}`);
      return false;
    }
    if (!positions.includes(f.positionnement)) {
      console.warn(`⚠️ Positionnement invalide "${f.positionnement}" pour : ${f.titre}`);
      return false;
    }
    return true;
  });
}

// ── 3. Injecter dans Supabase ────────────────────────────────────────────
async function injecterSupabase(faits) {
  console.log(`📤 Injection de ${faits.length} fait(s) dans Supabase…`);
  let ok = 0;
  let erreurs = 0;

  for (const fait of faits) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/faits`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(fait),
    });

    if (response.ok) {
      ok++;
      console.log(`  ✅ ${fait.titre?.slice(0, 60)}…`);
    } else {
      erreurs++;
      const err = await response.text();
      console.error(`  ❌ Erreur pour "${fait.titre?.slice(0, 40)}" : ${err}`);
    }
  }

  return { ok, erreurs };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🗓  Veille républicaine — ${today}\n`);

  try {
    const texte = await appelClaude();
    const faits = parserJson(texte);
    console.log(`✔ ${faits.length} fait(s) valides parsés.`);

    const { ok, erreurs } = await injecterSupabase(faits);
    console.log(`\n✔ Veille terminée : ${ok} fait(s) publié(s), ${erreurs} erreur(s).`);

    if (erreurs > 0) process.exit(1);
  } catch (e) {
    console.error('❌ Erreur fatale :', e.message);
    process.exit(1);
  }
}

main();
