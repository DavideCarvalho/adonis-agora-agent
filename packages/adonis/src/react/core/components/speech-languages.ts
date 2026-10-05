/**
 * Languages the dictation mic offers. The Web Speech API expects a
 * BCP-47 tag and does NOT auto-detect — the engine forces incoming
 * audio onto the phonemes of whatever `recognition.lang` is set to, so
 * the host app picks the locale explicitly.
 */
export interface SpeechLanguage {
  /** BCP-47 tag fed straight into `SpeechRecognition.lang`. */
  tag: string;
  /** Human label for a dropdown. */
  label: string;
}

export const DEFAULT_SPEECH_LANG = 'en-US';

export const SPEECH_LANGUAGES: ReadonlyArray<SpeechLanguage> = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  { tag: 'es-ES', label: 'Spanish (Spain)' },
];

const STORAGE_KEY = 'nestjs-agent-chat-speech-lang';

/**
 * Recover the last picked language from localStorage (sync — safe at
 * `useState` init). Falls back to the default if nothing's stored or the
 * stored tag isn't in the offered list.
 */
export function loadStoredSpeechLang(): string {
  if (typeof window === 'undefined') return DEFAULT_SPEECH_LANG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && SPEECH_LANGUAGES.some((language) => language.tag === raw)) {
      return raw;
    }
  } catch {
    /* localStorage disabled (private window / webview) — use the default */
  }
  return DEFAULT_SPEECH_LANG;
}

export function persistSpeechLang(tag: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, tag);
  } catch {
    /* same fallback — silently skip persistence */
  }
}
