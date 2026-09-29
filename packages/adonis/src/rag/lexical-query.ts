/**
 * Turning a natural-language question into full-text search terms, for the lexical leg of
 * `PgLexicalVectorStore`.
 *
 * With the `simple` text-search configuration (no stemming, no stop words; any language) a question
 * searched as is either matches nothing (every word required) or, as "any word", ranks chunks full
 * of "the / of / which / de / que" first. So the query side drops the stop words of the question's
 * language(s) and keeps the meaningful terms, which the store then ranks by how many of them a chunk
 * holds, rare terms weighing more (an IDF over the matching rows, BM25-style).
 */

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/**
 * Postgres' Snowball stop word lists (`tsearch_data/{english,portuguese,spanish}.stop`), minus
 * one-letter words (never terms here) and words that carry meaning in a sibling language
 * ("estado", "sentido").
 */
export const DEFAULT_STOP_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  english: words(`
    me my myself we our ours ourselves you your yours yourself yourselves he him his himself she
    her hers herself it its itself they them their theirs themselves what which who whom this that
    these those am is are was were be been being have has had having do does did doing an the and
    but if or because as until while of at by for with about against between into through during
    before after above below to from up down in out on off over under again further then once here
    there when where why how all any both each few more most other some such no nor not only own
    same so than too very can will just don should now`),
  portuguese: words(`
    de que do da em um para com não uma os no se na por mais as dos como mas ao ele das seu sua ou
    quando muito nos já eu também só pelo pela até isso ela entre depois sem mesmo aos seus quem
    nas me esse eles você essa num nem suas meu às minha numa pelos elas qual nós lhe deles essas
    esses pelas este dele tu te vocês vos lhes meus minhas teu tua teus tuas nosso nossa nossos
    nossas dela delas esta estes estas aquele aquela aqueles aquelas isto aquilo estou está estamos
    estão estive esteve estivemos estiveram estava estávamos estavam estivera estivéramos esteja
    estejamos estejam estivesse estivéssemos estivessem estiver estivermos estiverem hei há havemos
    hão houve houvemos houveram houvera houvéramos haja hajamos hajam houvesse houvéssemos
    houvessem houver houvermos houverem houverei houverá houveremos houverão houveria houveríamos
    houveriam sou somos são era éramos eram fui foi fomos foram fora fôramos seja sejamos sejam
    fosse fôssemos fossem for formos forem serei será seremos serão seria seríamos seriam tenho tem
    temos tém tinha tínhamos tinham tive teve tivemos tiveram tivera tivéramos tenha tenhamos
    tenham tivesse tivéssemos tivessem tiver tivermos tiverem terei terá teremos terão teria
    teríamos teriam`),
  spanish: words(`
    de la que el en los del se las por un para con no una su al lo como más pero sus le ya este sí
    porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante
    todos uno les ni contra otros ese eso ante ellos esto mí antes algunos qué unos yo otro otras
    otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo
    nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía míos mías tuyo
    tuya tuyos tuyas suyo suya suyos suyas nuestro nuestra nuestros nuestras vuestro vuestra
    vuestros vuestras esos esas estoy estás está estamos estáis están esté estés estemos estéis
    estén estaré estarás estará estaremos estaréis estarán estaría estarías estaríamos estaríais
    estarían estaba estabas estábamos estabais estaban estuve estuviste estuvo estuvimos
    estuvisteis estuvieron estuviera estuvieras estuviéramos estuvierais estuvieran estuviese
    estuvieses estuviésemos estuvieseis estuviesen estando estad he has ha hemos habéis han haya
    hayas hayamos hayáis hayan habré habrás habrá habremos habréis habrán habría habrías habríamos
    habríais habrían había habías habíamos habíais habían hube hubiste hubo hubimos hubisteis
    hubieron hubiera hubieras hubiéramos hubierais hubieran hubiese hubieses hubiésemos hubieseis
    hubiesen habiendo habido habida habidos habidas soy eres es somos sois son sea seas seamos
    seáis sean seré serás será seremos seréis serán sería serías seríamos seríais serían era eras
    éramos erais eran fui fuiste fue fuimos fuisteis fueron fuera fueras fuéramos fuerais fueran
    fuese fueses fuésemos fueseis fuesen tengo tienes tiene tenemos tenéis tienen tenga tengas
    tengamos tengáis tengan tendré tendrás tendrá tendremos tendréis tendrán tendría tendrías
    tendríamos tendríais tendrían tenía tenías teníamos teníais tenían tuve tuviste tuvo tuvimos
    tuvisteis tuvieron tuviera tuvieras tuviéramos tuvierais tuvieran tuviese tuvieses tuviésemos
    tuvieseis tuviesen teniendo tenido tenida tenidos tenidas tened`),
};

const TOKEN = /[\p{L}\p{N}]{2,}/gu;

/**
 * The meaningful terms of a question, in order, deduplicated, at most `max`: the stop words of the
 * language(s) the question is written in are dropped (the language(s) with the most stop words in
 * it, so "sea"/"son" stay terms in an English question although they are Spanish stop words). A
 * question made only of stop words keeps them all (there is nothing else to search for).
 */
export function keywordTerms(
  query: string,
  max = 24,
  stopWords: Readonly<Record<string, ReadonlySet<string>>> = DEFAULT_STOP_WORDS,
): string[] {
  const tokens = [...new Set(query.toLowerCase().normalize('NFC').match(TOKEN) ?? [])];
  const counts = Object.entries(stopWords).map(
    ([, stop]) => [stop, tokens.filter((t) => stop.has(t)).length] as const,
  );
  const best = Math.max(0, ...counts.map(([, n]) => n));
  if (best === 0) return tokens.slice(0, max);
  const stop = counts.filter(([, n]) => n === best).map(([s]) => s);
  const terms = tokens.filter((t) => !stop.some((s) => s.has(t)));
  return (terms.length > 0 ? terms : tokens).slice(0, max);
}

/** Whether the user wrote search syntax (a quoted phrase, `-exclusion`) worth honoring as such. */
export function hasSearchSyntax(query: string): boolean {
  return /"[^"]+"/.test(query) || /(^|\s)-[\p{L}\p{N}]/u.test(query);
}

/** `'a' | 'b' | …` for `to_tsquery` (terms are letter/digit runs, so quoting is enough). */
export function anyTermTsquery(terms: string[]): string {
  return terms.map((t) => `'${t.replace(/'/g, '')}'`).join(' | ');
}
