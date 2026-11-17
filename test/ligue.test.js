import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Classement, empreinte } from "../src/classement.js";
import {
  Ligue, calendrier, journees, avancee, fnv, bot, pointsBot, pointsDuel, mouvement, saisonPrecedente,
  TAILLE_POULE, DIVISIONS, DUELS_JOURNEE, BOTS_JOURNEE,
} from "../src/ligue.js";

function bases() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (q, ...v) => { const rows = db.prepare(q).all(...v); return { toArray: () => rows }; } };
  return { c: new Classement(sql), l: new Ligue(sql) };
}

const VEN = Date.parse("2026-11-13T00:00:00Z") / 1000; // 2e journée de la saison de novembre
const SAM = VEN + 86400;
const ids = ["a", "b", "c", "d"].map((x) => x.repeat(16));
const cles = ["1", "2", "3", "4"].map((x) => x.repeat(32));
const code = (n) => n.toString(16).padStart(16, "0");

async function preparer() {
  const { c, l } = bases();
  const h = [];
  for (let i = 0; i < ids.length; i++) {
    h.push(await empreinte(cles[i]));
    c.envoyer({ v: 1, id: ids[i], cle: cles[i], pseudo: [1, 2, 3], points: [] }, { hash: h[i], ip: "", maintenantS: SAM - 600 });
  }
  return { l, h };
}
const ins = (l, h, i, s = SAM) => l.inscrire({ id: ids[i], nom: [i, i + 1], couleurs: [0, 7], niveau: 3 }, { hash: h[i], maintenantS: s });
const res = (l, h, i, adv, cd, gagne, s, extra = {}) =>
  l.resultat({ id: ids[i], adversaire: adv, code: cd, match: "af:1", gagne, ...extra }, { hash: h[i], maintenantS: s });

test("calendrier : saisons mensuelles, journées du vendredi au lundi midi", () => {
  const nov = journees("2026-11");
  assert.deepEqual(nov.map((j) => j.id), ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
  assert.equal(journees("2027-01").length, 5); // 5 vendredis en janvier 2027
  let c = calendrier(SAM);
  assert.equal(c.saison, "2026-11");
  assert.equal(c.etat, "journee");
  assert.equal(c.journee.n, 2);
  c = calendrier(VEN + 4 * 86400); // mardi
  assert.equal(c.etat, "pause");
  c = calendrier(Date.parse("2026-11-30T12:00:00Z") / 1000); // lundi midi de la dernière journée
  assert.equal(c.etat, "finie");
  assert.equal(calendrier(Date.parse("2026-12-03T10:00:00Z") / 1000).saison, "2026-11"); // jeudi : toujours novembre
  assert.equal(calendrier(Date.parse("2026-12-04T00:00:00Z") / 1000).saison, "2026-12");
  assert.equal(saisonPrecedente("2027-01"), "2026-12");
  assert.equal(avancee("2026-11", VEN), 1000); // la 1re journée est finie
  assert.equal(avancee("2026-11", Date.parse("2026-12-01T00:00:00Z") / 1000), 4000);
});

test("clubs du jeu : calcul identique au jeu", () => {
  assert.equal(fnv(""), 0x811c9dc5);
  assert.equal(fnv("a"), 0xe40c292c);
  // Valeurs reprises dans tests/test_ligue.gd du jeu : les deux doivent rester égales.
  assert.equal(fnv("2026-11|5|0|3"), 317649862);
  const b = bot("2026-11", 5, 0, 3);
  assert.deepEqual([b.nom, b.couleurs, b.force], [[14, 2], [6, 4], 869]);
  assert.equal(pointsBot(b, "2026-11", SAM), Math.floor((869 * 12 * 1285) / 1_000_000));
  assert.equal(pointsDuel(1, true), 4);
  assert.equal(pointsDuel(0, false), 2);
  assert.equal(pointsDuel(-1, false), 1);
  assert.equal(mouvement(5, 1), 1);
  assert.equal(mouvement(1, 1), 0);
  assert.equal(mouvement(3, 9), -1);
  assert.equal(mouvement(DIVISIONS, 10), 0);
});

test("inscription : division 5, poule complétée par des clubs du jeu", async () => {
  const { l, h } = await preparer();
  const r = ins(l, h, 0);
  assert.equal(r.statut, 200);
  assert.equal(r.corps.moi.division, DIVISIONS);
  const p = l.poule("2026-11", DIVISIONS, 0, SAM);
  assert.equal(p.clubs.length, TAILLE_POULE);
  assert.equal(p.clubs.filter((x) => x.bot).length, TAILLE_POULE - 1);
  assert.equal(l.inscrire({ id: ids[0], nom: ["x", 1], couleurs: [0, 7] }, { hash: h[0], maintenantS: SAM }).statut, 400);
  assert.equal(l.inscrire({ id: ids[0], nom: [0, 1], couleurs: [0, 7] }, { hash: h[1], maintenantS: SAM }).statut, 403);
  assert.equal(l.inscrire({ id: ids[0], nom: [0, 1], couleurs: [0, 7], saison: "2026-10" }, { hash: h[0], maintenantS: SAM }).corps.erreur, "autre_saison");
});

test("duel en ligne : compte quand les deux résultats concordent", async () => {
  const { l, h } = await preparer();
  ins(l, h, 0);
  ins(l, h, 1);
  const a = res(l, h, 0, ids[1], code(1), true, SAM, { direct: true });
  assert.equal(a.corps.etat, "attente");
  assert.equal(l.club(ids[0], "2026-11", SAM).points, 0);
  const b = res(l, h, 1, ids[0], code(1), false, SAM + 5);
  assert.equal(b.corps.etat, "compte");
  assert.equal(b.corps.pts, 1); // défaite
  assert.equal(l.club(ids[0], "2026-11", SAM + 5).points, 4); // victoire + direct
  assert.equal(l.club(ids[0], "2026-11", SAM + 5).comptes[code(1)], 4);
  // Renvoi du même résultat : rien ne change.
  assert.equal(res(l, h, 0, ids[1], code(1), true, SAM + 60).corps.etat, "compte");
  assert.equal(l.club(ids[0], "2026-11", SAM + 60).points, 4);
  // Nul : deux perdants.
  res(l, h, 0, ids[1], code(2), false, SAM + 100);
  assert.equal(res(l, h, 1, ids[0], code(2), false, SAM + 100).corps.pts, 2);
  // Désaccord : les deux disent avoir gagné, personne ne marque.
  res(l, h, 0, ids[1], code(3), true, SAM + 200);
  assert.equal(res(l, h, 1, ids[0], code(3), true, SAM + 200).corps.etat, "refuse");
  assert.equal(l.club(ids[1], "2026-11", SAM + 200).points, 1 + 2);
  // 3e duel contre le même adversaire dans la journée : refusé (2 au plus).
  res(l, h, 0, ids[1], code(4), true, SAM + 300);
  assert.equal(res(l, h, 1, ids[0], code(4), false, SAM + 300).corps.etat, "refuse");
});

test("clubs du jeu : 3 par journée, places vides seulement, 6 duels au plus", async () => {
  const { l, h } = await preparer();
  ins(l, h, 0);
  assert.equal(res(l, h, 0, "bot:9", code(1), true, SAM).corps.erreur, "adversaire_invalide"); // 9 clubs du jeu : bot:0 à bot:8
  let s = SAM;
  for (let k = 0; k < BOTS_JOURNEE; k++) assert.equal(res(l, h, 0, `bot:${k}`, code(10 + k), true, (s += 30)).corps.pts, 3);
  assert.equal(res(l, h, 0, "bot:5", code(20), true, (s += 30)).corps.etat, "refuse");
  assert.equal(res(l, h, 0, "bot:6", code(21), true, s + 1).statut, 429); // trop vite
  ins(l, h, 1);
  ins(l, h, 2);
  for (let n = 0; n < DUELS_JOURNEE + 1; n++) {
    const adv = 1 + (n % 2);
    res(l, h, 0, ids[adv], code(100 + n), true, (s += 30));
    res(l, h, adv, ids[0], code(100 + n), false, s);
  }
  // 3 clubs du jeu + 3 duels en ligne : 6 au plus dans la journée.
  const moi = l.club(ids[0], "2026-11", s);
  assert.equal(Object.values(moi.comptes).filter((p) => p > 0).length, DUELS_JOURNEE);
  // Hors journée (mardi) : refusé. Une autre journée : les compteurs repartent.
  assert.equal(res(l, h, 0, "bot:5", code(23), true, VEN + 5 * 86400).corps.erreur, "pas_de_journee");
  assert.equal(res(l, h, 0, "bot:5", code(22), true, VEN + 7 * 86400 + 3600).corps.pts, 3);
});

test("fin de saison : montée des 2 premiers, la saison suivante part de la nouvelle division", async () => {
  const { l, h } = await preparer();
  ins(l, h, 0);
  ins(l, h, 1);
  let s = SAM;
  for (let k = 0; k < DUELS_JOURNEE; k++) {
    res(l, h, 0, ids[1], code(k), true, (s += 30), { direct: true });
    res(l, h, 1, ids[0], code(k), false, s);
  }
  // Beaucoup de points pour A sur plusieurs journées.
  for (const j of journees("2026-11").slice(2)) {
    for (let k = 0; k < BOTS_JOURNEE; k++) res(l, h, 0, `bot:${k}`, code(Number(j.debut) + k), true, j.debut + 100 + 30 * k, { direct: true });
    for (let k = 0; k < 2; k++) {
      res(l, h, 0, ids[1], code(Number(j.debut) + 50 + k), true, j.debut + 500 + 30 * k, { direct: true });
      res(l, h, 1, ids[0], code(Number(j.debut) + 50 + k), false, j.debut + 500 + 30 * k);
    }
  }
  const fin = Date.parse("2026-12-02T00:00:00Z") / 1000;
  const a = l.club(ids[0], "2026-11", fin);
  assert.equal(a.finie, true);
  assert.equal(a.rang, 1);
  assert.equal(a.mouvement, 1);
  const dec = Date.parse("2026-12-05T10:00:00Z") / 1000;
  assert.equal(ins(l, h, 0, dec).corps.moi.division, DIVISIONS - 1);
  assert.equal(ins(l, h, 3, dec).corps.moi.division, DIVISIONS); // nouveau
  l.nettoyer(Date.parse("2027-05-01T00:00:00Z") / 1000);
  assert.equal(l.club(ids[0], "2026-11", dec), null);
});
