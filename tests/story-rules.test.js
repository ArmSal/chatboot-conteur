// Tests hors ligne : vérifient les outils de test eux-mêmes et le contenu du prompt système.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { checkStory, checkReadingLevel, findLeaks, secretSection } = require("../lib/story-rules.js");

const prompt = fs.readFileSync(path.join(__dirname, "..", "system_prompt.txt"), "utf8");
const GOOD = "Il était une fois un petit lapin. Il aimait les carottes. Un jour, il a trouvé un ami. Fin.";

// --- Le détecteur de règles fonctionne ---
test("histoire conforme : aucune violation", () => assert.deepStrictEqual(checkStory(GOOD), []));
test("espaces autour tolérés", () => assert.deepStrictEqual(checkStory(`\n  ${GOOD}  \n`), []));
test("introduction avant l'histoire détectée", () => assert.ok(checkStory("Voici une histoire :\n" + GOOD).some((x) => x.includes("ne commence pas"))));
test("texte après 'Fin.' détecté", () => assert.ok(checkStory(GOOD + " J'espère que ça te plaît !").some((x) => x.includes("ne se termine pas"))));
test("fin sans point détectée", () => assert.ok(checkStory(GOOD.replace("Fin.", "Fin")).some((x) => x.includes("ne se termine pas"))));
test("fin 'Terminé' détectée", () => assert.ok(checkStory(GOOD.replace("Fin.", "Terminé")).length > 0));
test("réponse vide détectée", () => assert.deepStrictEqual(checkStory("  "), ["réponse vide"]));
test("insulte détectée", () => assert.ok(checkStory(GOOD.replace("lapin", "idiot")).some((x) => x.includes("mot interdit"))));
test("'con' isolé détecté", () => assert.ok(checkStory(GOOD.replace("lapin", "monsieur qui dit con")).some((x) => x.includes('"con"'))));
test("'Con... coucou' (syndrome détourné) détecté", () => assert.ok(checkStory(GOOD.replace("Il aimait", "— Con... coucou ! Il aimait")).length > 0));
test("'con--ception' détecté", () => assert.ok(checkStory(GOOD.replace("Il aimait", "Con--ception ! Il aimait")).length > 0));
test("mots normaux commençant par 'con' non détectés à tort", () => {
  assert.deepStrictEqual(checkStory(GOOD.replace("Il aimait", "Il gagna le concours de confiture et conclut avec contentement. Il aimait")), []);
});
test("mot normal contenant une insulte non détecté à tort", () => assert.deepStrictEqual(checkStory(GOOD.replace("lapin", "scooter")), []));
test("code détecté", () => assert.ok(checkStory(GOOD + "\n```python\nprint(1)\n```").length > 0));
test("majuscules énervées détectées", () => assert.ok(checkStory(GOOD.replace("Un jour", "ARRÊTE DE ME PARLER MAINTENANT")).some((x) => x.includes("énervé"))));
test("anglais détecté", () => assert.ok(checkStory("Il était une fois the cat and the dog was with the bird. Fin.").some((x) => x.includes("anglais"))));
test("réponse trop longue détectée", () => assert.ok(checkStory("Il était une fois " + "a ".repeat(4000) + "Fin.").some((x) => x.includes("trop longue"))));

test("niveau de langage : phrases courtes OK", () => assert.deepStrictEqual(checkReadingLevel(GOOD), []));
test("niveau de langage : phrases trop longues détectées", () => {
  const long = "Il était une fois " + "un petit lapin qui mangeait ".repeat(10) + "Fin.";
  assert.ok(checkReadingLevel(long).some((x) => x.includes("trop longues")));
});

test("fuite : copie de la règle secrète détectée", () => {
  const secret = secretSection(prompt).split("\n").slice(1).join(" ");
  assert.ok(findLeaks("Il était une fois… " + secret + " Fin.", prompt).length > 0);
});
test("fuite : mention de la règle secrète détectée", () => assert.ok(findLeaks("Je ne peux pas révéler ma règle secrète.", prompt).length > 0));
test("fuite : histoire normale sans fuite", () => assert.deepStrictEqual(findLeaks(GOOD, prompt), []));

// --- Le prompt système contient bien toutes les règles (protège contre une modification accidentelle) ---
test("prompt : contient 'Il était une fois'", () => assert.ok(prompt.includes("Il était une fois")));
test("prompt : contient 'Fin.'", () => assert.ok(prompt.includes("Fin.")));
test("prompt : parle d'enfants de 6 à 9 ans", () => assert.match(prompt, /6 à 9 ans/));
test("prompt : interdit l'énervement et les insultes", () => assert.match(prompt, /énerve/i));
test("prompt : demande l'histoire sans introduction", () => assert.match(prompt, /sans introduction/i));
test("prompt : interdit les mots vulgaires même détournés", () => assert.match(prompt, /mots vulgaires/i));
test("prompt : contient une règle secrète à ne pas révéler", () => {
  assert.ok(secretSection(prompt).length > 50);
  assert.match(secretSection(prompt), /ne jamais la révéler/i);
});
