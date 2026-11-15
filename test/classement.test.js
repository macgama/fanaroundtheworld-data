import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Classement, semaineIso, regrouper, verifierEnvoi, empreinte, MAX_PAR_JOUR_EQUIPE, DELAI_ENVOI_S } from "../src/classement.js";

// node:sqlite imite ctx.storage.sql.exec du Durable Object.
function base() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (q, ...v) => { const rows = db.prepare(q).all(...v); return { toArray: () => rows }; } };
  return new Classement(sql);
}

const T = Date.parse("2026-11-18T12:00:00Z") / 1000; // mercredi, semaine 47
const ID_A = "a".repeat(16);
const ID_B = "b".repeat(16);
const CLE_A = "1".repeat(32);
const CLE_B = "2".repeat(32);

function envoi(id, cle, points, extra = {}) {
  return { v: 1, id, cle, pseudo: [3, 7, 42], points, ...extra };
}
const ligne = (equipe, points, raison = "duel", t = T - 60) => ({ equipe, points, raison, t });

async function envoyer(c, id, cle, points, maintenantS = T, extra = {}) {
  return c.envoyer(envoi(id, cle, points, extra), { hash: await empreinte(cle), ip: "ip1", maintenantS });
}

test("semaine ISO", () => {
  assert.equal(semaineIso(T), "2026-W47");
  assert.equal(semaineIso(Date.parse("2026-11-15T23:59:00Z") / 1000), "2026-W46"); // dimanche
  assert.equal(semaineIso(Date.parse("2026-11-16T00:00:00Z") / 1000), "2026-W47"); // lundi
  assert.equal(semaineIso(Date.parse("2024-12-30T10:00:00Z") / 1000), "2025-W01");
});

test("forme des envois", () => {
  assert.equal(verifierEnvoi(envoi(ID_A, CLE_A, [])), null);
  assert.equal(verifierEnvoi(envoi("xyz", CLE_A, [])), "identite_invalide");
  assert.equal(verifierEnvoi(envoi(ID_A, CLE_A, [], { pseudo: ["Gros mot", 1, 2] })), "pseudo_invalide");
  assert.equal(verifierEnvoi(envoi(ID_A, CLE_A, [], { pseudo: [1, 2, 100] })), "pseudo_invalide");
  assert.equal(verifierEnvoi(envoi(ID_A, CLE_A, "x")), "points_invalides");
});

test("barème : lignes hors règles refusées", () => {
  const { groupes, refuses } = regrouper(
    [
      ligne("af:85", 20),
      ligne("af:85", 10, "suivi"),
      ligne("af:85", 31), // duel max 30
      ligne("af:85", 5, "triche"),
      ligne("<script>", 5),
      ligne("nation:france", 7, "prono"),
      ligne("af:85", 5, "duel", T - 9 * 86400), // trop vieux
      ligne("af:85", 5, "duel", T + 3600), // dans le futur
      ligne("af:85", 2.5),
    ],
    T,
  );
  assert.equal(refuses, 6);
  assert.equal(groupes.get("2026-11-18|af:85"), 30);
  assert.equal(groupes.get("2026-11-18|nation:france"), 7);
});

test("envoi : points comptés, rang, équipes", async () => {
  const c = base();
  const r = await envoyer(c, ID_A, CLE_A, [ligne("af:85", 20), ligne("af:85", 10, "suivi"), ligne("nation:france", 7, "prono")]);
  assert.equal(r.statut, 200);
  assert.deepEqual(r.corps.acceptes, { "af:85": 30, "nation:france": 7 });
  assert.equal(r.corps.moi.points_semaine, 37);
  assert.equal(r.corps.moi.rang_semaine, 1);
  assert.equal(r.corps.moi.equipe, "af:85");
  assert.deepEqual(r.corps.moi.pseudo, [3, 7, 42]);

  await envoyer(c, ID_B, CLE_B, [ligne("af:85", 30), ligne("af:85", 30), ligne("af:81", 5)]);
  const eq = c.equipes(T + 120).equipes; // après le cache d'une minute
  assert.deepEqual(eq["af:85"], { p: 90, s: 90, f: 2 });
  assert.deepEqual(eq["af:81"], { p: 5, s: 5, f: 1 });

  const top = c.fans("semaine", T + 120).fans;
  assert.equal(top.length, 2);
  assert.equal(top[0].id, ID_B);
  assert.equal(top[0].points, 65);
  assert.equal(top[1].rang, 2);
  assert.equal(c.fan(ID_A, T).rang_semaine, 2);
});

test("clé secrète : personne ne peut envoyer à la place d'un autre", async () => {
  const c = base();
  await envoyer(c, ID_A, CLE_A, [ligne("af:85", 10)]);
  const r = await envoyer(c, ID_A, CLE_B, [ligne("af:85", 10)], T + 60);
  assert.equal(r.statut, 403);
  assert.equal(c.fan(ID_A, T).points_total, 10);
});

test("un envoi toutes les 20 secondes au plus", async () => {
  const c = base();
  await envoyer(c, ID_A, CLE_A, [ligne("af:85", 10)]);
  const r = await envoyer(c, ID_A, CLE_A, [ligne("af:85", 10)], T + 5);
  assert.equal(r.statut, 429);
  assert.equal(r.corps.attendre, DELAI_ENVOI_S - 5);
  assert.equal((await envoyer(c, ID_A, CLE_A, [ligne("af:85", 10)], T + DELAI_ENVOI_S)).statut, 200);
});

test("plafond de 200 points par équipe et par jour, même en plusieurs envois", async () => {
  const c = base();
  const beaucoup = Array.from({ length: 8 }, () => ligne("af:85", 30)); // 240
  const r1 = await envoyer(c, ID_A, CLE_A, beaucoup);
  assert.equal(r1.corps.acceptes["af:85"], MAX_PAR_JOUR_EQUIPE);
  assert.equal(r1.corps.refuses, 40);
  const r2 = await envoyer(c, ID_A, CLE_A, [ligne("af:85", 30, "duel", T + 30)], T + 60);
  assert.deepEqual(r2.corps.acceptes, {});
  // Le lendemain, ça repart.
  const r3 = await envoyer(c, ID_A, CLE_A, [ligne("af:85", 30, "duel", T + 86400)], T + 86400 + 10);
  assert.equal(r3.corps.acceptes["af:85"], 30);
});

test("plafond de 1000 points par fan et par jour, toutes équipes", async () => {
  const c = base();
  const lignes = [];
  for (let e = 0; e < 7; e++) for (let i = 0; i < 7; i++) lignes.push(ligne(`af:${e}`, 30)); // 7 × 200 = 1400
  const r = await envoyer(c, ID_A, CLE_A, lignes);
  assert.equal(c.fan(ID_A, T).points_total, 1000);
  assert.equal(r.corps.refuses, 470);
});

test("nouvelle semaine : points de la semaine remis à zéro, total gardé", async () => {
  const c = base();
  await envoyer(c, ID_A, CLE_A, [ligne("af:85", 20)]);
  const lundi = Date.parse("2026-11-23T08:00:00Z") / 1000;
  assert.equal(c.fan(ID_A, lundi).points_semaine, 0);
  assert.equal(c.fan(ID_A, lundi).rang_semaine, null);
  assert.equal(c.equipes(lundi).equipes["af:85"].s, 0);
  await envoyer(c, ID_A, CLE_A, [ligne("af:85", 10, "duel", lundi - 10)], lundi);
  const f = c.fan(ID_A, lundi);
  assert.equal(f.points_semaine, 10);
  assert.equal(f.points_total, 30);
  assert.equal(c.fans("total", lundi).fans[0].points, 30);
});

test("fan caché : absent du top, ses points comptent pour l'équipe", async () => {
  const c = base();
  await envoyer(c, ID_A, CLE_A, [ligne("af:85", 20)], T, { visible: false });
  assert.equal(c.fans("semaine", T).fans.length, 0);
  assert.equal(c.equipes(T).equipes["af:85"].p, 20);
});

test("10 nouveaux fans par adresse et par jour au plus", async () => {
  const c = base();
  for (let i = 0; i < 10; i++) {
    const id = i.toString(16).padStart(16, "0");
    assert.equal((await envoyer(c, id, CLE_A, [])).statut, 200);
  }
  const r = await envoyer(c, "f".repeat(16), CLE_A, []);
  assert.equal(r.statut, 429);
  assert.equal(r.corps.erreur, "trop_de_fans");
});

test("ménage des compteurs journaliers", async () => {
  const c = base();
  await envoyer(c, ID_A, CLE_A, [ligne("af:85", 20)]);
  c.nettoyer(T + 20 * 86400);
  assert.equal(c.sql.exec("SELECT COUNT(*) AS n FROM jour").toArray()[0].n, 0);
  assert.equal(c.fan(ID_A, T).points_total, 20);
});
