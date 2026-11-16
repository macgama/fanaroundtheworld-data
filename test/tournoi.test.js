import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Classement, empreinte } from "../src/classement.js";
import { Tournoi, fenetre, pointsDuel, DUELS_MAX, DEFENSE_MAX } from "../src/tournoi.js";

function bases() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (q, ...v) => { const rows = db.prepare(q).all(...v); return { toArray: () => rows }; } };
  return { c: new Classement(sql), t: new Tournoi(sql) };
}

const VEN = Date.parse("2026-11-13T00:00:00Z") / 1000;
const SAM = VEN + 86400;
const ids = ["a", "b", "c", "d"].map((x) => x.repeat(16));
const cles = ["1", "2", "3", "4"].map((x) => x.repeat(32));

async function preparer() {
  const { c, t } = bases();
  const h = [];
  for (let i = 0; i < ids.length; i++) {
    h.push(await empreinte(cles[i]));
    c.envoyer({ v: 1, id: ids[i], cle: cles[i], pseudo: [1, 2, 3], points: [] }, { hash: h[i], ip: "", maintenantS: SAM - 600 });
  }
  return { c, t, h };
}
const ins = (t, h, i, s = SAM, extra = {}) =>
  t.inscrire({ id: ids[i], nom: [i, i + 1], couleurs: [0, 7], niveau: 3, ...extra }, { hash: h[i], maintenantS: s });

test("fenêtre du week-end", () => {
  assert.equal(fenetre(VEN + 60).etat, "actif");
  assert.equal(fenetre(VEN + 60).id, "2026-11-13");
  assert.equal(fenetre(VEN + 3 * 86400 + 11 * 3600).etat, "actif"); // lundi 11 h
  assert.equal(fenetre(VEN + 3 * 86400 + 12 * 3600).etat, "attente"); // lundi midi
  assert.equal(fenetre(VEN - 60).id, "2026-11-06"); // jeudi soir : le tournoi d'avant
  assert.equal(pointsDuel(true, true, true), 5);
  assert.equal(pointsDuel(false, false, false), 1);
});

test("inscription : identité et nom", async () => {
  const { t, h } = await preparer();
  assert.equal(ins(t, h, 0).statut, 200);
  assert.equal(t.inscrire({ id: ids[0], nom: [0, 1], couleurs: [0, 7] }, { hash: h[1], maintenantS: SAM }).statut, 403);
  assert.equal(t.inscrire({ id: "e".repeat(16), nom: [0, 1], couleurs: [0, 7] }, { hash: h[0], maintenantS: SAM }).corps.erreur, "fan_inconnu");
  assert.equal(ins(t, h, 1, SAM, { nom: ["Gros mot", 1] }).statut, 400);
  assert.equal(ins(t, h, 1, VEN - 3600).corps.erreur, "tournoi_ferme"); // jeudi
  assert.equal(ins(t, h, 1, SAM, { tournoi: "2026-11-06" }).corps.erreur, "autre_tournoi");
});

test("duels, défense, classement", async () => {
  const { t, h } = await preparer();
  for (let i = 0; i < 3; i++) ins(t, h, i);
  const tirage = t.adversaire({ id: ids[0] }, { hash: h[0], maintenantS: SAM });
  assert.ok([ids[1], ids[2]].includes(tirage.corps.adversaire.id));
  assert.equal(t.adversaire({ id: ids[0] }, { hash: h[0], maintenantS: SAM + 1 }).statut, 429);
  const r = (i, adv, match, gagne, s, extra = {}) =>
    t.resultat({ id: ids[i], adversaire: adv, match, gagne, ...extra }, { hash: h[i], maintenantS: s });
  // A perd contre B : 1 point pour A, +1 défense pour B.
  assert.equal(r(0, ids[1], "af:1", false, SAM).corps.pts, 1);
  assert.equal(t.club(ids[1], "2026-11-13").defense, 1);
  assert.equal(r(0, ids[2], "af:2", true, SAM + 5).corps.erreur, "trop_tot");
  assert.equal(r(0, ids[2], "af:1", true, SAM + 60).corps.erreur, "deja_compte"); // même match
  assert.equal(r(0, ids[1], "af:3", true, SAM + 60).corps.erreur, "deja_compte"); // même adversaire
  assert.equal(r(0, ids[0], "af:3", true, SAM + 60).statut, 400); // soi-même
  assert.equal(r(0, ids[3], "af:3", true, SAM + 60).corps.erreur, "adversaire_inconnu");
  assert.equal(r(0, ids[2], "af:3", true, SAM + 60, { stade: true, evenement: true }).corps.pts, 5);
  assert.equal(t.club(ids[2], "2026-11-13").defense, 0); // C a perdu : pas de défense
  // Puis des clubs du jeu jusqu'au plafond.
  let s = SAM + 100;
  for (let k = 0; k < 10; k++, s += 60) r(0, `bot:${k}`, `af:${10 + k}`, true, s);
  const a = t.club(ids[0], "2026-11-13");
  assert.equal(a.duels, DUELS_MAX);
  assert.equal(a.points, 1 + 5 + 5 * 3);
  assert.equal(a.rang, 1);
  assert.equal(a.clubs, 2); // A, et B avec sa défense
  const cl = t.classement(undefined, s);
  assert.equal(cl.inscrits, 3);
  assert.deepEqual(cl.clubs.map((x) => x.id), [ids[0], ids[1]]);
  assert.deepEqual(cl.clubs[0].nom, [0, 1]);
  // Plus aucun adversaire de joueur à tirer pour A.
  assert.equal(t.adversaire({ id: ids[0] }, { hash: h[0], maintenantS: s }).corps.adversaire, null);
});

test("défense plafonnée, grâce et nettoyage", async () => {
  const { t, h } = await preparer();
  for (let i = 0; i < 4; i++) ins(t, h, i);
  const LUN = VEN + 3 * 86400 + 11 * 3600;
  // B, C, D perdent contre A plusieurs fois (adversaires différents à chaque fois : un seul par club).
  for (const i of [1, 2, 3]) t.resultat({ id: ids[i], adversaire: ids[0], match: "af:9", gagne: false }, { hash: h[i], maintenantS: LUN });
  assert.equal(t.club(ids[0], "2026-11-13").defense, 3);
  assert.ok(DEFENSE_MAX >= 3);
  // Un résultat juste après midi est encore accepté (grâce), pas deux heures après.
  const fin = VEN + 3 * 86400 + 12 * 3600;
  assert.equal(t.resultat({ id: ids[1], adversaire: "bot:1", match: "af:8", gagne: true }, { hash: h[1], maintenantS: fin + 600 }).statut, 200);
  assert.equal(t.resultat({ id: ids[2], adversaire: "bot:1", match: "af:8", gagne: true }, { hash: h[2], maintenantS: fin + 7200 }).corps.erreur, "tournoi_ferme");
  assert.equal(t.club(ids[0], "2026-11-13").rang, 2); // B (1 + 3 = 4 points) devant A (3 de défense)
  t.nettoyer(VEN + 40 * 86400);
  assert.equal(t.club(ids[0], "2026-11-13"), null);
});
