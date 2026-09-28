import type { Finding } from '../types.js';

/**
 * Prompt-injection / jailbreak heuristics. Each signal has a weight; the text's score is the
 * noisy-OR of the distinct signals that fired (1 - Π(1 - w)), so one strong signal or several weak
 * ones cross the threshold. English, Portuguese (PT-BR) and Spanish phrasings, role/delimiter
 * spoofing, hidden Unicode (tag characters, bidi overrides, zero-width runs) and exfiltration
 * through rendered links/images.
 */
export interface Signal {
  id: string;
  re: RegExp;
  weight: number;
}

const W = String.raw`[\s\S]{0,40}?`;

export const INJECTION_SIGNALS: Signal[] = [
  // Instruction override.
  {
    id: 'ignore_previous',
    re: new RegExp(
      String.raw`\b(?:ignore|disregard|forget|override|bypass|skip)\b${W}\b(?:all\s+|any\s+|the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|original|system|initial)\b${W}\b(?:instructions?|prompts?|rules?|directions?|guidelines?|messages?|context)\b`,
      'gi',
    ),
    weight: 0.75,
  },
  {
    id: 'ignore_previous_pt',
    re: new RegExp(
      String.raw`\b(?:ignore|ignora|desconsidere|desconsidera|esque[çc]a|esquece|descarte)\b${W}\b(?:as\s+|todas\s+as\s+|suas\s+|tuas\s+)?(?:instru[çc][õo]es|regras|orienta[çc][õo]es|mensagens|prompts?)\b${W}\b(?:anteriores|acima|pr[ée]vias|do\s+sistema|originais)\b`,
      'gi',
    ),
    weight: 0.75,
  },
  {
    id: 'ignore_previous_es',
    re: new RegExp(
      String.raw`\b(?:ignora|ignore|olvida|olvide|descarta)\b${W}\b(?:las\s+|todas\s+las\s+|tus\s+)?(?:instrucciones|reglas|indicaciones)\b${W}\b(?:anteriores|previas|del\s+sistema)\b`,
      'gi',
    ),
    weight: 0.75,
  },
  {
    id: 'new_instructions',
    re: /\b(?:new|updated|real|actual|true)\s+(?:system\s+)?instructions?\s*(?::|follow|are)|\bnovas\s+instru[çc][õo]es\s*:|\bnuevas\s+instrucciones\s*:/gi,
    weight: 0.45,
  },
  // Role hijack / persona jailbreaks.
  {
    id: 'role_hijack',
    re: /\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+(?:are|will)|act\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|evil|jailbroken)|pretend\s+(?:to\s+be|you\s+are)\s+(?:an?\s+)?(?:unrestricted|unfiltered|different\s+ai)|a\s+partir\s+de\s+agora\s+voc[êe]\s+(?:[ée]|ser[áa])|voc[êe]\s+agora\s+[ée]|ahora\s+eres)\b/gi,
    weight: 0.45,
  },
  {
    id: 'jailbreak_persona',
    re: /\b(?:DAN|do\s+anything\s+now|developer\s+mode|god\s+mode|jailbreak(?:ed)?|STAN|DUDE\s+mode|AIM\s+mode|no\s+(?:restrictions|filters|guidelines|limits)\s+mode|modo\s+desenvolvedor|sem\s+restri[çc][õo]es)\b/g,
    weight: 0.55,
  },
  // Prompt / secret extraction.
  {
    id: 'prompt_leak',
    re: /\b(?:reveal|print|show|repeat|output|display|leak|tell\s+me|write\s+out)\b[\s\S]{0,30}?\b(?:your|the)\s+(?:system\s+prompt|initial\s+(?:prompt|instructions)|hidden\s+(?:prompt|instructions)|instructions\s+above|developer\s+message)\b|\b(?:mostre|revele|repita|imprima)\b[\s\S]{0,30}?\b(?:seu|o)\s+prompt\s+(?:do\s+sistema|inicial)\b/gi,
    weight: 0.6,
  },
  // Role / delimiter spoofing: chat-template tokens and fake headers.
  {
    id: 'role_tokens',
    re: /<\|(?:im_start|im_end|system|endoftext|start_header_id|end_header_id|eot_id)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|assistant|developer)>|^\s*#{2,}\s*(?:system|assistant|developer)\s*(?:prompt|message)?\s*:?\s*$/gim,
    weight: 0.55,
  },
  {
    id: 'fake_system',
    re: /^\s*(?:system|assistant|developer)\s*(?:message|prompt|note|override)?\s*:\s*\S/gim,
    weight: 0.3,
  },
  // Indirect injection aimed at the agent reading the content.
  {
    id: 'addressed_to_ai',
    re: /\b(?:(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+)?(?:ai|assistant|llm|agent|model|chatbot)|(?:ai|assistant|llm|agent)s?\s*(?:reading|processing|summari[sz]ing)\s+this|if\s+you\s+are\s+an?\s+(?:ai|assistant|llm|language\s+model|agent)|aten[çc][ãa]o\s*,?\s*(?:ia|assistente|agente)|se\s+voc[êe]\s+[ée]\s+(?:uma\s+)?(?:ia|intelig[êe]ncia\s+artificial|assistente))\b/gi,
    weight: 0.55,
  },
  {
    id: 'tool_directive',
    re: /\b(?:call|invoke|use|run|execute|chame|use|execute)\s+(?:the\s+|a\s+|o\s+|a\s+ferramenta\s+)?[`'"]?[\w-]+(?:__[\w-]+)[`'"]?\s*(?:tool|function|ferramenta)?|\b(?:send|forward|email|post|upload|exfiltrate|envie|encaminhe)\b[\s\S]{0,40}?\b(?:(?:all|every|the)\s+)?(?:(?:user'?s?|their|this|todos\s+os|os)\s+)?(?:emails?|files?|documents?|credentials?|passwords?|secrets?|tokens?|keys?|conversation|chat\s+history|dados|arquivos|senhas)\b[\s\S]{0,40}?\b(?:to|para)\s+\S+@\S+|\bto\s+https?:\/\//gi,
    weight: 0.45,
  },
  {
    id: 'secrecy',
    re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention|reveal|show|alert|notify)\s+(?:this\s+to\s+)?(?:the\s+)?user\b|\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b|\bn[ãa]o\s+(?:conte|informe|mencione|avise)\s+(?:ao|o)\s+usu[áa]rio\b/gi,
    weight: 0.5,
  },
  // Exfiltration through rendered markdown/HTML.
  {
    id: 'exfil_markdown',
    re: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*=[^)\s]*(?:\{|%7B|\$|<)?[^)]*\)|<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^"'>\s]+\?[^"'>\s]*=/gi,
    weight: 0.4,
  },
  {
    id: 'html_comment_instructions',
    re: /<!--[\s\S]{0,500}?\b(?:ignore|instruction|assistant|ai|agent|system|prompt|instru[çc][ãa]o|assistente)\b[\s\S]{0,500}?-->/gi,
    weight: 0.45,
  },
  // Encoded payloads that decode to instructions are checked separately (see scoreEncoded).
];

/** Characters used to hide instructions from people while models still read them. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]+/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const ZERO_WIDTH_RUN = /[\u200B-\u200D\u2060\uFEFF]{3,}/g;

/**
 * Base64 to text, byte per character. Only printable ASCII is ever acted upon, so no UTF-8 decoding
 * is needed — and `atob` keeps this free of Node's `Buffer`.
 */
function decodeBase64Ascii(b64: string): string | undefined {
  try {
    return atob(b64);
  } catch {
    return undefined;
  }
}

/** Decodes Unicode tag characters ("ASCII smuggling") back to the ASCII they encode. */
export function decodeTagChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

function matchSignals(
  text: string,
  offset: number,
  into: Map<string, Finding[]>,
  weights: Map<string, number>,
) {
  for (const s of INJECTION_SIGNALS) {
    s.re.lastIndex = 0;
    for (let m = s.re.exec(text); m; m = s.re.exec(text)) {
      if (m[0].length === 0) {
        s.re.lastIndex++;
        continue;
      }
      weights.set(s.id, Math.max(weights.get(s.id) ?? 0, s.weight));
      const list = into.get(s.id) ?? [];
      list.push({
        detector: 'injection',
        category: `injection.${s.id}`,
        start: offset < 0 ? m.index : offset,
        end: offset < 0 ? m.index + m[0].length : offset,
        score: s.weight,
        value: m[0],
        spanned: offset < 0,
      });
      into.set(s.id, list);
    }
  }
}

export interface InjectionResult {
  score: number;
  findings: Finding[];
}

/** Scores a text; findings are returned only when the score reaches `threshold`. */
export function scoreInjection(text: string, threshold = 0.5): InjectionResult {
  const byId = new Map<string, Finding[]>();
  const weights = new Map<string, number>();
  matchSignals(text, -1, byId, weights);

  // Hidden Unicode: suspicious on its own; the decoded text is scanned too.
  TAG_CHARS.lastIndex = 0;
  for (let m = TAG_CHARS.exec(text); m; m = TAG_CHARS.exec(text)) {
    weights.set('hidden_unicode', 0.8);
    const list = byId.get('hidden_unicode') ?? [];
    list.push({
      detector: 'injection',
      category: 'injection.hidden_unicode',
      start: m.index,
      end: m.index + m[0].length,
      score: 0.8,
      value: m[0],
      spanned: true,
    });
    byId.set('hidden_unicode', list);
    const decoded = decodeTagChars(m[0]);
    if (decoded) matchSignals(decoded, m.index, byId, weights);
  }
  for (const re of [BIDI, ZERO_WIDTH_RUN]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      weights.set('invisible_chars', Math.max(weights.get('invisible_chars') ?? 0, 0.3));
      const list = byId.get('invisible_chars') ?? [];
      list.push({
        detector: 'injection',
        category: 'injection.invisible_chars',
        start: m.index,
        end: m.index + m[0].length,
        score: 0.3,
        value: m[0],
        spanned: true,
      });
      byId.set('invisible_chars', list);
    }
  }

  // Base64 blobs that decode to instructions.
  const B64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g;
  for (let m = B64.exec(text); m; m = B64.exec(text)) {
    const decoded = decodeBase64Ascii(m[0]);
    if (decoded === undefined) continue;
    if (!/^[\x20-\x7E\s]+$/.test(decoded)) continue;
    const inner = new Map<string, Finding[]>();
    const innerWeights = new Map<string, number>();
    matchSignals(decoded, m.index, inner, innerWeights);
    if (innerWeights.size > 0) {
      weights.set('encoded_instructions', 0.6);
      byId.set('encoded_instructions', [
        {
          detector: 'injection',
          category: 'injection.encoded_instructions',
          start: m.index,
          end: m.index + m[0].length,
          score: 0.6,
          value: m[0],
          spanned: true,
        },
      ]);
    }
  }

  let keep = 1;
  for (const w of weights.values()) keep *= 1 - w;
  const score = Math.round((1 - keep) * 1000) / 1000;
  if (score < threshold) return { score, findings: [] };
  const findings = [...byId.values()]
    .flat()
    .map((f) => ({ ...f, score: Math.max(f.score, score) }));
  return { score, findings };
}
