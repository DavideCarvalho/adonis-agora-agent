import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Minimal subset of the Web Speech API we use. The real types live
 * behind `webkit*` prefixes in some browsers and aren't in TS lib.dom,
 * so we declare just what we need.
 */
interface SpeechResultAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechResultAlternative;
  [index: number]: SpeechResultAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}
interface SpeechRecognitionErrorEvent {
  error: string;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface UseSpeechRecognitionOptions {
  lang?: string;
  onFinalTranscript: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
}

export interface SpeechRecognitionHook {
  isSupported: boolean;
  isListening: boolean;
  start(): void;
  stop(): void;
}

/**
 * Tiny wrapper around the Web Speech API. `start()` opens the mic and
 * streams interim transcripts via `onInterimTranscript`; on a finalized
 * chunk it fires `onFinalTranscript`. `isSupported` is false where the
 * API is missing (e.g. Firefox) — callers should hide the mic button.
 */
export function useSpeechRecognition({
  lang = 'en-US',
  onFinalTranscript,
  onInterimTranscript,
}: UseSpeechRecognitionOptions): SpeechRecognitionHook {
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [isListening, setIsListening] = useState(false);

  const ctor = useMemo(() => getRecognitionCtor(), []);
  const isSupported = ctor !== null;

  // Keep latest callbacks in refs so we don't tear down the recognition
  // object when they change identity each render.
  const finalRef = useRef(onFinalTranscript);
  const interimRef = useRef(onInterimTranscript);
  finalRef.current = onFinalTranscript;
  interimRef.current = onInterimTranscript;

  useEffect(() => {
    if (!ctor) return;
    const recognition = new ctor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalRef.current(text);
        } else {
          interim += text;
        }
      }
      if (interim && interimRef.current) interimRef.current(interim);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('SpeechRecognition error', event.error);
      }
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.stop();
      } catch {
        /* engine already stopped */
      }
      recognitionRef.current = null;
    };
  }, [ctor, lang]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.start();
      setIsListening(true);
    } catch (error) {
      console.warn('SpeechRecognition start failed', error);
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  return { isSupported, isListening, start, stop };
}
