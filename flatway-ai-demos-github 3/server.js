// Minimal backend proxy for the Flatway smart-search AI feature.
//
// PURPOSE: this is the piece that doesn't exist in the original demo.
// In the demo, the Anthropic API key gets typed into the browser, which means
// anyone who opens dev tools can read it and start spending Flatway's API
// budget. This server fixes that: the key lives only here, server-side,
// read from an environment variable. The browser never sees it.
//
// HOW TO RUN (see README.md in this folder for the full walkthrough):
//   1. npm install
//   2. cp .env.example .env   and put a real Anthropic key in .env
//   3. npm start
//   4. open http://localhost:3000 in your browser

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
// Higher limit than the default 100kb — photo uploads for the listing builder
// are base64-encoded in the request body and need real headroom.
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SEARCH_SYSTEM_PROMPT = `Tu es un moteur de recherche immobilier pour Flatway.fr. Analyse la requête et réponds UNIQUEMENT en JSON valide:
{"type":"Appartement|Maison|Studio","ville":"nom ville","arrondissement":"ex 15 ou 16","pieceMin":number|null,"surfaceMin":number|null,"prixMax":number|null,"features":["balcon","parking","lumineux","meublé","jardin","calme","vue","cave","familial",...],"summary":"résumé court en français"}
Note : "jardin" couvre aussi "espace extérieur"/"terrasse au sol"/"vue sur jardin". "calme" couvre aussi "tranquille"/"peu de bruit"/"rue calme".`;

// Extracts a JSON object from the model's response even if it's wrapped
// in code fences or extra prose. Mirrors the hardened parser already in the frontend.
function parseModelJSON(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('Failed to parse model JSON:', match[0], e.message);
    return {};
  }
}

// Shared helper: both /api/search and /api/match-context need the same
// "call Anthropic, get back text, extract JSON" pattern. One function so
// the error handling (missing key, upstream failure, bad JSON) is identical
// for every AI feature this backend exposes, instead of copy-pasted per route.
// `content` may be a plain string (text-only) or an array of content blocks
// (text + image blocks) for routes that need vision, like the listing builder.
async function callAnthropic(systemPrompt, content, maxTokens = 300) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Check your .env file.');
    throw Object.assign(new Error('Server misconfigured: no API key set.'), { status: 500 });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content }]
    })
  });

  if (!upstream.ok) {
    const errBody = await upstream.text();
    console.error('Anthropic API returned an error:', upstream.status, errBody);
    throw Object.assign(new Error('Upstream API error'), { status: 502, upstreamStatus: upstream.status });
  }

  const data = await upstream.json();
  const rawText = data.content?.[0]?.text || '{}';
  return parseModelJSON(rawText);
}

// Same upstream call as callAnthropic, but for routes that need a plain
// conversational answer back (e.g. the concierge chat) instead of a
// structured JSON object. Kept separate rather than overloading callAnthropic
// so JSON-shaped routes can't accidentally get free text back.
async function callAnthropicText(systemPrompt, content, maxTokens = 400) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Check your .env file.');
    throw Object.assign(new Error('Server misconfigured: no API key set.'), { status: 500 });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content }]
    })
  });

  if (!upstream.ok) {
    const errBody = await upstream.text();
    console.error('Anthropic API returned an error:', upstream.status, errBody);
    throw Object.assign(new Error('Upstream API error'), { status: 502, upstreamStatus: upstream.status });
  }

  const data = await upstream.json();
  return (data.content?.[0]?.text || '').trim();
}

app.post('/api/search', async (req, res) => {
  const query = (req.body && req.body.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Missing "query" in request body.' });
  }

  try {
    const criteria = await callAnthropic(SEARCH_SYSTEM_PROMPT, query);
    return res.json(criteria);
  } catch (e) {
    console.error('Unexpected error calling Anthropic:', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Agent-matching AI feature: this is a PROOF OF CONCEPT, not a confirmed
// production path. It assumes a free-text "context" note exists somewhere
// in the real listing intake (seller circumstances, urgency, etc). We have
// NOT confirmed Flatway's actual intake captures this — if it doesn't, this
// route has nothing real to read from yet. The rest of the matching score
// (scoreAgent in agent-matching.html) is plain weighted math, same as
// before; this route only extracts urgency/complexity signals from free
// text so the demo can show those signals nudging the weights.
// ---------------------------------------------------------------------------
const MATCH_CONTEXT_SYSTEM_PROMPT = `Tu analyses une note libre décrivant le contexte d'une vente immobilière (vendeur, bien, calendrier). Réponds UNIQUEMENT en JSON valide:
{"urgency":"high|medium|low","complexity":"high|medium|low","summary":"résumé court en français"}
"urgency" = à quel point le vendeur veut vendre vite. "complexity" = présence de complications (bien occupé, copropriété difficile, succession, travaux, vendeur à l'étranger, etc). Si la note est vide ou ne donne aucune indication, réponds "medium" pour les deux et un summary vide.`;

app.post('/api/match-context', async (req, res) => {
  const note = (req.body && req.body.note || '').trim();
  if (!note) {
    return res.json({ urgency: 'medium', complexity: 'medium', summary: '' });
  }

  try {
    const signals = await callAnthropic(MATCH_CONTEXT_SYSTEM_PROMPT, note);
    return res.json(signals);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (match-context):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Welcome-email AI feature: REAL use case is broker/agency onboarding. When
// an agency is approved as a Flatway Pro partner, they need a welcome email
// containing their actual login credentials.
//
// IMPORTANT DESIGN CHOICE: the credentials block (username, temp password,
// login link) is NEVER generated by the model. A model can paraphrase,
// truncate, or otherwise alter exact strings — that is not acceptable for
// login info. So this route only asks the model to write the personalized
// intro paragraph (using the agency name + an optional free-text note about
// their specialty/zone). The credentials block is assembled separately in
// code, untouched by AI, and glued onto the AI-written intro before sending.
// This is the honest version: AI adds value on the personalization, not on
// the security-sensitive part.
// ---------------------------------------------------------------------------
const WELCOME_EMAIL_SYSTEM_PROMPT = `Tu rédiges UNIQUEMENT le paragraphe d'introduction d'un email de bienvenue pour une agence immobilière qui vient d'être acceptée comme partenaire Pro sur Flatway.fr. Réponds UNIQUEMENT en JSON valide:
{"subject":"objet de l'email","intro":"2-3 phrases chaleureuses et professionnelles en français, qui souhaitent la bienvenue à l'agence et mentionnent sa spécialité/zone si fournie. Ne mentionne JAMAIS d'identifiants, mots de passe ou liens de connexion : ce sera ajouté séparément."}
Ne génère pas de bloc d'identifiants, ne signe pas l'email, ne mentionne pas "ci-dessous" ou "voici vos identifiants" — ce texte sera suivi automatiquement par un bloc d'identifiants généré par notre système, pas par toi. N'utilise AUCUN emoji, ni dans l'objet ni dans l'intro : ton professionnel et sobre uniquement.`;

app.post('/api/welcome-email', async (req, res) => {
  const { agencyName, specialty, username, loginUrl } = req.body || {};
  if (!agencyName || !username) {
    return res.status(400).json({ error: 'Missing "agencyName" or "username" in request body.' });
  }
  const userText = `Agence: ${agencyName}\nSpécialité/zone (optionnel): ${specialty || '(non précisé)'}`;
  try {
    const aiPart = await callAnthropic(WELCOME_EMAIL_SYSTEM_PROMPT, userText);
    // Credentials block assembled here, in code, never by the model.
    const credentialsBlock =
      `Voici vos identifiants de connexion à l'espace Pro Flatway :\n` +
      `Identifiant : ${username}\n` +
      `Mot de passe temporaire : (généré automatiquement, envoyé séparément pour des raisons de sécurité)\n` +
      `Lien de connexion : ${loginUrl || 'https://flatway.fr/flatwaypro/login'}\n` +
      `Vous serez invité(e) à changer ce mot de passe à la première connexion.`;
    return res.json({
      subject: aiPart.subject || `Bienvenue sur Flatway, ${agencyName}`,
      intro: aiPart.intro || '',
      credentialsBlock
    });
  } catch (e) {
    console.error('Unexpected error calling Anthropic (welcome-email):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Photo + address listing builder: a seller gives photos and an address, AI
// (vision-capable model) looks at the photos and drafts a listing
// description. This IS genuinely AI — interpreting unstructured photos is
// not something rule-based code can do, unlike most of agent-matching.
//
// HONEST LIMITS, stated up front because they matter:
// - The model can only describe what's VISIBLE in the photos (room types,
//   apparent condition, style, natural light, finishes). It cannot verify
//   objective facts that aren't visually obvious: exact square meters,
//   official DPE energy rating, legal property type, year built, price.
//   Those must still be entered by a human and are never inferred here.
// - This is a draft for a human to review and edit, not an auto-published
//   listing. Wrong inferences (e.g. miscounting rooms from a few photos)
//   are a realistic failure mode, not a hypothetical one.
// ---------------------------------------------------------------------------
const LISTING_BUILDER_SYSTEM_PROMPT = `Tu es un rédacteur d'annonces immobilières pour Flatway.fr. Tu reçois une adresse et une ou plusieurs photos d'un bien. Réponds UNIQUEMENT en JSON valide:
{"identifiedFeatures":["liste courte de caractéristiques VISIBLES sur les photos, ex: cuisine ouverte, parquet, grande luminosité, salle de bain rénovée"],"title":"titre d'annonce court et accrocheur en français","description":"description d'annonce de 4-6 phrases en français, basée UNIQUEMENT sur ce qui est visible sur les photos et l'adresse fournie","uncertain":["liste des éléments que tu ne peux PAS déterminer depuis les photos seules, ex: surface exacte en m², classe DPE, année de construction, prix"]}
Ne JAMAIS inventer de surface en m², de classe DPE, ou de prix : ce sont des champs "uncertain", pas des suppositions. Décris uniquement ce qui est visible.`;

app.post('/api/listing-builder', async (req, res) => {
  const { address, images } = req.body || {};
  if (!address || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Missing "address" or "images" (non-empty array) in request body.' });
  }
  if (images.length > 6) {
    return res.status(400).json({ error: 'Too many images — max 6 per request for this demo.' });
  }

  // Build a multimodal content array: address as text, each photo as an image block.
  const content = [
    { type: 'text', text: `Adresse du bien : ${address}\nVoici ${images.length} photo(s) du bien.` }
  ];
  for (const img of images) {
    if (!img.mediaType || !img.data) {
      return res.status(400).json({ error: 'Each image needs "mediaType" and "data" (base64).' });
    }
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data }
    });
  }

  try {
    const listing = await callAnthropic(LISTING_BUILDER_SYSTEM_PROMPT, content, 700);
    return res.json(listing);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (listing-builder):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Automated email-reply drafting. DIFFERENT problem from welcome-email:
// welcome-email is one fixed trigger with a fixed shape (broker approved ->
// send credentials). This is open-ended: a buyer/seller/broker sends an
// unpredictable free-text question ("is it still available", "can you
// negotiate", "what documents do I need"), and something has to understand
// the question before it can answer. That's genuinely AI — there's no fixed
// rule set that parses arbitrary human questions.
//
// HONEST LIMITS:
// - The model only knows what's in `listingContext` (free text Luke/Flatway
//   would type in, or eventually pull from the real listing record). It must
//   NOT invent price, availability, or scheduling facts that aren't given —
//   if the context doesn't answer the question, the reply must say so and
//   flag for a human, not guess.
// - This is a DRAFT for human approval before sending, never an auto-send.
//   A wrong promise in an email to a buyer (e.g. confirming availability
//   when a property is actually under offer) is a real liability.
// - Wiring this into Flatway's actual inbox (Gmail/Outlook/helpdesk API) is
//   a separate step requiring access from whoever administers that system —
//   not something buildable from this sandbox. This route only proves the
//   drafting logic; it doesn't read or send real email.
// ---------------------------------------------------------------------------
// Note: draftReplyEnglish exists ONLY so a non-French-speaking reviewer (e.g.
// Luke) can verify the French draft is accurate without needing to read
// French. It is a literal translation for review purposes — never the text
// that would actually get sent. The real outgoing reply must stay in French,
// since that's the language Flatway's actual customers write and read in.
const EMAIL_REPLY_SYSTEM_PROMPT = `Tu rédiges des brouillons de réponse par email pour Flatway.fr, une agence immobilière. Tu reçois un email entrant (expéditeur, sujet, corps) et un contexte sur le bien concerné (peut être incomplet ou absent). Réponds UNIQUEMENT en JSON valide:
{"intent":"disponibilite|visite|prix|documents|negociation|autre|indetermine","draftReply":"brouillon de réponse en français, professionnel et chaleureux, qui répond UNIQUEMENT avec les informations présentes dans le contexte fourni","draftReplyEnglish":"traduction littérale en anglais du contenu de draftReply, UNIQUEMENT pour qu'un relecteur non-francophone puisse vérifier l'exactitude — ce n'est jamais le texte qui serait envoyé","missingInfo":["liste des informations nécessaires pour répondre complètement mais absentes du contexte fourni, vide si tout est disponible"],"needsHumanReview":boolean}
Règles strictes : si le contexte ne contient pas une information nécessaire (prix, disponibilité, date de visite, documents requis), NE L'INVENTE JAMAIS. Mentionne dans le brouillon qu'un membre de l'équipe reviendra vers eux avec ces détails, et liste cette information dans "missingInfo". Mets "needsHumanReview" à true si l'email contient une demande de négociation, une plainte, ou toute situation sensible nécessitant un jugement humain.`;

app.post('/api/email-reply', async (req, res) => {
  const { senderName, senderType, subject, body, listingContext } = req.body || {};
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Missing "body" (the incoming email text) in request body.' });
  }

  const userText =
    `Expéditeur : ${senderName || '(non précisé)'} (${senderType || 'rôle non précisé'})\n` +
    `Sujet : ${subject || '(aucun sujet)'}\n` +
    `Corps de l'email reçu :\n${body}\n\n` +
    `Contexte sur le bien concerné (peut être incomplet) :\n${listingContext || '(aucun contexte fourni)'}`;

  try {
    const draft = await callAnthropic(EMAIL_REPLY_SYSTEM_PROMPT, userText, 500);
    return res.json(draft);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (email-reply):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Fee transparency assistant: NOT a confirmed Flatway feature, this is the
// idea floated after reading the deck — at the "Choix du professionnel"
// step, the seller already compares fee tables, this just turns the numbers
// into plain language and a recommendation. The fee math itself is plain
// arithmetic (no AI needed). The only real AI step is explaining the
// trade-off in context and reacting to a seller's free-text priorities,
// the same "small AI-assist bolted onto real math" pattern as agent-matching.
// ---------------------------------------------------------------------------
const FEE_EXPLAIN_SYSTEM_PROMPT = `Tu es un assistant qui aide un vendeur immobilier à comprendre le choix entre deux options de visites pour la vente de son bien sur Flatway.fr. Tu reçois les montants nets calculés pour les deux options (visites assurées par le professionnel vs par le vendeur lui-même) et, éventuellement, une note libre du vendeur sur sa situation. Réponds UNIQUEMENT en JSON valide:
{"explanation":"2-3 phrases en français expliquant clairement l'écart entre les deux options et ce qu'il signifie concrètement pour le vendeur","recommendation":"professionnel|vendeur|neutre","reasoning":"1 phrase justifiant la recommandation, basée sur les montants ET la note du vendeur si elle est fournie"}
Ne recommande "neutre" que si les montants sont très proches ET qu'aucune note ne donne d'indication claire. Reste factuel, pas de ton commercial.`;

app.post('/api/fee-explain', async (req, res) => {
  const { netWithPro, netWithSeller, note } = req.body || {};
  if (typeof netWithPro !== 'number' || typeof netWithSeller !== 'number') {
    return res.status(400).json({ error: 'Missing "netWithPro" or "netWithSeller" (numbers) in request body.' });
  }
  const userText =
    `Net si visites assurées par le professionnel : ${netWithPro.toLocaleString('fr-FR')} €\n` +
    `Net si visites assurées par le vendeur lui-même : ${netWithSeller.toLocaleString('fr-FR')} €\n` +
    `Note du vendeur (optionnelle) : ${note || '(aucune)'}`;
  try {
    const result = await callAnthropic(FEE_EXPLAIN_SYSTEM_PROMPT, userText, 250);
    return res.json(result);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (fee-explain):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Listing price guidance: estimates a price range from comparable real
// listings (same dataset the search demo uses), then asks the model to
// explain/caveat the estimate in plain language. The estimate itself is
// plain math (average price/m² across matching comps) — the AI step only
// writes the explanation and reacts to free-text context about the property
// (renovation, urgency, etc), same honest pattern as the other demos.
// ---------------------------------------------------------------------------
const PRICE_EXPLAIN_SYSTEM_PROMPT = `Tu es un assistant qui aide un vendeur à comprendre une estimation de prix indicative pour son bien sur Flatway.fr, basée sur des biens comparables. Tu reçois l'estimation calculée (fourchette basse/haute), le nombre de biens comparables utilisés, et éventuellement une note libre du vendeur sur l'état ou la situation du bien. Réponds UNIQUEMENT en JSON valide:
{"explanation":"2-3 phrases en français expliquant sur quoi se base l'estimation et ses limites","caveats":["liste courte des raisons pour lesquelles le prix réel pourrait différer de l'estimation, notamment si la note du vendeur mentionne des travaux, un état particulier, ou peu de biens comparables"]}
Ne confirme jamais un prix exact : c'est une fourchette indicative, pas une estimation officielle. Si peu de biens comparables sont disponibles, dis-le clairement.`;

app.post('/api/price-explain', async (req, res) => {
  const { low, high, compCount, note } = req.body || {};
  if (typeof low !== 'number' || typeof high !== 'number') {
    return res.status(400).json({ error: 'Missing "low" or "high" (numbers) in request body.' });
  }
  const userText =
    `Fourchette estimée : ${low.toLocaleString('fr-FR')} € à ${high.toLocaleString('fr-FR')} €\n` +
    `Nombre de biens comparables utilisés : ${compCount ?? 0}\n` +
    `Note du vendeur (optionnelle) : ${note || '(aucune)'}`;
  try {
    const result = await callAnthropic(PRICE_EXPLAIN_SYSTEM_PROMPT, userText, 250);
    return res.json(result);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (price-explain):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Listing concierge chat: a buyer asks a question about a specific listing
// and gets a real answer instead of emailing the professional and waiting.
//
// HONEST SCOPE: the listing facts and "documents" used as context here
// (charges, AG minutes, diagnostics) are ILLUSTRATIVE PLACEHOLDER DATA, not a
// real Flatway listing or real uploaded documents — we don't have access to
// either. What's real: the chat/Q&A mechanic itself, and the guardrail.
// The guardrail is the important part: the model is told, explicitly, to
// answer ONLY from the context it's given and to say so — never invent a
// detail about the property that isn't in front of it. This is the same
// "say null/unknown rather than guess" principle as the estimation-autofill
// and listing-builder demos, just applied to a chat instead of a form.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// UPDATE: concierge chat now returns two separate fields instead of one
// plain-text answer, per Luke's request to add an "Explain This Apartment"
// style layer for subjective questions ("is this quiet," "good for a
// family") on top of the existing strict-facts-only behavior.
//
// `factual` keeps the original guardrail untouched: only what's literally in
// the context, "I don't know" otherwise, never a guess.
// `impression` is NEW and deliberately separate: only filled in when the
// question is asking for a judgment call the given facts reasonably support
// (e.g. context says "vue dégagée et calme" -> reasonable to say it seems
// well-suited to someone wanting quiet). It must stay grounded in the same
// context block — it is not permission to use outside knowledge — and the
// frontend renders it in a visibly distinct, labeled box so it's never
// confused with a verified fact. If a question has no reasonable basis for
// an impression, this field comes back null, same null-not-a-guess rule as
// every other demo here.
// ---------------------------------------------------------------------------
const CONCIERGE_SYSTEM_PROMPT = `Tu es l'assistant d'une annonce sur Flatway.fr. Un acheteur potentiel te pose des questions sur UN bien précis. Tu reçois ci-dessous le contexte complet dont tu disposes sur ce bien (caractéristiques, charges, documents de copropriété, diagnostics). Réponds UNIQUEMENT en JSON valide:
{"factual":"réponse en français, naturelle et directe, 2 à 4 phrases maximum, basée UNIQUEMENT à partir des informations du contexte. Si l'information demandée n'apparaît PAS dans le contexte, dis-le clairement et invite l'acheteur à contacter le professionnel en charge de l'annonce — ne devine et n'invente JAMAIS un fait sur le bien.","impression":"UNIQUEMENT si la question demande un avis ou un jugement subjectif (ex: est-ce calme, est-ce adapté à une famille, est-ce lumineux, y a-t-il du bruit) ET que les faits du contexte permettent raisonnablement d'en déduire quelque chose : 1 phrase courte donnant cette impression générale, explicitement basée sur tel ou tel élément du contexte. Sinon, mets null — ne force jamais une impression sans base dans le contexte fourni."}
Règle absolue : factual ne doit jamais contenir de supposition. impression, quand elle existe, reste une impression générale clairement présentée comme telle, jamais un fait vérifié, et ne doit jamais s'appuyer sur des informations extérieures au contexte fourni.`;

app.post('/api/concierge-chat', async (req, res) => {
  const { listingContext, question, history } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Missing "question" in request body.' });
  }
  if (!listingContext) {
    return res.status(400).json({ error: 'Missing "listingContext" in request body.' });
  }

  const historyText = Array.isArray(history) && history.length
    ? '\n\nHistorique de la conversation :\n' + history.map(h => `${h.role === 'user' ? 'Acheteur' : 'Assistant'}: ${h.text}`).join('\n')
    : '';

  const content = `Contexte sur le bien (toutes les informations dont tu disposes — rien d'autre) :\n${listingContext}${historyText}\n\nNouvelle question de l'acheteur : ${question.trim()}`;

  try {
    const result = await callAnthropic(CONCIERGE_SYSTEM_PROMPT, content, 350);
    return res.json({ factual: result.factual || '', impression: result.impression || null });
  } catch (e) {
    console.error('Unexpected error calling Anthropic (concierge-chat):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Estimation auto-fill: this is the strongest new idea found this session,
// because it is grounded in a REAL screen, not a guess. Logged into Flatway's
// actual estimation flow (flatway.fr/estimation-avancee) and confirmed the
// seller has to manually fill in 17 separate fields one at a time (surface,
// chambres, salles de bain, etage, ascenseur, parking, cave, balcon,
// terrasse, jardin, chambres de service, performance energetique, vue, etat
// de l'immeuble, etat du bien, periode de construction) to get a sharper
// estimate. Only surface is required, the rest are optional but used.
//
// This is genuinely AI, same shape as the photo+address listing builder:
// real free text -> many structured fields, which a fixed rule set cannot
// reliably do (infinite ways to phrase "refait a neuf au 3eme avec balcon").
//
// HONEST LIMITS:
// - The model must NEVER guess a field the seller didn't mention. Every
//   field not mentioned in the text comes back null, not a guess — same
//   "uncertain" principle as the listing builder. This is the most
//   important rule in the whole route.
// - This only proves the EXTRACTION step. It does not submit anything into
//   Flatway's real estimation form/API — that integration doesn't exist
//   here, this is a demo of the intake step in isolation.
// - The seller still reviews and can edit every field before anything is
//   used — same human-verification gate as every other demo.
// ---------------------------------------------------------------------------
const ESTIMATION_AUTOFILL_SYSTEM_PROMPT = `Tu extrais les caractéristiques d'un bien immobilier à partir d'une description libre en français, pour pré-remplir le formulaire d'estimation Flatway.fr. Réponds UNIQUEMENT en JSON valide avec EXACTEMENT ces champs:
{"surface":number|null,"chambres":number|null,"sallesDeBain":number|null,"etage":number|null,"etagesImmeuble":number|null,"ascenseur":true|false|null,"parking":true|false|null,"cave":true|false|null,"balcon":true|false|null,"terrasse":true|false|null,"jardin":true|false|null,"chambresService":number|null,"performanceEnergetique":"A"|"B"|"C"|"D"|"E"|"F"|"G"|null,"vue":"dégagée"|"sur rue"|"sur jardin"|"vis-à-vis"|"calme"|null,"etatImmeuble":"neuf"|"bon état"|"à rafraîchir"|"à rénover"|null,"etatBien":"neuf"|"bon état"|"à rafraîchir"|"à rénover"|null,"periodeConstruction":"avant 1900"|"1900-1945"|"1945-1980"|"1980-2000"|"après 2000"|null}
RÈGLE STRICTE : si une caractéristique n'est ni mentionnée ni clairement déductible du texte, sa valeur DOIT être null. Ne devine JAMAIS une valeur non donnée par l'utilisateur — un null honnête vaut mieux qu'une supposition.`;

app.post('/api/estimation-autofill', async (req, res) => {
  const description = (req.body && req.body.description || '').trim();
  if (!description) {
    return res.status(400).json({ error: 'Missing "description" in request body.' });
  }
  try {
    const fields = await callAnthropic(ESTIMATION_AUTOFILL_SYSTEM_PROMPT, description, 500);
    return res.json(fields);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (estimation-autofill):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Smart Search upgrade: ranked recommendation with reasoning, on top of the
// existing filter/score logic in index.html. The filter/score step stays
// exactly as-is (plain math, scoreMatch()) — this route is a SEPARATE,
// additive AI step that looks at the already-scored top candidates and
// explains which one it would actually recommend first, the way a person
// would ("I'd recommend X first because..."), instead of leaving the buyer
// to interpret a list of percentage-match badges themselves.
//
// HONEST LIMITS:
// - Only ever recommends from the candidate list it's given — it cannot
//   recommend a listing the filter step already excluded.
// - Reasoning must be grounded in the actual fields provided (price, area,
//   rooms, features) — not invented detail.
// ---------------------------------------------------------------------------
const RECOMMEND_SYSTEM_PROMPT = `Tu es un conseiller immobilier pour Flatway.fr. Un acheteur a fait une recherche en langage naturel et plusieurs biens correspondent déjà selon un score de pertinence. Tu reçois la requête originale et une liste de biens candidats (avec leurs caractéristiques et leur score). Réponds UNIQUEMENT en JSON valide:
{"recommendedId":"id du bien que tu recommandes en premier parmi la liste fournie","reasoning":"1-2 phrases en français expliquant pourquoi CE bien correspond le mieux à la requête, basé sur ses caractéristiques réelles (pas seulement son score)","runnerUpId":"id du deuxième choix s'il y en a un pertinent, sinon null","runnerUpReasoning":"1 phrase expliquant l'intérêt ou le compromis du deuxième choix (ex: moins cher mais plus petit), sinon null"}
Règle stricte : ne recommande JAMAIS un bien qui n'est pas dans la liste de candidats fournie. Base ton raisonnement uniquement sur les champs fournis (prix, surface, pièces, ville, caractéristiques) — n'invente aucun détail.`;

app.post('/api/recommend', async (req, res) => {
  const { query, candidates } = req.body || {};
  if (!query || !Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: 'Missing "query" or "candidates" (non-empty array) in request body.' });
  }
  const candidatesText = candidates.map(c =>
    `id=${c.id} | ${c.title} | ${Number(c.price).toLocaleString('fr-FR')}€ | ${c.area}m² | ${c.rooms} pièces | ${c.city} | features: ${(c.features||[]).join(', ') || '(aucune)'} | score: ${c.score}%`
  ).join('\n');
  const userText = `Requête de l'acheteur : "${query}"\n\nBiens candidats déjà filtrés/notés :\n${candidatesText}`;
  try {
    const result = await callAnthropic(RECOMMEND_SYSTEM_PROMPT, userText, 350);
    return res.json(result);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (recommend):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// AI Follow-Up (re-engagement): a buyer viewed a listing and went quiet. The
// TRIGGER (who to message, and why) is rule-based, decided by the frontend
// from view-date/price-change data — that part is plain automation, same
// category as the welcome-email trigger. The only AI step is writing the
// actual message in a tone that fits the specific reason, instead of one
// generic "still interested?" template for every situation.
//
// HONEST LIMITS:
// - The model NEVER invents a price-drop amount or a count of similar
//   listings — those numbers must be passed in; if not given, the model is
//   told to write a generic check-in instead of guessing a number.
// - This produces a draft message, not an auto-send — same human-review
//   pattern as the email-reply and welcome-email demos.
// ---------------------------------------------------------------------------
const FOLLOWUP_SYSTEM_PROMPT = `Tu rédiges un court message de relance pour un acheteur qui a consulté un bien immobilier sur Flatway.fr il y a plusieurs jours sans revenir. Tu reçois le nom de l'acheteur (optionnel), les détails du bien consulté, le nombre de jours depuis sa dernière consultation, le motif de relance (price_drop, similar_available, ou just_checking), et des données associées au motif (montant de baisse de prix, ou nombre de biens similaires). Réponds UNIQUEMENT en JSON valide:
{"subject":"objet court, en français","message":"2-3 phrases en français, ton chaleureux et non insistant, adapté précisément au motif fourni"}
Règles strictes : si motif=price_drop, mentionne le montant de baisse de prix UNIQUEMENT s'il est fourni dans les données — sinon ne mentionne aucun chiffre inventé. Si motif=similar_available, mentionne qu'il existe d'autres biens similaires mais n'invente AUCUN détail précis sur eux (pas de prix, pas d'adresse). Si motif=just_checking, reste simple, bref et non commercial — pas de pression.`;

app.post('/api/followup-message', async (req, res) => {
  const { buyerName, listing, daysSinceView, reason, priceDropAmount, similarCount } = req.body || {};
  if (!listing || !reason) {
    return res.status(400).json({ error: 'Missing "listing" or "reason" in request body.' });
  }
  const userText =
    `Acheteur : ${buyerName || '(non précisé)'}\n` +
    `Bien consulté : ${listing.title} — ${Number(listing.price).toLocaleString('fr-FR')}€, ${listing.area}m², ${listing.rooms} pièces, ${listing.city}\n` +
    `Jours depuis la dernière consultation : ${daysSinceView ?? '(non précisé)'}\n` +
    `Motif de relance : ${reason}\n` +
    `Montant de baisse de prix (si motif=price_drop) : ${priceDropAmount != null ? priceDropAmount.toLocaleString('fr-FR') + '€' : '(non fourni)'}\n` +
    `Nombre de biens similaires (si motif=similar_available) : ${similarCount ?? '(non fourni)'}`;
  try {
    const result = await callAnthropic(FOLLOWUP_SYSTEM_PROMPT, userText, 300);
    return res.json(result);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (followup-message):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Neighborhood Expert + Commute Calculator: given an arrondissement and a
// block of raw sample data about it (transport lines, schools, commerces,
// general character), AI writes a plain-language summary instead of a
// buyer reading a bullet list of raw facts. The commute estimate is NOT AI —
// it's a static lookup table (illustrative, not a live routing API call) — a
// real version would call Google Maps/Mapbox directions, which is an
// engineering integration, not a model task.
//
// HONEST LIMITS:
// - All neighborhood data here is illustrative sample data (a few real
//   well-known facts about each arrondissement mixed with invented detail
//   for ones we didn't research), not a live data feed — flagged clearly on
//   the page. The model only summarizes what's handed to it; it cannot
//   confirm any of it is current or complete.
// - Commute numbers are static estimates, not live traffic-aware routing.
// ---------------------------------------------------------------------------
const NEIGHBORHOOD_SYSTEM_PROMPT = `Tu es un expert de quartier pour Flatway.fr. Tu reçois le nom d'un quartier/arrondissement parisien et des données brutes fournies sur ce quartier (transports, écoles, commerces, ambiance générale). Réponds UNIQUEMENT en JSON valide:
{"summary":"3-4 phrases en français décrivant la vie quotidienne dans ce quartier, à partir UNIQUEMENT des données fournies — ambiance, profil des habitants, atouts principaux","transport":"1-2 phrases sur les transports en commun disponibles, à partir UNIQUEMENT des données fournies","pointsAttention":["1 à 2 points de vigilance honnêtes à partir des données fournies, ex: quartier bruyant le soir, peu de commerces de proximité — vide si rien n'est fourni en ce sens"]}
Règle stricte : ne décris QUE ce qui figure dans les données fournies. N'invente JAMAIS une ligne de métro, une école, un commerce ou un fait sur le quartier qui n'est pas mentionné dans le contexte.`;

app.post('/api/neighborhood-expert', async (req, res) => {
  const { area, rawData } = req.body || {};
  if (!area || !rawData) {
    return res.status(400).json({ error: 'Missing "area" or "rawData" in request body.' });
  }
  const userText = `Quartier : ${area}\n\nDonnées brutes disponibles sur ce quartier :\n${rawData}`;
  try {
    const result = await callAnthropic(NEIGHBORHOOD_SYSTEM_PROMPT, userText, 350);
    return res.json(result);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (neighborhood-expert):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Compare Listings: a buyer picks 2-3 real listings and gets a written
// trade-off comparison instead of flipping between tabs re-reading specs.
// The underlying numbers (price/m², surface, rooms) are plain arithmetic —
// AI's only job is writing the verdict and the comparison points in a way
// that's actually useful ("X is better value, Y is more central"), same
// "AI writes the explanation, math stays in code" pattern as fee-explain
// and price-explain.
//
// HONEST LIMITS:
// - Must only reference listings and fields actually provided — no inventing
//   a feature or fact about a listing that wasn't passed in.
// ---------------------------------------------------------------------------
const COMPARE_SYSTEM_PROMPT = `Tu compares 2 ou 3 biens immobiliers pour un acheteur sur Flatway.fr. Tu reçois les caractéristiques de chaque bien (prix, surface, pièces, ville, caractéristiques, prix par m²). Réponds UNIQUEMENT en JSON valide:
{"verdict":"1-2 phrases résumant quel bien représente le meilleur choix global et pourquoi, ou le compromis entre eux s'il n'y a pas de gagnant évident","points":[{"label":"un point de comparaison concret et si possible chiffré, ex: '69m² à Sèvres-Lecourbe contre 64m² à la Roquette pour 15 000€ de plus'","listingId":"id du bien que ce point favorise, ou null si le point est neutre/informatif"}]}
Règle stricte : base-toi UNIQUEMENT sur les champs fournis pour chaque bien (prix, surface, pièces, ville, caractéristiques). N'invente aucune caractéristique, aucun avantage de quartier ou autre détail non fourni. Donne entre 3 et 5 points de comparaison maximum.`;

app.post('/api/compare-listings', async (req, res) => {
  const { listings } = req.body || {};
  if (!Array.isArray(listings) || listings.length < 2) {
    return res.status(400).json({ error: 'Need "listings" array with at least 2 items.' });
  }
  if (listings.length > 3) {
    return res.status(400).json({ error: 'Max 3 listings per comparison for this demo.' });
  }
  const listingsText = listings.map(l =>
    `id=${l.id} | ${l.title} | ${Number(l.price).toLocaleString('fr-FR')}€ | ${l.area}m² (${Math.round(l.price/l.area).toLocaleString('fr-FR')}€/m²) | ${l.rooms} pièces | ${l.city} | features: ${(l.features||[]).join(', ') || '(aucune)'}`
  ).join('\n');
  try {
    const result = await callAnthropic(COMPARE_SYSTEM_PROMPT, listingsText, 400);
    return res.json(result);
  } catch (e) {
    console.error('Unexpected error calling Anthropic (compare-listings):', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// Basic health check — useful for confirming the server is up before debugging anything else.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Flatway search backend running at http://localhost:${PORT}`);
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
